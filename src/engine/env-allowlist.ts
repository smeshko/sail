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
