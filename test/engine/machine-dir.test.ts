import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { machineDir } from '../../src/engine/machine-dir';
import { withTempRepo } from '../helpers/temp-repo';

test('machineDir is SAIL_HOME when set', async () => {
  await withTempRepo(async (repo) => {
    expect(machineDir({ SAIL_HOME: repo.dir })).toBe(repo.dir);
  });
});

test('machineDir is ~/.sail when SAIL_HOME is unset', async () => {
  await withTempRepo(async () => {
    expect(machineDir({})).toBe(join(homedir(), '.sail'));
  });
});

test('machineDir is ~/.sail when SAIL_HOME is empty', async () => {
  await withTempRepo(async () => {
    expect(machineDir({ SAIL_HOME: '' })).toBe(join(homedir(), '.sail'));
  });
});
