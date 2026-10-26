import { expect, test } from 'bun:test';
import { quietOnClosedPipe } from '../../src/cli/output';

const errno = (code: string): Error => Object.assign(new Error(`${code}: write failed`), { code });

/** A stream whose `write` records what reaches it, or throws what `failWith` returns for the text. */
function fakeStream(failWith: (text: string) => Error | undefined = () => undefined) {
  const written: string[] = [];
  const listeners: ((error: Error) => void)[] = [];
  return {
    written,
    emit: (error: Error) => {
      for (const listener of listeners) listener(error);
    },
    write(text: string) {
      const error = failWith(text);
      if (error !== undefined) throw error;
      written.push(text);
      return true;
    },
    on(_event: 'error', listener: (error: Error) => void) {
      listeners.push(listener);
    },
  };
}

test('writes reach the stream in order until it reports a closed pipe', () => {
  const stream = fakeStream();
  const write = quietOnClosedPipe(stream);
  write('one\n');
  write('two\n');
  expect(stream.written).toEqual(['one\n', 'two\n']);
});

test('an EPIPE error event silences every later write', () => {
  const stream = fakeStream();
  const write = quietOnClosedPipe(stream);
  write('before\n');
  stream.emit(errno('EPIPE'));
  expect(() => write('after\n')).not.toThrow();
  write('later\n');
  expect(stream.written).toEqual(['before\n']);
});

test('an EPIPE thrown by write is swallowed and silences every later write', () => {
  const stream = fakeStream((text) => (text === 'broken\n' ? errno('EPIPE') : undefined));
  const write = quietOnClosedPipe(stream);
  write('before\n');
  expect(() => write('broken\n')).not.toThrow();
  write('after\n');
  expect(stream.written).toEqual(['before\n']);
});

test('a thrown error other than EPIPE is rethrown', () => {
  const stream = fakeStream(() => errno('ENOSPC'));
  const write = quietOnClosedPipe(stream);
  expect(() => write('x')).toThrow('ENOSPC: write failed');
});

test('an error event other than EPIPE is rethrown', () => {
  const stream = fakeStream();
  const write = quietOnClosedPipe(stream);
  expect(() => stream.emit(errno('EIO'))).toThrow('EIO: write failed');
  write('still open\n');
  expect(stream.written).toEqual(['still open\n']);
});
