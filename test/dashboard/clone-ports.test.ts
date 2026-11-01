// clonePorts(): a clone's Workspace port at once and its code host on demand, from the clone's own project.yaml.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clonePorts } from '../../src/dashboard/clone-ports';
import type { RegistryEntry } from '../../src/watch/registry';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sail-clone-ports-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const entryAt = (): RegistryEntry => ({
  schema: 'sail.registry.v1',
  name: 'clone',
  remote: 'https://example.com/clone.git',
  clone: root,
  sailDir: join(root, '.sail'),
  updatedAt: '2026-10-14T09:00:00.000Z',
});

test("a clone's ports are its workspace and a code host resolved once, on the first ask", async () => {
  cpSync(join(import.meta.dir, '..', 'fixtures', 'repo', '.sail'), join(root, '.sail'), { recursive: true });
  const ports = await clonePorts(entryAt(), {});
  if ('refused' in ports) throw new Error(ports.refused);
  expect(ports.adapters.ports.workspace.name).toBe('fake');
  const host = await ports.codeHost();
  if ('refused' in host) throw new Error(host.refused);
  expect(host.name).toBe('fake');
  expect(await ports.codeHost()).toBe(host);
});

test('a clone with no valid project.yaml is refused with the config issues', async () => {
  mkdirSync(join(root, '.sail'));
  writeFileSync(join(root, '.sail', 'project.yaml'), 'name: clone\n');
  const ports = await clonePorts(entryAt(), {});
  expect('refused' in ports ? ports.refused : ports).toContain('sail.project.v1');
});

test('a workspace adapter that cannot be resolved is refused with its issue', async () => {
  cpSync(join(import.meta.dir, '..', 'fixtures', 'repo', '.sail'), join(root, '.sail'), { recursive: true });
  const file = join(root, '.sail', 'project.yaml');
  writeFileSync(
    file,
    (await Bun.file(file).text()).replace('workspace: { use: fake }', 'workspace: { use: nonesuch }'),
  );
  const ports = await clonePorts(entryAt(), {});
  expect('refused' in ports ? ports.refused : ports).toContain("no built-in adapter 'nonesuch' fills workspace");
});
