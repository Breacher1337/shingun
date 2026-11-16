import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Path jail: a target path is allowed only when, after resolving symlinks of
 * the deepest existing ancestor, it lives under one of the jailed roots.
 * File tools and shell cwd both go through this.
 */
export async function makeJail(roots) {
  const allowed = roots.filter(Boolean).map((r) => path.resolve(r));
  return {
    roots: allowed,
    async check(p) {
      const target = path.resolve(String(p ?? ''));
      // Walk toward the root until we find an existing ancestor, then
      // realpath it; symlinks pointing outside become someone else's path.
      let probe = target;
      const tail = [];
      for (;;) {
        if (await fs.stat(probe).then(() => true).catch(() => false)) break;
        tail.unshift(path.basename(probe));
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      let resolved = probe;
      try { resolved = await fs.realpath(probe); } catch { /* keep as-is */ }
      const resolvedPath = tail.length ? path.join(resolved, ...tail) : resolved;
      const ok = allowed.some((root) =>
        resolvedPath === root || resolvedPath.startsWith(root + path.sep)
      );
      return ok ? { ok: true, resolved: resolvedPath } : { ok: false, reason: 'path_jail', resolved: resolvedPath };
    }
  };
}

/** Best-effort deny-list: a speed bump, documented as such. */
export function denylistHit(command, denylist) {
  const cmd = String(command ?? '');
  for (const pat of denylist ?? []) {
    if (pat && cmd.includes(pat)) return pat;
  }
  return null;
}
