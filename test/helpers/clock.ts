// steppingClock(): a run's clock for a test. Its first reading is `start`, and each reading is `stepMs` after the last,
// so a run on it records the same times whenever and wherever it runs. `readings` keeps every reading it gave.
export interface SteppingClock {
  (): Date;
  /** Every reading so far, in order. */
  readonly readings: Date[];
}

export function steppingClock(start: string | Date, stepMs: number): SteppingClock {
  const first = new Date(start).getTime();
  const readings: Date[] = [];
  const clock = (): Date => {
    const reading = new Date(first + readings.length * stepMs);
    readings.push(reading);
    return reading;
  };
  return Object.assign(clock, { readings });
}

/** The clock and the id bytes the golden run is generated on (D8): its id is `FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N`. */
export const GOLDEN_START = '2026-09-25T09:00:00.000Z';
export const GOLDEN_STEP_MS = 100;
export const GOLDEN_RANDOM = [69, 201, 163, 108, 93, 196, 139, 62, 52, 117];

/** Fills a run id's random part with `GOLDEN_RANDOM`. */
export const goldenRandom = (bytes: Uint8Array): Uint8Array => {
  bytes.set(GOLDEN_RANDOM);
  return bytes;
};
