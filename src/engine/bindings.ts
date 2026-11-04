// Bindings, from what a caller supplies to what a call reads: each is checked against the step's `consumes`, then
// materialised into `$STAGE_IN`. A file is copied under its declared name, and a value is written as `<name>.json`, or
// as `<name>.txt` when it is a string. A gitDiff binding is the run's patch, which only the engine supplies, from the
// run's workspace: it is written as `<name>.patch`. A fromStep binding is what an earlier step of the same stage left,
// which only the engine supplies too: its output, or a field of it, written as a value is, or a file it produced,
// copied under that file's name. The script finds each one through its `INPUT_<NAME>` variable.
//
// A bound file brings the `attachments/` folder beside its source with it, when there is one: the ticket intake
// downloads a ticket's files there, and the brief names each as `attachments/<file>`, so the paths resolve beside the
// brief in `$STAGE_IN`, the one place outside the workspace a step may read.
import { copyFileSync, cpSync, lstatSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Binding, Consumes } from '../sdk/bindings';
import { isPlainName } from './call-dir';

/**
 * What a caller supplies for one binding. `path` is absolute. `from` is where it came from, as `result.json`'s
 * `consumed` records it. A `gitDiff` is the run's patch, which only the engine supplies.
 */
export type Supplied =
  | { kind: 'file'; path: string; from: string }
  | { kind: 'value'; value: unknown; from: string }
  | { kind: 'gitDiff'; patch: string; from: string }
  /** An earlier step's output, or a field of it: no schema checks it, since the step's own already did. */
  | { kind: 'fromStep'; value: unknown; from: string }
  /** A file an earlier step produced. */
  | { kind: 'fromStep'; path: string; from: string };

