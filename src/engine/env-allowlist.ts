// Shared by the claude-code harness, pi's bash tool and script steps. The list is for a harness's own process;
// credentials never reach a command unless the script step declares them.
/** The names of sail's environment a session may see, beside its call's preamble (D7). */
export const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_*',
  'TERM',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_*',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_*',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  // Jev's key, so a session can prove the Jev adapter with a live call.
  'TYPESAFE_API_KEY',
];

/** Names the credentials of a provider sit under: allowlisted for the harness itself, never for a command. */
export const CREDENTIAL = /^(?:ANTHROPIC_|AWS_|CLAUDE_|CLOUD_ML_|GOOGLE_)|(?:_API_KEY|_TOKEN|_SECRET|_SECRET_KEY)$/;

export const allowlisted = (name: string): boolean =>
  ENV_ALLOWLIST.some((entry) => (entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry));

export const isCredential = (name: string): boolean => CREDENTIAL.test(name);

const GIT_IDENTITY = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
]);

/** Picks the script environment, recording only set, explicitly requested names. */
export function scriptEnv(
  source: Readonly<Record<string, string | undefined>>,
  declared: readonly string[],
): { env: Record<string, string>; given: string[] } {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      (((allowlisted(name) || name.startsWith('SAIL_')) && !isCredential(name)) ||
        name === 'SSH_AUTH_SOCK' ||
        name === 'XDG_CONFIG_HOME' ||
        GIT_IDENTITY.has(name))
    )
      env[name] = value;
  }
  const given: string[] = [];
  for (const name of declared) {
    const value = source[name];
    if (value !== undefined) {
      env[name] = value;
      if (!given.includes(name)) given.push(name);
    }
  }
  return { env, given };
}
