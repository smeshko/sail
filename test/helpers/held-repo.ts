// holdTempRepo(): one withTempRepo() kept open from beforeAll to afterAll, for a test file whose tests share a
// repository, such as a port suite whose make() runs once per test. The repository is removed after the last test.
import { afterAll, beforeAll } from 'bun:test';
import { type TempRepo, withTempRepo } from './temp-repo';

/** Registers the file's hooks, and returns the repository to read inside a test. */
export function holdTempRepo(): () => TempRepo {
  let held: TempRepo | undefined;
  let release: () => void = () => undefined;
  let finished: Promise<void> = Promise.resolve();
  beforeAll(async () => {
    await new Promise<void>((ready) => {
      finished = withTempRepo(
        (repo) =>
          new Promise<void>((resolve) => {
            held = repo;
            release = resolve;
            ready();
          }),
      );
    });
  });
  afterAll(async () => {
    release();
    await finished;
  });
  return () => {
    if (held === undefined) throw new Error('holdTempRepo: the repository exists only inside a test');
    return held;
  };
}
