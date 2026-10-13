import type { Builtins } from '../ports/adapter';
import { fakeAdapters } from './fake/index';
import { linearAdapters } from './ticket-source/linear/index';

export { createFakeCodeHost, createFakeHarness, createFakeTicketSource, createFakeWorkspace } from './fake/index';

/** The built-in adapters by name: the set a composition root hands to the adapter registry. */
export const BUILTINS: Builtins = { fake: fakeAdapters, linear: linearAdapters };
