// A run's keep-awake: the hold its process takes against the machine's sleep, from the moment it starts or resumes
// until it ends. A run that outlasts the machine's idle timeout would otherwise sleep mid-call, and the call's
// wall-clock timeout would fail it.
//
// On macOS the hold is `caffeinate -i -s -w <pid>`: -i blocks idle sleep, -s also blocks system sleep on AC power,
// and -w ties the assertion to the run's own process, so the OS drops it when that process dies however it dies.
// Closing a laptop's lid on battery without an external display still sleeps the machine: macOS gives a user
// process no way to prevent that. Elsewhere there is no keep-awake and the run goes on without one, as it does
// with SAIL_KEEP_AWAKE=off. Acquiring never throws.

export type KeepAwakeHold =
  | { held: true; by: string; release(): void }
  | { held: false; reason: string; release(): void };

export interface KeepAwake {
  acquire(): KeepAwakeHold;
}

interface Child {
  kill(): void;
  unref(): void;
}

export interface KeepAwakeDeps {
  platform: string;
  which(command: string): string | null;
  spawn(command: string[]): Child;
  pid: number;
}

export function systemKeepAwake(env: Record<string, string | undefined>, deps: Partial<KeepAwakeDeps> = {}): KeepAwake {
  const platform = deps.platform ?? process.platform;
  const which = deps.which ?? ((command: string) => Bun.which(command));
  const spawn = deps.spawn ?? ((command: string[]) => Bun.spawn(command, { stdio: ['ignore', 'ignore', 'ignore'] }));
  const pid = deps.pid ?? process.pid;
  const none = (reason: string): KeepAwakeHold => ({ held: false, reason, release() {} });
  return {
    acquire() {
      if (env.SAIL_KEEP_AWAKE === 'off') return none('SAIL_KEEP_AWAKE is off');
      if (platform !== 'darwin') return none(`no keep-awake on ${platform}`);
      if (!which('caffeinate')) return none('caffeinate is not on the PATH');
      let child: Child;
      try {
        child = spawn(['caffeinate', '-i', '-s', '-w', String(pid)]);
        child.unref();
      } catch (error) {
        return none(`caffeinate could not start: ${error instanceof Error ? error.message : String(error)}`);
      }
      let released = false;
      return {
        held: true,
        by: 'caffeinate',
        release() {
          if (released) return;
          released = true;
          child.kill();
        },
      };
    },
  };
}

export function recordingKeepAwake(options: { reason?: string } = {}): {
  keepAwake: KeepAwake;
  calls: ('acquire' | 'release')[];
} {
  const calls: ('acquire' | 'release')[] = [];
  const release = () => {
    calls.push('release');
  };
  return {
    keepAwake: {
      acquire() {
        calls.push('acquire');
        return options.reason === undefined
          ? { held: true, by: 'fake', release }
          : { held: false, reason: options.reason, release };
      },
    },
    calls,
  };
}
