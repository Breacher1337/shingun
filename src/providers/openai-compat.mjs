import fs from 'node:fs/promises';
import path from 'node:path';
import { sleep, truncateBytes } from '../util.mjs';

/**
 * OpenAI-compatible chat client: the single metering choke point. Scrubs
 * text egress, retries 429/5xx with backoff, surfaces usage for the budget
 * guard.
 */
export function createOpenaiCompat({
  baseUrl,
  apiKey,
  defaultModel,
  price,
  scrubber,
  logSink,
  fetchFn = fetch,
  modelOverride,
  name,
  callTimeoutMs = 120_000,
  transcriptBodyBytes = 2048,
  retryBaseMs = 1000
}) {
  const model = () => modelOverride || defaultModel;

  async function log(entry) {
    if (!logSink) return;
    try {
      await fs.mkdir(path.dirname(logSink), { recursive: true }).catch(() => {});
      await fs.appendFile(logSink, JSON.stringify({ t: Date.now(), ...entry }) + '\n', 'utf8');
    } catch { /* logging must never fail a provider call */ }
  }

  return {
    name: name ?? 'openai-compat',
    price: price ?? { in: 0.70, out: 2.10 },
    async chat({ messages, tools, meta = {}, signal }) {
      const clean = scrubber ? scrubber.scrubMessages(messages) : messages;
      const loggedMessages = clean.map((m) => {
        const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        const chars = raw.length;
        const estTokens = Math.ceil(chars / 4);
        const trunc = truncateBytes(raw, transcriptBodyBytes);
        return {
          role: m.role,
          chars,
          estTokens,
          truncated: trunc.truncated,
          content: trunc.text,
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.tool_calls ? { toolCallsCount: m.tool_calls.length } : {})
        };
      });
      await log({ kind: 'openai-compat.outbound', model: model(), meta, messageCount: clean.length, messages: loggedMessages });
      const body = {
        model: model(),
        messages: clean,
        tool_choice: tools?.length ? 'auto' : undefined,
        tools: tools?.length ? tools : undefined
      };
      let lastErr = null;
      for (let attempt = 0; attempt <= 3; attempt++) {
        let res = null;
        lastErr = null;
        const timeoutSignal = AbortSignal.timeout(callTimeoutMs);
        let reqSignal = timeoutSignal;
        let cleanupAbort = null;
        if (signal) {
          const ac = new AbortController();
          const onAbort = () => ac.abort(signal.reason);
          const onTimeout = () => ac.abort(timeoutSignal.reason);
          if (signal.aborted) ac.abort(signal.reason);
          else if (timeoutSignal.aborted) ac.abort(timeoutSignal.reason);
          else {
            signal.addEventListener('abort', onAbort, { once: true });
            timeoutSignal.addEventListener('abort', onTimeout, { once: true });
            cleanupAbort = () => {
              signal.removeEventListener('abort', onAbort);
              timeoutSignal.removeEventListener('abort', onTimeout);
            };
          }
          reqSignal = ac.signal;
        }
        try {
          res = await fetchFn(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
            },
            body: JSON.stringify(body),
            signal: reqSignal
          });
        } catch (e) {
          if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || timeoutSignal.aborted) {
            lastErr = Object.assign(new Error(`provider call timed out after ${callTimeoutMs}ms`), { code: 'provider_timeout', cause: e });
          } else {
            lastErr = Object.assign(e, { code: 'network_error' });
          }
        } finally {
          cleanupAbort?.();
        }
        if (!lastErr) {
          if (res.ok) {
            const json = await res.json();
            const message = json.choices?.[0]?.message ?? { role: 'assistant', content: '' };
            const usage = {
              tokensIn: json.usage?.prompt_tokens ?? 0,
              tokensOut: json.usage?.completion_tokens ?? 0
            };
            await log({ kind: 'openai-compat.inbound', meta, usage, finish: json.choices?.[0]?.finish_reason });
            return { message, usage };
          }
          lastErr = Object.assign(new Error(`provider HTTP ${res.status}`), { code: 'provider_http', status: res.status });
          if (res.status === 401 || res.status === 403) {
            // Surface the why: an unauthorized call is almost always a key
            // problem, and burying it behind a bare status fails operators.
            const detail = (await res.text().catch(() => '')).slice(0, 240).replace(/\s+/g, ' ').trim();
            lastErr.message = `provider HTTP ${res.status} (${detail || 'unauthorized'} — check the API key for this provider)`;
            break;
          }
          if (res.status !== 429 && res.status < 500) break;
        }
        if (attempt < 3) await sleep(retryBaseMs * 2 ** attempt);
      }
      throw lastErr;
    }
  };
}
