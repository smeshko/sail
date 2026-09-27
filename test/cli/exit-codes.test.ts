import { expect, test } from 'bun:test';
import { EXIT_FAILED, EXIT_INTERNAL, EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';

test('the exit codes are design.md §4 codes 0 to 4', () => {
  expect([EXIT_OK, EXIT_FAILED, EXIT_SUSPENDED, EXIT_REFUSED, EXIT_INTERNAL]).toEqual([0, 1, 2, 3, 4]);
});
