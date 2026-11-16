import fs from 'node:fs/promises';
import { sleep } from '../util.mjs';

/**
 * OpenAI-compatible chat client: the single metering choke point. Scrubs
 * text egress, retries 429/5xx with backoff, surfaces usage for the budget
 * guard.
 */
export function createOpenaiCompat({ baseUrl, apiKey, defaultModel, price, scrubber, logSink, fetchFn = fetch, modelOverride, name }) {
  const model = () => modelOverride || defaultModel;

  async function log(entry) {
    if (!logSink) return;
    try {
      await fs.mkdir(new URL('.', `file://${logSink.replace(/\\/g, '/')}`).pathname, { recursive: true }).catch(() => {});
      await fs.appendFile(logSink, JSON.stringify({ t: Date.now(), ...entry }) + '\n', 'utf8');
    } catch { /* logging must never fail a provider call */ }
  }

  return {
    name: name ?? 'openai-compat',
    price: price ?? { in: 0.70, out: 2.10 },
    async chat({ messages, tools, meta = {} }) {
      const clean = scrubber ? scrubber.scrubMessages(messages) : messages;
      await log({ kind: 'openai-compat.outbound', model: model(), meta, messageCount: clean.length, messages: clean });
      const body = {
        model: model(),
        messages: clean,
        tool_choice: tools?.length ? 'auto' : undefined,
        tools: tools?.length ? tools : undefined
      };
      let lastErr = null;
      for (let attempt = 0; attempt <= 3; attempt++) {
        let res = null;
        try {
          res = await fetchFn(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
            },
            body: JSON.stringify(body)
          });
        } catch (e) {
          lastErr = Object.assign(e, { code: 'network_error' });
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
          if (res.status !== 429 && res.status < 500) break;
        }
        if (attempt < 3) await sleep(1000 * 2 ** attempt);
      }
      throw lastErr;
    }
  };
}
