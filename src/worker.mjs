import fs from 'node:fs/promises';
import path from 'node:path';
import { truncateBytes } from './util.mjs';
import { TOOL_SCHEMAS, executeTool } from './workertools.mjs';

/**
 * Worker agent loop: reasoning → toolcall → reasoning, until solved,
 * capped, finished, or pruned. Everything streams out through `emit`;
 * transcripts persist per line under the challenge workspace.
 */
export function workerSystemPrompt({ persona, strategyPrompt, digestText, flagFormat, notesPath, toolsDir, config }) {
  return [
    `You are a shingun swarm worker assigned persona "${persona}".`,
    '',
    '## Your strategy',
    strategyPrompt,
    '',
    '## Inherited context from earlier sibling workers (dead ends included — do not repeat them)',
    digestText || 'None yet — you are the first wave.',
    '',
    '## Ground rules',
    `- Work stays inside your checkout; arbitrary file reads outside it are refused.`,
    `- The shared tool cache lives at ${toolsDir} — it is shared with siblings. Install packages there (e.g. pip install --target or a venv inside it), never inside your own checkout.`,
    `- Shell commands have a ${config.worker.commandTimeoutSec}s timeout and output cap; plan accordingly (write to files, then read slices).`,
    `- The challenge network is reachable — remote CTF services, wordlists, docs are fair game.`,
    `- Append discoveries for later siblings by running a command like:`,
    `  printf '%s' ${JSON.stringify({ workerId: 'YOUR_ID', finding: 'YOUR_FINDING', tag: 'info' }).replace(/\n/g, '')} >> ${notesPath}`,
    `- Flag format (advisory): ${flagFormat ?? 'unknown — infer from challenge files'}`,
    '- When you find the flag, call submit_flag with your reasoning. If the approach is exhausted, call finish with your findings.',
    '- Solve it. Do not summarize what you would do — do it.'
  ].join('\n');
}

