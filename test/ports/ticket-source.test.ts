import { expect, test } from 'bun:test';
import { getTicket, openPrerequisites, type TicketSource, waitingOnText } from '../../src/ports/ticket-source';
import type { Ticket } from '../../src/ports/types';
import { messageOf, portFailure, rejection } from '../helpers/ports';

const source = (get: TicketSource['get']): TicketSource => ({ get }) as TicketSource;
const bounded = (pending: Promise<unknown>) => Promise.race([pending, Bun.sleep(100).then(() => 'still pending')]);

for (const late of ['resolve', 'reject', 'never'] as const) {
  test(`getTicket interrupts an ignoring adapter; late ${late} cannot change the rejection`, async () => {
    const controller = new AbortController();
    let resolve!: (ticket: Ticket) => void;
    let reject!: (error: Error) => void;
    const adapter = source(
      () =>
        new Promise<Ticket>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    const pending = rejection(getTicket(adapter, 'ADW-150', controller.signal));
    controller.abort();
    const error = await bounded(pending);
    expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'get', code: 'unavailable' });
    expect(messageOf(error)).toBe('ticketSource.get: the fetch of ADW-150 was interrupted');
    if (late === 'resolve') resolve({} as Ticket);
    if (late === 'reject') reject(new Error('late failure'));
    await Bun.sleep(1);
    expect(await pending).toBe(error);
  });
}

test('a pre-aborted getTicket never calls the adapter', async () => {
  let calls = 0;
  const error = await rejection(
    getTicket(
      source(async () => {
        calls++;
        return {} as Ticket;
      }),
      'ADW-150',
      AbortSignal.abort(),
    ),
  );
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'get', code: 'unavailable' });
  expect(calls).toBe(0);
});

test('getTicket forwards the signal and checks the answer', async () => {
  const signal = new AbortController().signal;
  let received: AbortSignal | undefined;
  const error = await rejection(
    getTicket(
      source(async (_, options) => {
        received = options?.signal;
        return {} as Ticket;
      }),
      'ADW-150',
      signal,
    ),
  );
  expect(received).toBe(signal);
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'get', code: 'invalid' });
});

test('without a signal getTicket still validates the adapter answer', async () => {
  const error = await rejection(
    getTicket(
      source(async () => ({}) as Ticket),
      'ADW-150',
    ),
  );
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'get', code: 'invalid' });
});

const stateOf = (type: 'unstarted' | 'started' | 'completed' | 'canceled') => ({ type, name: type });

test('openPrerequisites keeps unstarted, started and unreadable prerequisites and drops completed and canceled ones', () => {
  const open = openPrerequisites({
    prerequisites: [
      { ticketKey: 'A-1', state: stateOf('unstarted') },
      { ticketKey: 'A-2', state: stateOf('started') },
      { ticketKey: 'A-3', state: stateOf('completed') },
      { ticketKey: 'A-4', state: stateOf('canceled') },
      { ticketKey: 'A-5' },
    ],
  });
  expect(open.map((each) => each.ticketKey)).toEqual(['A-1', 'A-2', 'A-5']);
});

test('openPrerequisites of a ticket with no prerequisites is empty', () => {
  expect(openPrerequisites({})).toEqual([]);
});

test('waitingOnText names a prerequisite by its key and an unreadable one with (unreadable)', () => {
  expect(waitingOnText([{ ticketKey: 'FAKE-1', state: stateOf('started') }, { ticketKey: 'FAKE-99' }])).toEqual([
    'FAKE-1',
    'FAKE-99 (unreadable)',
  ]);
});
