// Intake: how a run gets its input. The engine runs it before any workflow code, and the workflow reads what it left
// through `run.input` and `run.intake.files`. Workflow code never calls one.

import type { z } from 'zod';
import type { Produces, StepList } from './steps';

/** What a run can start from. */
export type SourceKind = 'ticket' | 'pr';

export interface IntakeOptions<O extends z.ZodType, P extends Produces, Steps extends StepList> {
  /** The sources this intake builds an input from. */
  readonly accepts: readonly SourceKind[];
  /** The input's schema. */
  readonly output: O;
  readonly produces?: P;
  /** Its body. A built-in intake declared ahead of its body has none. */
  readonly steps?: Steps;
}

export interface Intake<
  O extends z.ZodType = z.ZodType,
  P extends Produces = Produces,
  Steps extends StepList = StepList,
> extends Omit<IntakeOptions<O, P, Steps>, 'produces'> {
  readonly kind: 'intake';
  readonly name: string;
  readonly produces: P;
}

/** Declares an intake: the sources it accepts, the input it builds and the files it leaves for the workflow. */
export function intake<
  O extends z.ZodType,
  P extends Produces = Record<never, never>,
  const Steps extends StepList = StepList,
>(name: string, options: IntakeOptions<O, P, Steps>): Intake<O, P, Steps> {
  return { kind: 'intake', name, ...options, produces: options.produces ?? ({} as P) };
}
