import { describe, expect, test } from 'bun:test';
import { recordingKeepAwake, systemKeepAwake } from '../../src/engine/keep-awake';

interface FakeChild {
  killed: number;
  unrefs: number;
  kill(): void;
  unref(): void;
}

function fakeDeps(over: Partial<{ platform: string; which: string | null; throws: string }> = {}) {
  const spawned: string[][] = [];
  const children: FakeChild[] = [];
  const deps = {
    platform: over.platform ?? 'darwin',
    which: () => (over.which === undefined ? '/usr/bin/caffeinate' : over.which),
    pid: 4242,
    spawn: (cmd: string[]) => {
      if (over.throws) throw new Error(over.throws);
      spawned.push(cmd);
      const child: FakeChild = {
        killed: 0,
        unrefs: 0,
        kill() {
          this.killed++;
        },
        unref() {
          this.unrefs++;
        },
      };
      children.push(child);
      return child;
    },
  };
  return { deps, spawned, children };
}

describe('systemKeepAwake', () => {
  test('holds caffeinate -i -s -w <pid> on darwin, unreffed', () => {
    const { deps, spawned, children } = fakeDeps();
    const hold = systemKeepAwake({}, deps).acquire();
    expect(hold.held).toBe(true);
    if (hold.held) expect(hold.by).toBe('caffeinate');
    expect(spawned).toEqual([['caffeinate', '-i', '-s', '-w', '4242']]);
    expect(children[0]?.unrefs).toBe(1);
  });

  test('release kills the child exactly once however often it is called', () => {
    const { deps, children } = fakeDeps();
    const hold = systemKeepAwake({}, deps).acquire();
    hold.release();
    hold.release();
    hold.release();
    expect(children[0]?.killed).toBe(1);
  });

  test('SAIL_KEEP_AWAKE=off holds nothing and spawns nothing', () => {
    const { deps, spawned } = fakeDeps();
    const hold = systemKeepAwake({ SAIL_KEEP_AWAKE: 'off' }, deps).acquire();
    expect(hold).toMatchObject({ held: false, reason: 'SAIL_KEEP_AWAKE is off' });
    expect(spawned).toEqual([]);
    hold.release();
  });

  test('another platform holds nothing and spawns nothing', () => {
    const { deps, spawned } = fakeDeps({ platform: 'linux' });
    const hold = systemKeepAwake({}, deps).acquire();
    expect(hold).toMatchObject({ held: false, reason: 'no keep-awake on linux' });
    expect(spawned).toEqual([]);
  });

  test('a missing caffeinate holds nothing and spawns nothing', () => {
    const { deps, spawned } = fakeDeps({ which: null });
    const hold = systemKeepAwake({}, deps).acquire();
    expect(hold).toMatchObject({ held: false, reason: 'caffeinate is not on the PATH' });
    expect(spawned).toEqual([]);
  });

  test('a spawn that throws holds nothing and does not throw', () => {
    const { deps } = fakeDeps({ throws: 'EPERM' });
    const hold = systemKeepAwake({}, deps).acquire();
    expect(hold).toMatchObject({ held: false, reason: 'caffeinate could not start: EPERM' });
    hold.release();
  });
});

describe('recordingKeepAwake', () => {
  test('records acquire then release', () => {
    const { keepAwake, calls } = recordingKeepAwake();
    const hold = keepAwake.acquire();
    expect(calls).toEqual(['acquire']);
    expect(hold).toMatchObject({ held: true, by: 'fake' });
    hold.release();
    expect(calls).toEqual(['acquire', 'release']);
  });

  test('answers held: false with the reason it was given', () => {
    const { keepAwake } = recordingKeepAwake({ reason: 'no caffeinate here' });
    expect(keepAwake.acquire()).toMatchObject({ held: false, reason: 'no caffeinate here' });
  });
});
