// The validate stage holds the machine's gate lock and tells the gate it spawns who holds it.
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempRepo } from '../helpers/temp-repo';

const ROOT = join(import.meta.dir, '../..');

test("validate's gate child sees SAIL_GATE_LOCK_HOLDER equal to the pid in the lock's holder file", async () => {
  await withTempRepo(async (repo) => {
    const tmp = join(repo.home, 'tmp');
    mkdirSync(tmp);
    const seen = join(repo.home, 'seen');
    const stub = join(repo.home, 'bun-stub.sh');
    writeFileSync(
      stub,
      `#!/bin/sh\nif [ "$1 $2" = "run gate" ]; then\n  printf '%s\\n%s' "$SAIL_GATE_LOCK_HOLDER" "$(cat "$TMPDIR/sail-validate.lock/holder")" > ${JSON.stringify(seen)}\nfi\nexit 0\n`,
    );
    chmodSync(stub, 0o755);
    const child = Bun.spawn([process.execPath, join(ROOT, '.sail/stages/validate/validate.mjs')], {
      cwd: repo.dir,
      env: { ...repo.env, TMPDIR: tmp, SAIL_BUN: stub, SAIL_CONFIG: join(ROOT, '.sail/project.yaml') },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(err).toBe('');
    expect(code).toBe(0);
    const verdict = JSON.parse(out);
    expect(verdict.verify.ok).toBe(true);
    const [env, holder] = readFileSync(seen, 'utf8').split('\n');
    expect(env).toBe(String(child.pid));
    expect(holder).toBe(`${child.pid} ${repo.dir}`);
  });
});

test('validate waits without a cap for another holder, printing its wait line, and frees the lock on exit', async () => {
  await withTempRepo(async (repo) => {
    const tmp = join(repo.home, 'tmp');
    mkdirSync(join(tmp, 'sail-validate.lock'), { recursive: true });
    const holder = Bun.spawn(['sleep', '30']);
    writeFileSync(join(tmp, 'sail-validate.lock/holder'), `${holder.pid} /elsewhere\n`);
    const stub = join(repo.home, 'bun-stub.sh');
    writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    chmodSync(stub, 0o755);
    const child = Bun.spawn([process.execPath, join(ROOT, '.sail/stages/validate/validate.mjs')], {
      cwd: repo.dir,
      env: { ...repo.env, TMPDIR: tmp, SAIL_BUN: stub, SAIL_CONFIG: join(ROOT, '.sail/project.yaml') },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const err = new Response(child.stderr).text();
    await Bun.sleep(2500);
    expect(child.exitCode).toBeNull();
    holder.kill();
    await holder.exited;
    expect(await child.exited).toBe(0);
    expect(await err).toBe('validate: waiting for the validation in /elsewhere\n');
    expect(await Bun.file(join(tmp, 'sail-validate.lock')).exists()).toBe(false);
  });
});
