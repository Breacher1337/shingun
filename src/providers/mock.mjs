import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Keyless scripted provider: responses come from fixture files so the whole
 * engine runs and tests green without any API key.
 * Fixture layout: <fixtureDir>/{triage,worker,digest,respawn,directive}.json
 * Each non-triage fixture is { steps: [...] } or a single script object;
 * worker steps are indexed per worker key; usage is reported per call.
 * When meta.slug is set (challenge basename), `${fixture}.${slug}.json`
 * takes precedence — that is how the bundled dry-run labs ship tailored
 * scripted attacks while the generic fixture keeps every other challenge
 * working offline.
 */
export function createMock({ fixtureDir, price, scrubber, logSink, name }) {
  const cache = new Map(); // fixtureName -> parsed
  const counters = new Map(); // script key -> step index

  async function load(fixtureName) {
    if (!cache.has(fixtureName)) {
      const file = path.join(fixtureDir, `${fixtureName}.json`);
      cache.set(fixtureName, JSON.parse(await fs.readFile(file, 'utf8')));
    }
    return cache.get(fixtureName);
  }

  async function log(entry) {
    if (!logSink) return;
    try {
      await fs.mkdir(path.dirname(logSink), { recursive: true });
      await fs.appendFile(logSink, JSON.stringify({ t: Date.now(), ...entry }) + '\n', 'utf8');
    } catch { /* never fail a provider call on logging */ }
  }

  function nextStep(script, key) {
    const steps = Array.isArray(script) ? script : script.steps ?? [script];
    const i = counters.get(key) ?? 0;
    counters.set(key, i + 1);
    return steps[i] ?? steps[steps.length - 1];
  }

  return {
    name: name ?? 'mock',
    price: price ?? { in: 0.70, out: 2.10 },
    async chat({ messages, tools, meta = {} }) {
      const clean = scrubber ? scrubber.scrubMessages(messages) : messages;
      await log({ kind: 'mock.outbound', meta, messageCount: (clean ?? []).length, messages: clean });
      const base = meta.fixture ?? 'worker';
      const slug = typeof meta.slug === 'string' && /^[\w.-]{1,64}$/.test(meta.slug) ? meta.slug : null;
      let fixtureName = base;
      if (slug) {
        // Challenge-tailored script when one exists; generic otherwise.
        const tailored = await fs.stat(path.join(fixtureDir, `${base}.${slug}.json`))
          .then(() => true).catch(() => false);
        if (tailored) fixtureName = `${base}.${slug}`;
      }
      const script = await load(fixtureName);
      const key = `${fixtureName}:${meta.key ?? meta.role ?? 'default'}`;
      const step = nextStep(script, key);
      const message = { role: 'assistant', content: step.content ?? null };
      if (step.tool_calls) {
        message.tool_calls = step.tool_calls.map((c, i) => ({
          id: c.id ?? `${key}-call-${i}`,
          type: 'function',
          function: {
            name: c.function.name,
            arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments)
          }
        }));
      }
      const usage = {
        tokensIn: step.usage?.prompt_tokens ?? clean.reduce((n, m) => n + Math.ceil(String(m.content ?? '').length / 4), 0),
        tokensOut: step.usage?.completion_tokens ?? 60
      };
      await log({ kind: 'mock.inbound', meta, usage });
      return { message, usage };
    }
  };
}
