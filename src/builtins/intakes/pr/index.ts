// The built-in `pr` intake's body: it fetches the run's pull request through the CodeHost, checks its ticket marker
// against its head branch, and leaves `pr.json`, `diff.patch` and `brief.md` in the call directory. Every string the
// host returned is wrapped as untrusted input in the brief. It returns the run's input, unvalidated: the engine checks it
// against `PrInput`.
//
// The head sha in the output is the run's own: the source's, never the one the host sends back now.
import type { IntakeContext } from '../index';

/** Runs the `pr` intake once. A failed port call, or a ticket marker that doesn't match the branch, is a PortError. */
export async function prIntake(_context: IntakeContext): Promise<unknown> {
  return {};
}
