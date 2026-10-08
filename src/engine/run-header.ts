// run.json, the run header: what a run was asked to do, written once when it starts and never changed. It is built and
// validated before the run directory exists, so a header that breaks `sail.run.v1` never reaches disk and a refusal
// leaves nothing behind. Resume and budget raises only ever read it.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import type { TicketState } from '../ports/types';
import type { Port, ProjectConfig } from './config';
import { createFileOnce } from './durable';
import type { LoadedWorkflow } from './load-workflow';
import { buildRoster, type IntakeEntry, origin, type RosterEntry } from './roster';
import type { Source } from './run-dir';
import { formatIssue, type SchemaIssue, validateDocument } from './schemas';

export const RUN_HEADER_FILE = 'run.json';

/** Which adapter fills a port, where it comes from, and the versions it runs with when it declares any. */
export interface AdapterEntry {
  use: string;
  origin: string;
  versions?: Record<string, string>;
}

/** What a run's start did to its ticket: whether the claim took, and the state the provider reported after sail's move. */
export interface ClaimRecord {
  claimed: boolean;
  state: TicketState;
}

/** The `sail.run.v1` fields a run header holds when the run starts. */
export interface RunHeader {
  schema: 'sail.run.v1';
  runId: string;
  source: Source;
  claim: ClaimRecord;
  workflow: { name: string; version: number; origin: string; sha256: string };
  sail: { version: string; runtime: string };
  adapters: Record<Port, AdapterEntry>;
  intake: IntakeEntry;
  stages: Record<string, RosterEntry>;
  budget?: { maxUsd?: number; maxMinutes?: number };
  startedAt: string;
}

const sha256 = (data: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(data).digest('hex');

const EVERY_FILE = new Bun.Glob('**/*');

/** Every file under `dir`, dotfiles included, absolute. */
const filesUnder = (dir: string) =>
  [...EVERY_FILE.scanSync({ cwd: dir, dot: true, onlyFiles: true })].map((file) => join(dir, file));

/**
 * The sha256 of everything the run executes: the `.sail/` files in the workflow's import graph, every file in each
 * roster stage's folder, where its prompts and scripts live, and the intake's file or folder unless it is built in.
 * Each file is hashed, then the sorted lines `<path>\0<sha256>\n` are. Paths are relative to `.sail/`, so a clone and a
 * worktree hash alike. It reads bytes from disk, never modules, so Bun's module cache can't make it stale.
 */
export function workflowHash(sailDir: string, loaded: LoadedWorkflow): string {
  const files = new Set(loaded.files);
  for (const stage of loaded.stages) for (const file of filesUnder(stage.dir)) files.add(file);
  const intake = loaded.intake.path;
  if (intake !== undefined) {
    for (const file of statSync(intake).isDirectory() ? filesUnder(intake) : [intake]) files.add(file);
  }
  const lines = [...files]
    .filter((file) => file.startsWith(`${sailDir}${sep}`))
    .map((file) => ({ file, path: relative(sailDir, file).split(sep).join('/') }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ file, path }) => `${path}\0${sha256(readFileSync(file))}\n`);
  return sha256(lines.join(''));
}

export interface HeaderFields {
  runId: string;
  source: Source;
  claim: ClaimRecord;
  sailDir: string;
  loaded: LoadedWorkflow;
  config: ProjectConfig;
  adapters: Record<Port, AdapterEntry>;
  now: Date;
}

/** The header of a run of `loaded` starting at `now`. A workflow without a `version` is version 1. */
export function buildRunHeader(fields: HeaderFields): RunHeader {
  const { runId, source, claim, sailDir, loaded, config, adapters, now } = fields;
  const base = dirname(sailDir);
  const { intake, stages } = buildRoster(loaded, config, base);
  const budget = config.budgets.run;
  return {
    schema: 'sail.run.v1',
    runId,
    source: { ...source, forced: [...source.forced] },
    claim: { claimed: claim.claimed, state: { ...claim.state } },
    workflow: {
      name: loaded.name,
      version: loaded.workflow.version ?? 1,
      origin: origin(base, loaded.dir),
      sha256: workflowHash(sailDir, loaded),
    },
    sail: { version: pkg.version, runtime: `bun ${Bun.version}` },
    adapters,
    intake,
    stages,
    ...(budget !== undefined && Object.keys(budget).length > 0 ? { budget } : {}),
    startedAt: now.toISOString(),
  };
}

/** Every way `header` breaks `sail.run.v1`. */
export function validateRunHeader(header: unknown): SchemaIssue[] {
  return validateDocument('sail.run.v1', header);
}

/** Throws unless `header` validates against `sail.run.v1`. One that doesn't is a bug in sail, never a refusal. */
export function assertRunHeader(header: RunHeader): void {
  const issues = validateRunHeader(header);
  if (issues.length > 0) {
    throw new Error(`run.json breaks sail.run.v1, a bug in sail:\n${issues.map(formatIssue).join('\n')}`);
  }
}

/**
 * Writes `run.json` into `runDir` once, synced, then sets it read-only. A header that breaks `sail.run.v1` throws
 * before anything is written, and so does an existing `run.json`, with `EEXIST`.
 */
export function writeRunHeader(runDir: string, header: RunHeader): void {
  assertRunHeader(header);
  createFileOnce(join(runDir, RUN_HEADER_FILE), `${JSON.stringify(header, null, 2)}\n`, 0o444);
}

/** Reads `run.json` from `runDir`, which must validate against `sail.run.v1`. It never writes. */
export function readRunHeader(runDir: string): RunHeader {
  const path = join(runDir, RUN_HEADER_FILE);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${path} is not valid JSON: ${error.message}`);
    throw error;
  }
  const issues = validateRunHeader(data);
  if (issues.length > 0) throw new Error(`${path} breaks sail.run.v1:\n${issues.map(formatIssue).join('\n')}`);
  return data as RunHeader;
}
