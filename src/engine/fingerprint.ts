// Binding fingerprints: what the determinism guard compares, beside the journal's keys. Each call's line records one
// short hash per binding the workflow supplied, so a replay that binds other values or files than the journaled call
// had (`Date.now()`, randomness, two calls of one stage swapped) is caught instead of reusing the journaled result.
//
// A value binding is hashed by its canonical JSON, a file binding by the run-relative path it names, never by its
// contents. A `gitDiff` or `fromStep` binding is the engine's to supply, and a workspace diff legitimately changes on
// replay, so neither is fingerprinted.
import { createHash } from 'node:crypto';
import type { Supplied } from './bindings';

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `JSON.stringify` with the keys of every object sorted. Throws what `JSON.stringify` throws, such as on a cycle. */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, each: unknown) =>
    isPlain(each) ? Object.fromEntries(Object.entries(each).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : each,
  );
  return text ?? 'undefined';
}

const short = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** One hash per value and file binding, by name. The input is prefixed by its kind, so no value collides with a path. */
export function fingerprintBindings(supplied: Readonly<Record<string, Supplied>>): Record<string, string> {
  const hashes = new Map<string, string>();
  for (const [name, each] of Object.entries(supplied)) {
    if (each.kind === 'value') hashes.set(name, short(`value:${canonicalJson(each.value)}`));
    else if (each.kind === 'file') hashes.set(name, short(`file:${each.from}`));
  }
  return Object.fromEntries(hashes);
}

/** The bindings that changed, appeared or went since the journaled call, in that order and by name, or undefined. */
export function bindingChanges(journaled: Record<string, string>, asked: Record<string, string>): string | undefined {
  const names = (keep: (name: string) => boolean, of: Record<string, string>) => Object.keys(of).filter(keep).sort();
  const has = (of: Record<string, string>) => (name: string) => Object.hasOwn(of, name);
  const changed = names((name) => has(journaled)(name) && journaled[name] !== asked[name], asked);
  const appeared = names((name) => !has(journaled)(name), asked);
  const went = names((name) => !has(asked)(name), journaled);
  const parts = [
    ...changed.map((name) => `'${name}' changed`),
    ...appeared.map((name) => `'${name}' appeared`),
    ...went.map((name) => `'${name}' went`),
  ];
  return parts.length === 0 ? undefined : parts.join(', ');
}
