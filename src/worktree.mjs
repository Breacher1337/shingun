import path from 'node:path';
import { execDirect } from './shell.mjs';
import { ensureDir } from './util.mjs';

/**
 * Worktree manager: the base repo's refs are master-owned; workers live
 * inside their own `git worktree` checkout. Diffs captured here feed the
 * inspector and post-mortem.
 */
export async function addWorktree({ baseDir, worktreesDir, workerId, branchPrefix = 'shingun/' }) {
  await ensureDir(worktreesDir);
  const wtPath = path.join(worktreesDir, workerId);
  const branch = `${branchPrefix}${workerId}`;
  const res = await execDirect('git', ['worktree', 'add', '-b', branch, wtPath], {
    cwd: baseDir, timeoutSec: 60, outputCap: 4096
  });
  if (res.exitCode !== 0) {
    throw Object.assign(new Error(`git worktree add failed: ${res.stderr}`), { code: 'worktree_failed' });
  }
  return { worktreePath: wtPath, branch };
}

export async function captureDiff(worktreePath, { outputCap = 65536 } = {}) {
  // intent-to-add stages untracked files so new solvers/exploits show in diff
  await execDirect('git', ['add', '--intent-to-add', '-A', '.'], { cwd: worktreePath, timeoutSec: 30, outputCap: 2048 });
  const numstat = await execDirect('git', ['diff', '--numstat'], { cwd: worktreePath, timeoutSec: 30, outputCap: 4096 });
  const diff = await execDirect('git', ['diff'], { cwd: worktreePath, timeoutSec: 30, outputCap });
  const stats = { files: 0, insertions: 0, deletions: 0 };
  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [a, d] = line.split('\t');
    stats.files += 1;
    stats.insertions += a === '-' ? 0 : Number(a) || 0;
    stats.deletions += d === '-' ? 0 : Number(d) || 0;
  }
  return { stats, diff: diff.stdout };
}

export async function removeWorktree(worktreePath) {
  await execDirect('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: path.dirname(path.dirname(worktreePath)), timeoutSec: 30, outputCap: 2048
  }).catch(() => {});
}
