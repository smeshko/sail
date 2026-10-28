// How a pi session submits: a custom tool named `submit` whose parameters are the done/blocked envelope around the
// step's output schema. The tool checks the arguments before it accepts them, so a model that got the output wrong is
// told what, as the tool's result, and submits again; the first valid submission is kept and ends the turn. The agent
// kind checks the output against the step's schema once more, so a schema this check cannot compile loses nothing.
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';
import { submissionEnvelope } from '../claude-code/submission';
import { SUBMIT_TOOL } from './tool-call';

/** The last section appended to pi's system prompt: how this harness takes a submission. */
export const SUBMIT_CONTRACT = `## Submitting

You submit by calling the \`${SUBMIT_TOOL}\` tool, exactly once, when the work is over. Its argument is an envelope:

- When the work is complete: {"outcome": "done", "output": <the output its schema describes>}
- When you cannot complete it: {"outcome": "blocked", "reason": "<one paragraph saying why>"}

Submit nothing else, and do not submit before the work is done.`;

export type Submitted =
  | { readonly outcome: 'done'; readonly output: unknown }
  | { readonly outcome: 'blocked'; readonly reason: string };

type Reply = { content: { type: 'text'; text: string }[]; details: undefined; terminate?: boolean };

/** The part of pi's tool definition the adapter fills. */
export interface SubmitTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown): Promise<Reply>;
}

const reply = (text: string, terminate = false): Reply => ({
  content: [{ type: 'text', text }],
  details: undefined,
  ...(terminate ? { terminate: true } : {}),
});

function describe(error: ErrorObject): string {
  if (error.keyword === 'required') return `${error.instancePath}/${error.params.missingProperty}: is required`;
  if (error.keyword === 'additionalProperties') {
    return `${error.instancePath}/${error.params.additionalProperty}: is not allowed`;
  }
  return `${error.instancePath || '/'}: ${error.message ?? 'is invalid'}`;
}

export function submitTool(
  outputSchema: Readonly<Record<string, unknown>>,
  onSubmitted: (submitted: Submitted) => void,
): SubmitTool {
  const parameters = submissionEnvelope(outputSchema);
  let validate: ((data: unknown) => boolean) & { errors?: ErrorObject[] | null } = () => true;
  try {
    validate = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true }).compile(parameters);
  } catch {
    // The agent kind checks the output against the schema again.
  }
  let kept = false;

  return {
    name: SUBMIT_TOOL,
    label: 'Submit',
    description:
      'Hand in the step\'s output, exactly once, when the work is over: {"outcome": "done", "output": …} when it is ' +
      'complete, or {"outcome": "blocked", "reason": "…"} when you cannot complete it.',
    parameters,
    async execute(_toolCallId, params) {
      if (kept) return reply('Already submitted.', true);
      const problems = validate(params) ? [] : (validate.errors ?? []).map(describe);
      const envelope = (typeof params === 'object' && params !== null ? params : {}) as {
        outcome?: unknown;
        output?: unknown;
        reason?: unknown;
      };
      if (problems.length === 0 && envelope.outcome === 'done' && envelope.output === undefined) {
        problems.push('/output: is required for a done submission');
      }
      if (problems.length === 0 && envelope.outcome === 'blocked' && typeof envelope.reason !== 'string') {
        problems.push('/reason: is required for a blocked submission');
      }
      if (problems.length === 0 && envelope.outcome !== 'done' && envelope.outcome !== 'blocked') {
        problems.push('/outcome: must be done or blocked');
      }
      if (problems.length > 0) {
        return reply(
          `The submission was not accepted. Fix these and submit again:\n${problems.map((p) => `- ${p}`).join('\n')}`,
        );
      }
      kept = true;
      onSubmitted(
        envelope.outcome === 'done'
          ? { outcome: 'done', output: envelope.output }
          : { outcome: 'blocked', reason: envelope.reason as string },
      );
      return reply('Submitted.', true);
    },
  };
}