/** `INPUT_` and the binding's name, upper-cased, with anything outside `[A-Z0-9]` turned into `_`. */
export function inputVar(name: string): string {
  return `INPUT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** The names a binding may be written under in `$STAGE_IN`: a value's depends on its data, so it may take either. */
function namesOf(key: string, binding: Binding): string[] {
  if (binding.kind === 'file') return [binding.name];
  if (binding.kind === 'gitDiff') return [`${key}.patch`];
  if (binding.kind === 'fromStep' && binding.file !== undefined) return [binding.file];
  return [`${key}.txt`, `${key}.json`];
}

/**
 * What would collide when `consumes` is materialised, whatever is supplied: two bindings giving one `INPUT_` variable,
 * or two that may be written under one name. A step of a multi-step stage is checked with it at load, before it runs.
 */
export function collisionProblems(consumes: Consumes): string[] {
  const problems: string[] = [];
  const byVar = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const [key, binding] of Object.entries(consumes)) {
    const first = byVar.get(inputVar(key));
    if (first === undefined) byVar.set(inputVar(key), key);
    else problems.push(`'${first}' and '${key}' both give ${inputVar(key)}`);
    for (const name of namesOf(key, binding)) {
      const taken = byName.get(name);
      if (taken === undefined) byName.set(name, key);
      else if (taken !== key) problems.push(`'${taken}' and '${key}' are both written to $STAGE_IN as '${name}'`);
    }
  }
  return problems;
}

type Checked = { ok: true; data: unknown } | { ok: false; message: string };

/** Parses a supplied value with its binding's schema. The parsed value, defaults and transforms applied, is written. */
function checkValue(binding: Binding & { kind: 'value' }, data: unknown): Checked {
  const parsed = binding.schema.safeParse(data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: z.prettifyError(parsed.error) };
}

/** The folder a bound file brings from beside its source, copied into `$STAGE_IN` under the same name. */
export const ATTACHMENTS = 'attachments';

/** The `attachments/` folder beside a bound file's source, when there is one. */
function attachmentsBeside(path: string): string | undefined {
  const folder = join(dirname(path), ATTACHMENTS);
  return statSync(folder, { throwIfNoEntry: false })?.isDirectory() ? folder : undefined;
}

/** One binding as it will be written: under `name` in `$STAGE_IN`, a copy of a file or some text. */
interface Planned {
  key: string;
  name: string;
  write: { copy: string } | { text: string };
}

/** A value as `$STAGE_IN` holds it: `<key>.txt` for a string, `<key>.json` for anything else. */
function asText(key: string, data: unknown): Omit<Planned, 'key'> {
  if (typeof data === 'string') return { name: `${key}.txt`, write: { text: data } };
  return { name: `${key}.json`, write: { text: `${JSON.stringify(data, null, 2)}\n` } };
}

/** Checks every binding and plans what each writes, without writing anything. `values` holds each parsed value. */
function plan(consumes: Consumes, supplied: Readonly<Record<string, Supplied>>) {
  const problems: string[] = [];
  const planned: Planned[] = [];
  // Entries, not assignment: `values['__proto__'] = …` would set the prototype.
  const values: [string, unknown][] = [];
  /** The attachments folder the bound files bring, with the first binding that brought it. */
  let folder: { key: string; from: string } | undefined;
  for (const key of Object.keys(supplied)) {
    if (!Object.hasOwn(consumes, key)) problems.push(`'${key}' is not a binding of this stage`);
  }
  for (const [key, binding] of Object.entries(consumes)) {
    const given = Object.hasOwn(supplied, key) ? supplied[key] : undefined;
    if (binding.kind === 'gitDiff' && given?.kind === 'gitDiff') {
      planned.push({ key, name: `${key}.patch`, write: { text: given.patch } });
      continue;
    }
    if (binding.kind === 'fromStep' && given?.kind === 'fromStep') {
      if ('path' in given) planned.push({ key, name: binding.file ?? key, write: { copy: given.path } });
      else {
        values.push([key, given.value]);
        planned.push({ key, ...asText(key, given.value) });
      }
      continue;
    }
    // An optional fromStep the earlier step had nothing for is bound to nothing, as an optional value left out is.
    if (binding.kind === 'fromStep' && given === undefined && binding.isOptional) continue;
    if (binding.kind === 'gitDiff' || binding.kind === 'fromStep') {
      problems.push(`'${key}' is a ${binding.kind} binding, which can't be supplied here`);
      continue;
    }
    if (given === undefined) {
      if (!binding.isOptional) problems.push(`'${key}' is required`);
      continue;
    }
    if (given.kind !== binding.kind) {
      problems.push(`'${key}' is a ${binding.kind} binding, but a ${given.kind} was supplied`);
      continue;
    }
    if (binding.kind === 'file' && given.kind === 'file') {
      const stat = statSync(given.path, { throwIfNoEntry: false });
      if (stat === undefined) problems.push(`'${key}': no file at ${given.path}`);
      else if (!stat.isFile()) problems.push(`'${key}': ${given.path} is not a regular file`);
      else {
        planned.push({ key, name: binding.name, write: { copy: given.path } });
        const beside = attachmentsBeside(given.path);
        if (beside !== undefined && folder === undefined) folder = { key, from: beside };
        else if (beside !== undefined && folder !== undefined && folder.from !== beside) {
          problems.push(`'${folder.key}' and '${key}' both bring an ${ATTACHMENTS}/ folder, from different places`);
        }
      }
    } else if (binding.kind === 'value' && given.kind === 'value') {
      const checked = checkValue(binding, given.value);
      if (!checked.ok) {
        problems.push(`'${key}': ${checked.message}`);
        continue;
      }
      values.push([key, checked.data]);
      planned.push({ key, ...asText(key, checked.data) });
    }
  }

  const byVar = new Map<string, string>();
  for (const key of Object.keys(consumes)) {
    const first = byVar.get(inputVar(key));
    if (first === undefined) byVar.set(inputVar(key), key);
    else problems.push(`'${first}' and '${key}' both give ${inputVar(key)}`);
  }
  const byName = new Map<string, string>();
  for (const { key, name } of planned) {
    const first = byName.get(name);
    if (!isPlainName(name)) {
      problems.push(`'${key}' would be written to $STAGE_IN as '${name}', which is not a plain file name`);
    } else if (first !== undefined) {
      problems.push(`'${first}' and '${key}' are both written to $STAGE_IN as '${name}'`);
    } else byName.set(name, key);
  }
  if (folder !== undefined && byName.has(ATTACHMENTS)) {
    problems.push(
      `'${byName.get(ATTACHMENTS)}' is written to $STAGE_IN as '${ATTACHMENTS}', where '${folder.key}' brings its ${ATTACHMENTS}/ folder`,
    );
  }
  return { problems, planned, values: Object.fromEntries(values), folder: folder?.from };
}

