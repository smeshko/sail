import type { Builtins } from '../ports/adapter';
import { claudeCodeAdapters } from './claude-code/harness';
import { fakeAdapters } from './fake/index';

export { createFakeCodeHost, createFakeHarness, createFakeTicketSource, createFakeWorkspace } from './fake/index';

/** The built-in adapters by name: the set a composition root hands to the adapter registry. */
export const BUILTINS: Builtins = {
  fake: fakeAdapters,
  'claude-code': { harness: claudeCodeAdapters },
};
