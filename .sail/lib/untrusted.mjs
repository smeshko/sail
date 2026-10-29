import { spawnSync } from 'node:child_process';

/** Wrap passages through sail's renderer in one process, preserving their order. */
export function wrapAll(passages) {
  if (passages.length === 0) return [];
  const result = spawnSync('sail', ['port', 'render', '--untrusted', '--batch'], {
    encoding: 'utf8',
    input: JSON.stringify(passages),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `sail port render --untrusted --batch: ${(result.stderr || result.error?.message || `exit ${result.status ?? result.signal}`).trim()}`,
    );
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
