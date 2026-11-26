import fs from 'node:fs/promises';
import path from 'node:path';
import { truncateBytes } from './util.mjs';

/** Tool schemas shown to the model — exactly these five. */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Execute a shell command with cwd = your worktree. Output is capped; long-running commands are killed after the timeout.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeoutSec: { type: 'number', description: 'Optional; capped by the worker config' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 file inside your worktree or scratch dir.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'number' },
          limit: { type: 'number' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a UTF-8 file inside your worktree or scratch dir.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'submit_flag',
      description: 'Submit the flag you found. Ending: a human verifies; format match is advisory.',
      parameters: {
        type: 'object',
        properties: { flag: { type: 'string' }, reasoning: { type: 'string' } },
        required: ['flag']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Report your findings summary and stop working.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'object', description: 'Free-form findings object' } },
        required: ['summary']
      }
    }
  }
];

/** Resolve a tool path against the worktree unless absolute. */
function targetIn(ctx, p) {
  const raw = String(p ?? '');
  return path.isAbsolute(raw) ? raw : path.join(ctx.worktreePath, raw);
}

/**
 * Execute one worker tool call inside the jail. Hooks back into the
 * orchestrator handle submit_flag and finish.
 */
export async function executeTool({ name, args, ctx }) {
  try {
    switch (name) {
      case 'run_shell': {
        const timeoutSec = Math.min(Number(args.timeoutSec) || ctx.config.worker.commandTimeoutSec, ctx.config.worker.commandTimeoutSec);
        return await ctx.runner.run(args.command, {
          cwd: ctx.worktreePath,
          timeoutSec,
          outputCap: ctx.config.worker.commandOutputCap
        });
      }
      case 'read_file': {
        const j = await ctx.jail.check(targetIn(ctx, args.path));
        if (!j.ok) return { error: 'path_jail', path: args.path };
        const offset = Math.max(0, Number(args.offset) || 0);
        const limit = args.limit !== undefined ? Math.max(1, Number(args.limit) || 1) : Infinity;
        const capBytes = ctx.config.worker.commandOutputCap;
        const windowCap = capBytes + 256;
        let fh;
        try {
          fh = await fs.open(j.resolved, 'r');
          const chunk = Buffer.allocUnsafe(32768);
          let lineIdx = 0;
          let collected = [];
          let collectedBytes = 0;
          let collectedLines = 0;
          let pos = 0;
          let carry = Buffer.alloc(0);
          let done = false;
          while (!done) {
            const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
            if (bytesRead === 0) break;
            pos += bytesRead;
            const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
            let start = 0;
            for (let i = 0; i < buf.length; i++) {
              if (buf[i] === 0x0a) {
                if (lineIdx >= offset) {
                  const lineBuf = buf.subarray(start, i);
                  if (collectedLines > 0) {
                    collected.push(Buffer.from('\n'));
                    collectedBytes += 1;
                  }
                  collected.push(Buffer.from(lineBuf));
                  collectedBytes += lineBuf.length;
                  collectedLines += 1;
                  if (collectedLines >= limit || collectedBytes >= windowCap) {
                    done = true;
                    break;
                  }
                }
                lineIdx += 1;
                start = i + 1;
              }
            }
            carry = done ? Buffer.alloc(0) : Buffer.from(buf.subarray(start));
          }
          if (!done && carry.length && lineIdx >= offset && collectedLines < limit && collectedBytes < windowCap) {
            if (collectedLines > 0) collected.push(Buffer.from('\n'));
            collected.push(carry);
          }
          const sliced = Buffer.concat(collected).toString('utf8');
          return { path: j.resolved, ...truncateBytes(sliced, capBytes) };
        } catch (e) {
          return { error: 'read_failed', message: e.message };
        } finally {
          await fh?.close().catch(() => {});
        }
      }
      case 'write_file': {
        const j = await ctx.jail.check(targetIn(ctx, args.path));
        if (!j.ok) return { error: 'path_jail', path: args.path };
        await fs.mkdir(path.dirname(j.resolved), { recursive: true });
        const content = String(args.content ?? '');
        await fs.writeFile(j.resolved, content, 'utf8');
        return { bytes: Buffer.byteLength(content) };
      }
      case 'submit_flag':
        return ctx.hooks.submitFlag(args);
      case 'finish':
        return { stopped: true, ...ctx.hooks.finish(args) };
      default:
        return { error: 'unknown_tool', name };
    }
  } catch (e) {
    return { error: 'tool_crash', message: e.message };
  }
}
