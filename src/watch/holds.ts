// The machine-wide usage-limit hold, kept in `<machine dir>/holds/`. A usage limit belongs to an account, so one
// watcher reconciling it holds every watched workflow on the machine that reaches the same harness key.
//
// The harness key of a call is its harness's adapter (`use`), and for `pi` the provider of the model too, as in
// `pi:openai-codex`: the account a limit counts against. `harnessKeyOf` works it out from a run's header and roster,
// `harnessKeysOf` from a loaded workflow's agent steps. A call whose entry or model can't be found falls back to the
// default harness's key, so a hold is never lost.
//
// Two files per key, each named by `encodeURIComponent(key)`, written whole by a temp file and a rename:
// - `<key>.json`: `{ until, reason, runId, repository, at }`, a hold. A write keeps the later `until`.
// - `<key>.released.json`: `{ at }`, a release. A run suspended before `at` goes on at once.
// A missing or unreadable file counts as absent.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { aliasOf, type ProjectConfig } from '../engine/config';
import type { LoadedWorkflow } from '../engine/load-workflow';
import type { RosterEntry } from '../engine/roster';
import type { RunHeader } from '../engine/run-header';
import type { Step } from '../sdk/steps';

/** A usage-limit hold on one harness key. */
export interface MachineHold {
  /** ISO 8601, UTC: when the limit lets go. */
  until: string;
  reason: string;
  runId: string;
  /** The registry entry whose watcher found the limit. */
  repository: string;
  /** ISO 8601, UTC: when the hold was last written. */
  at: string;
}

/** Where the holds live, in `machine`. */
export function holdsDir(machine: string): string {
  return join(machine, 'holds');
}

const holdPath = (machine: string, key: string) => join(holdsDir(machine), `${encodeURIComponent(key)}.json`);
const releasePath = (machine: string, key: string) =>
  join(holdsDir(machine), `${encodeURIComponent(key)}.released.json`);

/** The key of the adapter `use`, with the provider of `model` for pi. */
function keyOf(use: string, model: string | undefined): string {
  if (use !== 'pi') return use;
  const provider = model?.split('/')[0];
  return provider === undefined || provider === '' || !model?.includes('/') ? use : `pi:${provider}`;
}

/**
 * The harness key the suspended call `callKey` (`stage#call`, `stage#call/step` or `intake#call`) ran on, from the run
 * header's roster. The default harness's key when the roster can't tell.
 */
export function harnessKeyOf(
  header: Pick<RunHeader, 'adapters' | 'intake' | 'stages'>,
  callKey: string | undefined,
): string {
  const fallback = header.adapters.harness.use;
  if (callKey === undefined) return fallback;
  const [call = '', step] = callKey.split('/');
  const stageName = call.split('#')[0] ?? '';
  const entry: RosterEntry | undefined = stageName === 'intake' ? header.intake : header.stages[stageName];
  if (entry === undefined) return fallback;
  const own = step === undefined ? undefined : entry.steps?.find((each) => each.step === step);
  const source = own ?? entry;
  const use = source.harness === undefined ? fallback : (header.adapters.harnesses?.[source.harness]?.use ?? fallback);
  return keyOf(use, source.model);
}

/** The harness keys the agent steps of `loaded` reach: sorted, each once. */
export function harnessKeysOf(loaded: LoadedWorkflow, config: Pick<ProjectConfig, 'models' | 'adapters'>): string[] {
  const definitions = [loaded.intake.definition, ...loaded.stages.map((stage) => stage.definition)];
  const keys = definitions.flatMap((definition) => {
    const steps: readonly Step[] =
      definition.kind === 'agent' || definition.kind === 'script' ? [definition] : (definition.steps ?? []);
    return steps.flatMap((step) => {
      if (step.kind !== 'agent') return [];
      const { model, harness } = aliasOf(config, step.model ?? 'default') ?? {};
      const use = harness === undefined ? undefined : config.adapters.harnesses?.[harness]?.use;
      return [keyOf(use ?? config.adapters.harness.use, model)];
    });
  });
  return [...new Set(keys)].sort();
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return typeof data === 'object' && data !== null ? data : undefined;
  } catch {
    return undefined;
  }
}

function writeAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, path);
}

/** The hold on `key`, or undefined when there is none. */
export function readHold(machine: string, key: string): MachineHold | undefined {
  const data = readJson(holdPath(machine, key));
  if (
    data === undefined ||
    typeof data.until !== 'string' ||
    Number.isNaN(Date.parse(data.until)) ||
    typeof data.reason !== 'string' ||
    typeof data.runId !== 'string' ||
    typeof data.repository !== 'string' ||
    typeof data.at !== 'string'
  ) {
    return undefined;
  }
  return data as unknown as MachineHold;
}

/**
 * Holds `key` until `hold.until`, or until the later `until` a hold already there names. A hold read at `since` (epoch
 * ms), when the key was released after it, writes nothing, so a release is never put back.
 */
export function writeHold(
  machine: string,
  key: string,
  hold: Pick<MachineHold, 'until' | 'reason' | 'runId' | 'repository'>,
  now: Date = new Date(),
  since?: number,
): void {
  if (since !== undefined && (releasedAt(machine, key) ?? Number.NEGATIVE_INFINITY) > since) return;
  const existing = readHold(machine, key);
  if (existing !== undefined && Date.parse(existing.until) >= Date.parse(hold.until)) return;
  writeAtomic(holdPath(machine, key), { ...hold, at: now.toISOString() });
}

/** The holds on `keys` that last past `now`, each with its key. */
export function activeHolds(machine: string, keys: readonly string[], now: Date): { key: string; hold: MachineHold }[] {
  return keys.flatMap((key) => {
    const hold = readHold(machine, key);
    return hold !== undefined && Date.parse(hold.until) > now.getTime() ? [{ key, hold }] : [];
  });
}

/** Records the release at `now`, then removes the hold on `key`. True when a hold was there. */
export function releaseHold(machine: string, key: string, now: Date): boolean {
  const held = existsSync(holdPath(machine, key));
  writeAtomic(releasePath(machine, key), { at: now.toISOString() });
  rmSync(holdPath(machine, key), { force: true });
  return held;
}

/** When `key` was last released, in epoch ms. */
export function releasedAt(machine: string, key: string): number | undefined {
  const at = readJson(releasePath(machine, key))?.at;
  const ms = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
}
