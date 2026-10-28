// run.json, the run header: what a run was asked to do, written once when it starts and never changed. It is built and
// validated before the run directory exists, so a header that breaks `sail.run.v1` never reaches disk and a refusal
// leaves nothing behind. Resume and budget raises only ever read it.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import type { TicketState } from '../ports/types';
import { runBudgetOf } from './budget';
import type { ProjectConfig, RunPort } from './config';
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

/** What a claim did to its ticket: whether the claim took, and the state the provider reported after sail's move. */
export interface ClaimRecord {
  claimed: boolean;
  state: TicketState;
}

/** The `sail.run.v1` fields a run header holds when the run starts. */
export interface RunHeader {
  schema: 'sail.run.v1';
  runId: string;
  source: Source;
  /** The run a seeded run reused calls from. */
  fromRun?: string;
  /** What the start did to the ticket. Only runs from before the claim moved into `intake#1` have it: they recorded it here. */
  claim?: ClaimRecord;
  workflow: { name: string; version: number; origin: string; sha256: string };
  sail: { version: string; runtime: string };
  adapters: Record<RunPort, AdapterEntry> & {
    /** The named harnesses the run reached. Absent when it reached none. */
    harnesses?: Record<string, AdapterEntry>;
  };
  intake: IntakeEntry;
  stages: Record<string, RosterEntry>;
  budget?: { maxUsd?: number; maxMinutes?: number };
  startedAt: string;
  /** The run's branch, named once at its start. A run from before workspaces has none. */
  branch?: string;
  /** The repository the workspace was made from, and the base it started at. */
  repository?: { url: string; defaultBranch: string; baseSha: string };
  /** The workspace, relative to the run directory. */
  workspace?: string;
}

/** What a run's workspace adds to its header. */
export interface HeaderWorkspace {
  branch: string;
  repository: { url: string; defaultBranch: string };
  baseSha: string;
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
  /** The run a seeded run reused calls from. */
  fromRun?: string;
  sailDir: string;
  loaded: LoadedWorkflow;
  config: ProjectConfig;
  adapters: Record<RunPort, AdapterEntry>;
  /** The named harnesses the run reached, which the header records beside the ports. Left out when empty. */
  harnesses?: Record<string, AdapterEntry>;
  now: Date;
  /** The run's workspace, once it exists. Left out, the header holds no `branch`, `repository` or `workspace`. */
  workspace?: HeaderWorkspace;
}

/** The header fields of `workspace`, in the order `run.json` holds them. */
export function workspaceFields(
  workspace: HeaderWorkspace,
): Required<Pick<RunHeader, 'branch' | 'repository' | 'workspace'>> {
  const { branch, repository, baseSha } = workspace;
  return {
    branch,
    repository: { url: repository.url, defaultBranch: repository.defaultBranch, baseSha },
    workspace: 'workspace',
  };
}

/** The header of a run of `loaded` starting at `now`. A workflow without a `version` is version 1. */
export function buildRunHeader(fields: HeaderFields): RunHeader {
  const { runId, source, fromRun, sailDir, loaded, config, adapters, harnesses: named, now } = fields;
  const base = dirname(sailDir);
  const { intake, stages } = buildRoster(loaded, config, base);
  const budget = runBudgetOf(config.budgets.run, loaded.workflow.budget);
  return {
    schema: 'sail.run.v1',
    runId,
    source: { ...source, forced: [...source.forced] },
    ...(fromRun === undefined ? {} : { fromRun }),
    workflow: {
      name: loaded.name,
      version: loaded.workflow.version ?? 1,
      origin: origin(base, loaded.dir),
      sha256: workflowHash(sailDir, loaded),
    },
    sail: { version: pkg.version, runtime: `bun ${Bun.version}` },
    adapters: { ...adapters, ...(named === undefined || Object.keys(named).length === 0 ? {} : { harnesses: named }) },
    intake,
    stages,
    ...(budget === undefined ? {} : { budget }),
    startedAt: now.toISOString(),
    ...(fields.workspace === undefined ? {} : workspaceFields(fields.workspace)),
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
