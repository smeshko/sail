// bin/shims/mktemp, run by name through a PATH that starts with its folder. Every spawn takes an explicit environment.
import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SESSION_ENV_FILE, SHIMS_DIR } from '../../src/engine/shims';
import { withTempRepo } from '../helpers/temp-repo';

const SYSTEM_PATH = '/usr/bin:/bin';

/** Runs `mktemp <args>` through `PATH` in `env`, from a directory of its own. */
function mktemp(args: string[], env: Record<string, string>) {
  const child = Bun.spawnSync(['mktemp', ...args], { env, stdout: 'pipe', stderr: 'pipe', cwd: '/', timeout: 5000 });
  return { code: child.exitCode, out: child.stdout.toString().trim(), err: child.stderr.toString() };
}

function withDirs(body: (tmp: string, other: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shim-')));
  const tmp = join(root, 'tmp');
  const other = join(root, 'other');
  mkdirSync(tmp);
  mkdirSync(other);
  try {
    body(tmp, other);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('mktemp with no template makes its file in TMPDIR', () => {
  withDirs((tmp) => {
    const env = { PATH: `${SHIMS_DIR}:${SYSTEM_PATH}`, TMPDIR: tmp };
    for (const args of [[], ['-d'], ['-u'], ['-q'], ['-du'], ['-t', 'build'], ['-t', 'build.XXXXXX']]) {
      const r = mktemp(args, env);
      expect([args, r.code]).toEqual([args, 0]);
      expect([args, dirname(r.out)]).toEqual([args, tmp]);
    }
    expect(statSync(mktemp([], env).out).isFile()).toBe(true);
    expect(statSync(mktemp(['-d'], env).out).isDirectory()).toBe(true);
    expect(existsSync(mktemp(['-u'], env).out)).toBe(false);
    expect(basename(mktemp(['-t', 'build'], env).out).startsWith('build.')).toBe(true);
    expect(basename(mktemp(['-t', 'build.XXXXXX'], env).out).startsWith('build.')).toBe(true);
  });
});

test('a TMPDIR with a trailing slash still gives a path directly inside it', () => {
  withDirs((tmp) => {
    const r = mktemp([], { PATH: `${SHIMS_DIR}:${SYSTEM_PATH}`, TMPDIR: `${tmp}/` });
    expect(dirname(r.out)).toBe(tmp);
  });
});

test('a template or -p of its own goes to the real mktemp unchanged', () => {
  withDirs((tmp, other) => {
    const env = { PATH: `${SHIMS_DIR}:${SYSTEM_PATH}`, TMPDIR: tmp };
    expect(dirname(mktemp([`${other}/f.XXXXXX`], env).out)).toBe(other);
    expect(dirname(mktemp(['-p', other], env).out)).toBe(other);
  });
});

test('with TMPDIR unset it behaves as the real mktemp', () => {
  withDirs((tmp) => {
    const r = mktemp([], { PATH: `${SHIMS_DIR}:${SYSTEM_PATH}` });
    expect(r.code).toBe(0);
    expect(dirname(r.out).startsWith(tmp)).toBe(false);
    rmSync(r.out, { force: true });
  });
});

test('the shim never runs itself', () => {
  withDirs((tmp) => {
    const twice = mktemp([], { PATH: `${SHIMS_DIR}:${SHIMS_DIR}:${SYSTEM_PATH}`, TMPDIR: tmp });
    expect([twice.code, dirname(twice.out)]).toEqual([0, tmp]);
    const alone = mktemp([], { PATH: SHIMS_DIR, TMPDIR: tmp });
    expect([alone.code, dirname(alone.out)]).toEqual([0, tmp]);
  });
});

test('two different copies of the shim on one PATH find the real mktemp, not each other', () => {
  withDirs((tmp, other) => {
    const copies = [join(other, 'a'), join(other, 'b')];
    for (const folder of copies) {
      mkdirSync(folder);
      copyFileSync(join(SHIMS_DIR, 'mktemp'), join(folder, 'mktemp'));
      chmodSync(join(folder, 'mktemp'), 0o755);
    }
    const env = { PATH: `${copies.join(':')}:${SYSTEM_PATH}`, TMPDIR: tmp };
    const bare = mktemp([], env);
    expect([bare.code, dirname(bare.out)]).toEqual([0, tmp]);
    const kept = mktemp([`${other}/k.XXXXXX`], env);
    expect([kept.code, dirname(kept.out)]).toEqual([0, other]);
    const unset = mktemp([], { PATH: env.PATH });
    expect(unset.code).toBe(0);
    rmSync(unset.out, { force: true });
  });
});

/** Runs `script` in a login bash with `env`, as Claude Code runs a Bash command, and gives its lines. */
function loginBash(script: string, env: Record<string, string>): string[] {
  const child = Bun.spawnSync(['/bin/bash', '-l', '-c', script], { env, cwd: '/', stdout: 'pipe', stderr: 'pipe' });
  expect(child.stderr.toString()).toBe('');
  return child.stdout.toString().trim().split('\n');
}

test('a login bash that sources session-env.sh finds the shim first, whatever its profile did to PATH', async () => {
  await withTempRepo((repo) => {
    const tmp = realpathSync(repo.dir);
    const base = { ...repo.env, SAIL_SHIMS: SHIMS_DIR, TMPDIR: tmp, CLAUDE_ENV_FILE: SESSION_ENV_FILE };
    const script = '. "$CLAUDE_ENV_FILE"; command -v mktemp; mktemp';
    for (const path of [`${SHIMS_DIR}:${SYSTEM_PATH}`, SYSTEM_PATH]) {
      const [found, made] = loginBash(script, { ...base, PATH: path });
      expect([found, dirname(realpathSync(made ?? ''))]).toEqual([`${SHIMS_DIR}/mktemp`, tmp]);
      rmSync(made ?? '', { force: true });
    }
  });
});

test('sourcing session-env.sh twice leaves the shims folder once at the head of PATH, and with SAIL_SHIMS unset PATH is as it was', async () => {
  await withTempRepo((repo) => {
    const base = { ...repo.env, CLAUDE_ENV_FILE: SESSION_ENV_FILE };
    const twice = loginBash('. "$CLAUDE_ENV_FILE"; . "$CLAUDE_ENV_FILE"; echo "$PATH"', {
      ...base,
      SAIL_SHIMS: SHIMS_DIR,
      PATH: SYSTEM_PATH,
    });
    const entries = (twice[0] ?? '').split(':');
    expect([entries[0], entries.filter((entry) => entry === SHIMS_DIR).length]).toEqual([SHIMS_DIR, 1]);
    const unset = loginBash('before="$PATH"; . "$CLAUDE_ENV_FILE"; [ "$before" = "$PATH" ] && echo same', {
      ...base,
      PATH: SYSTEM_PATH,
    });
    expect(unset).toEqual(['same']);
  });
});
