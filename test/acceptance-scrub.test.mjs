import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScrubber } from '../src/scrub.mjs';
import { createMock } from '../src/providers/mock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('acceptance 5: secrets are [REDACTED] before leaving toward the provider', async () => {
  const scrubber = createScrubber(['s3cr3t-Zx9Qw7Lp2V', 'MISTRAL-KEY-abcdefgh123456']);
  const clean = scrubber.scrub('my key is s3cr3t-Zx9Qw7Lp2V and env MISTRAL-KEY-abcdefgh123456 leaks');
  assert.ok(!clean.includes('s3cr3t-Zx9Qw7Lp2V'));
  assert.ok(!clean.includes('MISTRAL-KEY-abcdefgh123456'));
  assert.ok(clean.includes('[REDACTED]'));

  // Integration: the provider client scrubs outbound message content and
  // logs the post-scrub payload (what "leaves" toward a provider).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrub-'));
  const logSink = path.join(dir, 'outbound.jsonl');
  const mock = createMock({
    fixtureDir: path.join(HERE, 'fixtures', 'mock'),
    scrubber,
    logSink
  });
  const res = await mock.chat({
    messages: [{ role: 'user', content: 'the password is s3cr3t-Zx9Qw7Lp2V' }],
    meta: { fixture: 'digest', key: 'scrub-test' }
  });
  assert.ok(res.message.content, 'mock responds');
  const logged = await fs.readFile(logSink, 'utf8');
  assert.ok(!logged.includes('s3cr3t-Zx9Qw7Lp2V'), 'no secret literal in provider-bound log');
  assert.ok(logged.includes('[REDACTED]'), 'secret was redacted, not dropped');
  fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});
