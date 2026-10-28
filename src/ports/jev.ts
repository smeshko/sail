// The Jev port: typed questions about a state, answered by TypeSafe's Jev in sail's words. Unlike the other four ports a
// run never resolves it: only `sail port jev` does, and `project.yaml` may leave it out.
import type { JevAnswered, JevCapabilities, JevRequest } from './types';

export interface Jev {
  readonly name: string;
  /**
   * Asks every question of the request about its state and answers each by name. Emits `jev:asked` once it has an
   * answer; fails with a PortError of `jev.ask` otherwise, `invalid` for a request that breaks `JevRequest`.
   */
  ask(request: JevRequest): Promise<JevAnswered>;
  capabilities(): JevCapabilities;
}
