// The environment variables each pi provider reads its credential from, following pi-ai's own table: the first of a
// provider's names that is set is the key. A provider the table leaves out runs without one, as a local server does.
export const PROVIDER_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  zai: ['ZAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  huggingface: ['HF_TOKEN'],
  fireworks: ['FIREWORKS_API_KEY'],
};

/** The names `provider`'s credential may be under: none for a keyless one (`ollama`) or an unknown one, which pi judges. */
export const keyNames = (provider: string): readonly string[] => PROVIDER_KEYS[provider] ?? [];
