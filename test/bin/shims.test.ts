// bin/shims/mktemp, run by name through a PATH that starts with its folder. Every spawn takes an explicit environment.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SHIMS_DIR } from '../../src/engine/shims';

const SYSTEM_PATH = '/usr/bin:/bin';

/** Runs `mktemp <args>` through `PATH` in `env`, from a directory of its own. */
function mktemp(args: string[], env: Record<string, string>) {
  const child = Bun.spawnSync(['mktemp', ...args], { env, stdout: 'pipe', stderr: 'pipe', cwd: '/' });
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
