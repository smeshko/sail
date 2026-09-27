// Generated from src/sdk by `bun run types`. Do not edit.
import type { z } from 'zod';
import { type EndsIn, type Produces, type StepList } from './steps';
/** What a run can start from. */
export type SourceKind = 'ticket' | 'pr';
export interface IntakeOptions<O extends z.ZodType, P extends Produces, Steps extends StepList> {
    /** The sources this intake builds an input from. */
    readonly accepts: readonly SourceKind[];
    /** The input's schema. An intake with steps outputs its last step's, so this is that step's own schema. */
    readonly output: O;
    readonly produces?: P;
    /** Its body. A built-in intake declared ahead of its body has none. */
    readonly steps?: Steps;
}
export interface Intake<O extends z.ZodType = z.ZodType, P extends Produces = Produces, Steps extends StepList = StepList> extends Omit<IntakeOptions<O, P, Steps>, 'produces'> {
    readonly kind: 'intake';
    readonly name: string;
    readonly produces: P;
}
/** Declares an intake: the sources it accepts, the input it builds and the files it leaves for the workflow. */
export declare function intake<O extends z.ZodType, P extends Produces = Record<never, never>, const Steps extends StepList = StepList>(name: string, options: IntakeOptions<O, P, Steps> & {
    readonly steps?: EndsIn<O>;
}): Intake<O, P, Steps>;
