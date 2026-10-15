// Pushes a checkout's HEAD to a branch of its remote (DECISIONS D4): `git push --porcelain --no-verify <remote>
// HEAD:refs/heads/<branch>`, never forced, as a process group under a timeout. The token reaches git only through an
// inline credential helper scoped to the web host, and the user's own helpers are reset for the push (D1): no other
// host is offered the token, and no helper can store it. The helper's text names `$SAIL_GIT_TOKEN`, never the token,
// which travels only in the git child's environment, with git's trace variables taken out of it.
//
// A stub until TASK-003: it pushes nothing and answers an empty Pushed.
import type { Redactor } from '../../engine/redact';
import type { Pushed } from '../../ports/types';

/** How long a push may take: as long as a fetch, since it reaches the network too. */
export const PUSH_TIMEOUT_MS = 120_000;

/** The credential helper: it answers `get` with the token from its environment, and ignores `store` and `erase`. */
export const CREDENTIAL_HELPER = '';

export interface PushOptions {
  readonly cwd: string;
  readonly remote: string;
  readonly branch: string;
  readonly token: string;
  /** The web host the token is offered to, such as `https://github.com`. */
  readonly webUrl: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly redact: Redactor;
}

/** git's arguments for the push. None holds the token. */
export function pushArgs(_remote: string, _branch: string, _webUrl: string): string[] {
  return [];
}

/** The push's environment: no prompts, no traces, the token for the helper alone. */
export function pushEnv(env: Readonly<Record<string, string>>, _token: string): Record<string, string> {
  return { ...env };
}

export async function pushHead(_options: PushOptions): Promise<Pushed> {
  return { branch: '', headSha: '', raw: {} };
}
