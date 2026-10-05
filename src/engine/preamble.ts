// The environment preamble: the variables every step gets, whatever its kind. A script finds them in its environment,
// and an agent step's harness in its request.
import type { StepContext } from '../kinds/index';

export interface PreambleVariable {
  name: string;
  value: string;
  /** Whether the value is a path, which a result records relative to the workspace. */
  path: boolean;
}

/** The variables of one try of a step, in order: the call, where it reads and writes, then its `INPUT_<NAME>`s. */
export function preamble(context: StepContext): PreambleVariable[] {
  return [
    { name: 'RUN_ID', value: context.runId, path: false },
    { name: 'STAGE', value: context.stage, path: false },
    { name: 'CALL', value: String(context.call), path: false },
    { name: 'TRY', value: String(context.try), path: false },
    { name: 'STAGE_IN', value: context.paths.stageIn, path: true },
    { name: 'STAGE_OUT', value: context.paths.dir, path: true },
    { name: 'WORKSPACE', value: context.workspace, path: true },
    { name: 'SAIL_CONFIG', value: context.config, path: true },
    ...Object.entries(context.inputs).map(([name, value]) => ({ name, value, path: true })),
  ];
}
