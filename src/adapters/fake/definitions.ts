// The fakes as adapter definitions: each reads its options from `project.yaml` and is created from them (DECISIONS D7).
import type { Port } from '../../engine/config';
import type { AdapterDefinition, PortAdapters } from '../../ports/adapter';

const unwritten = (): never => {
  throw new Error('not implemented');
};

export const fakeAdapters: { [P in Port]: AdapterDefinition<PortAdapters[P]> } = {
  ticketSource: { create: unwritten },
  codeHost: { create: unwritten },
  harness: { create: unwritten },
  workspace: { create: unwritten },
};
