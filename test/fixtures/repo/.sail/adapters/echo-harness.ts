// echo-harness: the fixture repository's own Harness adapter, a module sail loads by path. It answers every session
// with its prompt, so a run that swaps it in for the fake needs no script. It requires a token and declares a version,
// which is what the adapter registry's credential preflight and `run.json` record. It reports `permissions: true`
// because it runs no tools: there is nothing to deny.

/** What `run` reads of a session's request. */
interface Request {
  readonly prompt: string;
}

export default {
  requires: () => ['ECHO_HARNESS_TOKEN'],
  versions: () => ({ echo: '1.0.0' }),
  create: () => ({
    name: 'echo',
    capabilities: () => ({ structuredOutput: true, permissions: true, usage: true, abort: true, budgets: [] }),
    run: async (request: Request) => ({
      outcome: 'done',
      output: { echo: request.prompt },
      sessionId: 'echo-1',
      usage: { costUsd: 0 },
      transcript: '',
      raw: null,
    }),
  }),
};