export async function runWorker({
  workerId,
  swarmId,
  challengeId,
  persona,
  strategyPrompt,
  digestText,
  flagFormat,
  dirs, // { worktree, scratch, tools, notes, transcript }
  provider,
  budgetGuard,
  config,
  emit,        // (type, data) → orchestrator store + bus
  steer,       // { drain(): string[] }
  isCancelled, // () => boolean
  hooks        // { jail, runner, submitFlag(args), finish(args) }
}) {
  const caps = config.worker;
  const startedAt = Date.now();
  const price = provider.price;

  const messages = [{
    role: 'user',
    content: workerSystemPrompt({ persona, strategyPrompt, digestText, flagFormat, notesPath: dirs.notes, toolsDir: dirs.tools, config })
  }];

  await fs.mkdir(path.dirname(dirs.transcript), { recursive: true });
  const writeTranscript = async (msg) =>
    fs.appendFile(dirs.transcript, JSON.stringify(msg) + '\n', 'utf8').catch(() => {});

  let steps = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let proseStrikes = 0;
  const scopeIds = [`worker:${workerId}`, `challenge:${challengeId}`, `swarm:${swarmId}`];
  budgetGuard.addScope(`worker:${workerId}`, { tokenCap: caps.maxTokens });

  const status = (s, reason) => emit('worker.status', { status: s, reason });
  const progress = () => emit('worker.progress', { steps, tokensIn, tokensOut, seenAt: Date.now() });

  emit('worker.spawn', { persona, strategySummary: truncateBytes(strategyPrompt, 400).text });
  status('reasoning');

  while (true) {
    if (isCancelled()) { status('finished', 'swarm stopping'); return { outcome: 'stopped' }; }
    if (steps >= caps.maxSteps) { status('capped', 'maxSteps'); return { outcome: 'capped', reason: 'maxSteps' }; }
    if (Date.now() - startedAt > caps.wallClockMin * 60_000) { status('capped', 'wallClock'); return { outcome: 'capped', reason: 'wallClock' }; }

    for (const note of steer.drain()) {
      const userMsg = { role: 'user', content: `Operator steering note: ${note}` };
      messages.push(userMsg);
      await writeTranscript(userMsg);
    }

    const estTokens = Math.ceil(messages.reduce((n, m) => n + String(m.content ?? '').length, 0) / 4);
    const pre = budgetGuard.preflight({ scopeIds, estTokens, priceIn: price.in, priceOut: price.out });
    if (!pre.ok) {
      emit('budget.capped', { scope: pre.scope, capName: pre.capName, scopeId: pre.scopeId });
      status('capped', pre.capName);
      return { outcome: 'capped', reason: pre.capName };
    }

    let res;
    try {
      res = await provider.chat({
        messages,
        tools: TOOL_SCHEMAS,
        meta: { fixture: 'worker', key: workerId, role: 'worker' }
      });
    } catch (e) {
      emit('worker.log', { stream: 'transcript', seq: messages.length, text: `provider error: ${e.message}` });
      status('finished', `provider_error:${e.code ?? 'unknown'}`);
      return { outcome: 'errored', error: e };
    }

    const rec = budgetGuard.record({ scopeIds, tokensIn: res.usage.tokensIn, tokensOut: res.usage.tokensOut, priceIn: price.in, priceOut: price.out });
    for (const c of rec.crossed ?? []) {
      emit('budget.capped', { scope: c.scopeId.split(':')[0], capName: c.capName, scopeId: c.scopeId });
    }
    tokensIn += res.usage.tokensIn;
    tokensOut += res.usage.tokensOut;
    emit('usage.tick', {
      role: 'worker', provider: provider.name ?? 'unknown',
      tokensIn: res.usage.tokensIn, tokensOut: res.usage.tokensOut,
      costUsd: (res.usage.tokensIn / 1e6) * price.in + (res.usage.tokensOut / 1e6) * price.out,
      workerId
    });

    const msg = res.message;
    await writeTranscript(msg);
    messages.push(msg);

    if (msg.tool_calls?.length) {
      status('toolcall');
      let solved = null;
      let finished = null;
      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments ?? '{}'); } catch { /* empty args */ }
        const result = await executeTool({
          name: call.function?.name,
          args,
          ctx: {
            config,
            jail: hooks.jail,
            runner: hooks.runner,
            worktreePath: dirs.worktree,
            hooks: {
              submitFlag: (a) => { solved = a; return { accepted: true, formatMatch: 'pending' }; },
              finish: (a) => { finished = a; return { ok: true }; }
            }
          }
        });
        if (['run_shell', 'read_file', 'write_file'].includes(call.function?.name)) {
          emit('worker.tool', {
            name: call.function?.name,
            argsPreview: truncateBytes(JSON.stringify(args), 300).text,
            exitCode: result.exitCode ?? 0,
            durationMs: result.durationMs ?? 0,
            truncated: result.truncated ?? false
          });
        }
        const content = JSON.stringify(truncateBytes(JSON.stringify(result), config.worker.commandOutputCap * 2).text);
        const toolMsg = { role: 'tool', tool_call_id: call.id, content };
        messages.push(toolMsg);
        await writeTranscript(toolMsg);
      }

      steps += 1;
      progress();
      status('reasoning');

      if (solved) {
        const verdict = hooks.submitFlag(solved);
        if (verdict.accepted) {
          status('solved', 'flag accepted');
          return { outcome: 'solved', flag: solved.flag, reasoning: solved.reasoning };
        }
      }
      if (finished) {
        status('finished', 'finish tool');
        return { outcome: 'finished', summary: finished };
      }
    } else if (typeof msg.content === 'string' && msg.content.trim()) {
      emit('worker.log', { stream: 'transcript', seq: messages.length, text: truncateBytes(msg.content, 4000).text });
      emit('worker.progress', { steps, tokensIn, tokensOut, seenAt: Date.now() });
      // Prose-only replies do not count as progress; nudge, then stop on repeat.
      proseStrikes += 1;
      if (proseStrikes >= 2) {
        status('finished', 'no tool progress');
        return { outcome: 'finished' };
      }
      const nudge = { role: 'user', content: 'Continue working with the tools, or call finish. Prose alone does not count as progress.' };
      messages.push(nudge);
      await writeTranscript(nudge);
      continue;
    } else {
      status('finished', 'empty reply');
      return { outcome: 'finished' };
    }
  }
}
