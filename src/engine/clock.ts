// A run's clock: where every time a run records is read from. The bus stamps each event's `ts` from it, a try its
// `startedAt` and `finishedAt`, the journal its `recordedAt`, and a script step its duration. So a run given a clock and
// the random part of its id writes the same run directory each time. Nothing that waits reads it: a timeout, a grace
// period and a lock wait measure real time, and record none.
export type Clock = () => Date;

/** The clock a run reads when it is given none. */
export const systemClock: Clock = () => new Date();
