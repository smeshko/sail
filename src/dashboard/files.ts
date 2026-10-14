// What the dashboard reads. A stub: the signatures are final, and it finds nothing until ADW-120's third task.

import type { Source } from '../engine/run-dir';
import type { RunListing } from '../engine/runs';
import type { Summary } from '../events/summary';
import type { RegistryEntry, RegistryProblem } from '../watch/registry';

/** A registered repository, with `problem` when its `.sail/` is gone. */
export type Repo = RegistryEntry & { problem?: string };

/** One run as the dashboard lists it: `sail runs`' listing, its source, and its summary or null. */
export type RunItem = Omit<RunListing, 'dir'> & { source?: Source; summary: Summary | null };

/** A repository with its runs: what the index stream sends. */
export type IndexRepo = Repo & { runs: RunItem[] };

/** The files of a call the dashboard serves. */
export const CALL_FILES = ['result.json', 'session.log', 'stdout.log', 'stderr.log'] as const;
export type CallFileName = (typeof CALL_FILES)[number];

export function inside(_dir: string, _path: string): boolean {
  return false;
}

export function repos(_registryDir: string): { repos: Repo[]; problems: RegistryProblem[] } {
  return { repos: [], problems: [] };
}

export function findRepo(_registryDir: string, _name: string): RegistryEntry | undefined {
  return undefined;
}

export function runItems(_entry: RegistryEntry): RunItem[] {
  return [];
}

export function index(_registryDir: string): IndexRepo[] {
  return [];
}

export function findRunDir(_entry: RegistryEntry, _runId: string): string | { missing: string } {
  return { missing: '' };
}

export function callFile(_runDir: string, _key: string, _name: string): string | { missing: string } {
  return { missing: '' };
}
