// Bindings, from what a caller supplies to what a call reads: each is checked against the step's `consumes`, then
// materialised into `$STAGE_IN`. A file is copied under its declared name, and a value is written as `<name>.json`, or
// as `<name>.txt` when it is a string. The script finds each one through its `INPUT_<NAME>` variable.
import { copyFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Binding, Consumes } from '../sdk/bindings';

/**
 * What a caller supplies for one binding. `path` is absolute. `from` is where it came from, as `result.json`'s
 * `consumed` records it.
 */
export type Supplied = { kind: 'file'; path: string; from: string } | { kind: 'value'; value: unknown; from: string };

/** `INPUT_` and the binding's name, upper-cased, with anything outside `[A-Z0-9]` turned into `_`. */
export function inputVar(name: string): string {
  return `INPUT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

type Checked = { ok: true; data: unknown } | { ok: false; message: string };

/** Parses a supplied value with its binding's schema. The parsed value, defaults and transforms applied, is written. */
function checkValue(binding: Binding & { kind: 'value' }, data: unknown): Checked {
  const parsed = binding.schema.safeParse(data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: z.prettifyError(parsed.error) };
}

/** One binding as it will be written: under `name` in `$STAGE_IN`, a copy of a file or some text. */
interface Planned {
  key: string;
  name: string;
  write: { copy: string } | { text: string };
}

/** Checks every binding and plans what each writes, without writing anything. */
function plan(consumes: Consumes, supplied: Readonly<Record<string, Supplied>>) {
  const problems: string[] = [];
  const planned: Planned[] = [];
  for (const key of Object.keys(supplied)) {
    if (!Object.hasOwn(consumes, key)) problems.push(`'${key}' is not a binding of this stage`);
  }
  for (const [key, binding] of Object.entries(consumes)) {
    const given = Object.hasOwn(supplied, key) ? supplied[key] : undefined;
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
      else planned.push({ key, name: binding.name, write: { copy: given.path } });
    } else if (binding.kind === 'value' && given.kind === 'value') {
      const checked = checkValue(binding, given.value);
      if (!checked.ok) problems.push(`'${key}': ${checked.message}`);
      else if (typeof checked.data === 'string')
        planned.push({ key, name: `${key}.txt`, write: { text: checked.data } });
      else planned.push({ key, name: `${key}.json`, write: { text: `${JSON.stringify(checked.data, null, 2)}\n` } });
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
    if (!/^[^/\\]+$/.test(name) || name === '.' || name === '..') {
      problems.push(`'${key}' would be written to $STAGE_IN as '${name}', which is not a plain file name`);
    } else if (first !== undefined) {
      problems.push(`'${first}' and '${key}' are both written to $STAGE_IN as '${name}'`);
    } else byName.set(name, key);
  }
  return { problems, planned };
}

/** Every problem with what was supplied for `consumes`, one message each. Nothing is written. */
export function bindingProblems(consumes: Consumes, supplied: Readonly<Record<string, Supplied>>): string[] {
  return plan(consumes, supplied).problems;
}

/**
 * Writes each supplied binding into `stageIn`. Returns the `INPUT_<NAME>` variables, pointing at what was written, and
 * `consumed`: where each binding came from, or null for an optional one left unbound. Callers check `bindingProblems`
 * first: any problem throws here, before anything is written.
 */
export function materialise(
  consumes: Consumes,
  supplied: Readonly<Record<string, Supplied>>,
  stageIn: string,
): { inputs: Record<string, string>; consumed: Record<string, string | null> } {
  const { problems, planned } = plan(consumes, supplied);
  if (problems.length > 0) throw new Error(`bindings can't be materialised:\n${problems.join('\n')}`);
  const inputs: Record<string, string> = {};
  const consumed: Record<string, string | null> = Object.fromEntries(Object.keys(consumes).map((key) => [key, null]));
  for (const { key, name, write } of planned) {
    const path = join(stageIn, name);
    if ('copy' in write) copyFileSync(write.copy, path);
    else writeFileSync(path, write.text);
    inputs[inputVar(key)] = path;
    consumed[key] = supplied[key]?.from ?? null;
  }
  return { inputs, consumed };
}
