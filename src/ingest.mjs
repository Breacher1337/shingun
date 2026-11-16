import fs from 'node:fs/promises';
import path from 'node:path';
import { execDirect } from './shell.mjs';
import { ensureDir, listTree, newId } from './util.mjs';

/**
 * Challenge ingest: normalize any source — GitHub URL or plain local
 * folder — into a git base repo at challenges/<id>/base, so the worktree
 * pipeline is uniform across sources.
 */
export async function ingestChallenge({ source, value, challengesDir, challengeId }) {
  const id = challengeId ?? newId('ch');
  const baseDir = path.join(challengesDir, id, 'base');
  await ensureDir(path.dirname(baseDir));

  if (source === 'url') {
    const res = await execDirect('git', ['clone', '--depth', '50', value, baseDir], { timeoutSec: 300, outputCap: 4096 });
    if (res.exitCode !== 0) {
      throw Object.assign(new Error(`git clone failed: ${res.stderr}`), { code: 'ingest_clone_failed' });
    }
  } else {
    const src = path.resolve(value);
    const stat = await fs.stat(src).catch(() => null);
    if (!stat?.isDirectory()) {
      throw Object.assign(new Error(`challenge path is not a directory: ${src}`), { code: 'ingest_bad_path' });
    }
    await fs.cp(src, baseDir, { recursive: true, force: true, errorOnExist: false });
    const hasGit = await fs.stat(path.join(baseDir, '.git')).then(() => true).catch(() => false);
    if (!hasGit) {
      await execDirect('git', ['init'], { cwd: baseDir, timeoutSec: 30, outputCap: 2048 });
    }
    await execDirect('git', ['add', '-A'], { cwd: baseDir, timeoutSec: 60, outputCap: 2048 });
    const commit = await execDirect(
      'git',
      ['-c', 'user.name=shingun', '-c', 'user.email=shingun@local', 'commit', '-m', 'shingun: normalized challenge base'],
      { cwd: baseDir, timeoutSec: 60, outputCap: 2048 }
    );
    // "nothing to commit" is fine for an empty-but-git repo
    if (commit.exitCode !== 0 && !/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) {
      throw Object.assign(new Error(`git commit failed: ${commit.stderr}`), { code: 'ingest_commit_failed' });
    }
  }

  const { fileCount, topFiles } = await listTree(baseDir);
  return { challengeId: id, baseDir, fileCount, topFiles };
}
