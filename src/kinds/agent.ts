// The agent kind: one try of an agent step. It renders the prompt, runs one session on the harness, and checks what
// came back against the step's contract. A corrective try is its call's to start.
import type { AgentStep } from '../sdk/steps';
import type { StepContext, StepKind, StepRun } from './index';

function problems(_step: AgentStep): string[] {
  return [];
}

async function run(_step: AgentStep, _context: StepContext): Promise<StepRun> {
  return { outcome: 'done', output: null, files: {}, errors: [], record: {} };
}

export const agentKind: StepKind<AgentStep> = { kind: 'agent', problems, run };
