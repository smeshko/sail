// PortError (D5): a failure the caller can't handle, with a code it can branch on.
import { expect, test } from 'bun:test';
import { PortError } from '../../src/ports/errors';

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a PortError is an Error that names its port, operation and code, keeps raw, and prefixes its message', () => {
  const raw = { status: 404 };
  const error = new PortError('ticketSource', 'get', 'not_found', 'no ticket FAKE-9', raw);
  expect(error).toBeInstanceOf(Error);
  const { name, message, port, op, code } = error;
  expect({ name, message, port, op, code, raw: error.raw }).toEqual({
    name: 'PortError',
    message: 'ticketSource.get: no ticket FAKE-9',
    port: 'ticketSource',
    op: 'get',
    code: 'not_found',
    raw,
  });
});