/** Every problem with what was supplied for `consumes`, one message each. Nothing is written. */
export function bindingProblems(consumes: Consumes, supplied: Readonly<Record<string, Supplied>>): string[] {
  return plan(consumes, supplied).problems;
}

/** A call's bindings, checked and parsed once, for `$STAGE_IN` and an agent's prompt to share. */
export interface PreparedBindings {
  readonly consumes: Consumes;
  readonly supplied: Readonly<Record<string, Supplied>>;
  /** Each supplied value binding's data as its schema parsed it, defaults and transforms applied, by binding name. */
  readonly values: Readonly<Record<string, unknown>>;
  /** What each supplied binding writes into `$STAGE_IN`. */
  readonly planned: readonly Planned[];
  /** The `attachments/` folder a bound file brings, copied into `$STAGE_IN` beside it. */
  readonly folder?: string | undefined;
}

/**
 * Checks and parses what was supplied for `consumes`, without writing anything. Callers check `bindingProblems` first:
 * any problem throws here.
 */
export function prepareBindings(consumes: Consumes, supplied: Readonly<Record<string, Supplied>>): PreparedBindings {
  const { problems, planned, values, folder } = plan(consumes, supplied);
  if (problems.length > 0) throw new Error(`bindings can't be materialised:\n${problems.join('\n')}`);
  return { consumes, supplied, values, planned, folder };
}

/**
 * Writes prepared bindings into `stageIn`, without parsing a value again. Returns the `INPUT_<NAME>` variables, pointing
 * at what was written, and `consumed`: where each binding came from, or null for an optional one left unbound.
 */
export function materialisePrepared(
  prepared: PreparedBindings,
  stageIn: string,
): { inputs: Record<string, string>; consumed: Record<string, string | null> } {
  const inputs: Record<string, string> = {};
  const consumed: Record<string, string | null> = Object.fromEntries(
    Object.keys(prepared.consumes).map((key) => [key, null]),
  );
  for (const { key, name, write } of prepared.planned) {
    const path = join(stageIn, name);
    if ('copy' in write) copyFileSync(write.copy, path);
    else writeFileSync(path, write.text);
    inputs[inputVar(key)] = path;
    consumed[key] = prepared.supplied[key]?.from ?? null;
  }
  // Only regular files and folders: a link could lead the step to something outside what it was given.
  if (prepared.folder !== undefined) {
    cpSync(prepared.folder, join(stageIn, ATTACHMENTS), {
      recursive: true,
      filter: (source) => {
        const stat = lstatSync(source);
        return stat.isFile() || stat.isDirectory();
      },
    });
  }
  return { inputs, consumed };
}

/**
 * Writes each supplied binding into `stageIn`, as `materialisePrepared()` does. Callers check `bindingProblems` first:
 * any problem throws here, before anything is written.
 */
export function materialise(
  consumes: Consumes,
  supplied: Readonly<Record<string, Supplied>>,
  stageIn: string,
): { inputs: Record<string, string>; consumed: Record<string, string | null> } {
  return materialisePrepared(prepareBindings(consumes, supplied), stageIn);
}
