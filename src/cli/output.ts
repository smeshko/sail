// The writer sail prints through on stdout and stderr. A reader that went away (`sail FAKE-1 | head -1`) closes the
// pipe: the writer then goes quiet for the rest of the process, and the run carries on to its end. Any other error
// surfaces as it would without this writer.
export type PipeStream = {
  write(text: string): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
};

const isClosedPipe = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'EPIPE';

export function quietOnClosedPipe(stream: PipeStream): (text: string) => void {
  let closed = false;
  stream.on('error', (error) => {
    if (!isClosedPipe(error)) throw error;
    closed = true;
  });
  return (text) => {
    if (closed) return;
    try {
      stream.write(text);
    } catch (error) {
      if (!isClosedPipe(error)) throw error;
      closed = true;
    }
  };
}
