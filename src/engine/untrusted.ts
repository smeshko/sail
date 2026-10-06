// markUntrusted(): reads a schema beside a value and turns each string the schema marks into an `untrustedInput`, so the
// renderer wraps it wherever a template prints it. The walk follows the value, which is finite.
//
// The value is what the schema parsed. Most of a schema is shape: an object, a list or a wrapper puts what its children
// parsed where its shape says, so a string is marked where the schema that marks it sits. A schema that changes what it
// parsed breaks that: a transform, a codec, a coercion or an overwrite makes what it likes of its input, and no schema
// says which of the strings it made came from an untrusted one. So every string such a schema makes of input that holds
// an untrusted string is marked. That can mark a trusted string beside it, and never leaves an untrusted one bare.
//
// A check or a refinement is taken at its word, as one that checks: what its code does to the value it is handed, by
// assigning to it or reaching into it, is not seen here.
import { z } from 'zod';
import { isUntrusted } from '../sdk/untrusted';
import { isUntrustedInput, untrustedInput } from './render';

/**
 * What zod's `def` keeps, by `def.type`: probed on zod 4.6.5. test/engine/untrusted.test.ts reads every kind of schema
 * zod defines and the keys each keeps a schema under, and fails when one is missing here.
 */
interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: z.ZodType[];
  left?: z.ZodType;
  right?: z.ZodType;
  keyType?: z.ZodType;
  valueType?: z.ZodType;
  items?: z.ZodType[];
  rest?: z.ZodType | null;
  getter?: () => z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  /** A function schema's arguments and what it returns. */
  input?: z.ZodType;
  output?: z.ZodType;
  /** A codec's decoder: a pipe that has one changes what its `in` parsed, as a `transform` out does. */
  transform?: unknown;
  /** A template literal's parts: its fixed text, and the schemas of what goes between. */
  parts?: unknown[];
  /** Set on a schema that coerces: `z.coerce.string()` makes one string of whatever it is given. */
  coerce?: boolean;
  checks?: { _zod?: { def?: { check?: string } } }[];
}

const WRAPPERS = ['optional', 'nullable', 'default', 'prefault', 'catch', 'nonoptional', 'readonly'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Each own key of `value` with what it holds. Every one, enumerable or not: a template reaches any own key. */
function ownEntries(value: Record<string, unknown>): [string, unknown][] {
  return Object.getOwnPropertyNames(value).map((key) => [key, value[key]]);
}

/**
 * The schemas `def` holds, each read from the key zod keeps it under. Only those keys are read, never every value of
 * the `def`: a default's value is behind a getter that runs its factory, and an object's shape is its fields by name,
 * which may be any name at all.
 */
function heldBy(def: Def): z.ZodType[] {
  const held = [
    def.innerType,
    def.catchall,
    def.element,
    def.keyType,
    def.valueType,
    def.left,
    def.right,
    def.rest,
    def.in,
    def.out,
    def.input,
    def.output,
    // A lazy schema keeps its schema behind a function of its own, called for it alone.
    def.type === 'lazy' ? def.getter?.() : undefined,
    ...Object.values(def.shape ?? {}),
    ...(def.options ?? []),
    ...(def.items ?? []),
    ...(def.parts ?? []),
  ];
  // A template literal's parts hold text beside schemas, and the keys a `def` lacks are undefined. `$ZodType` is what
  // every schema is, of whichever of zod's flavours.
  return held.filter((schema): schema is z.ZodType => schema instanceof z.core.$ZodType);
}

/** Whether `schema` marks a string anywhere in it. `seen` holds the schemas already read: one may hold itself. */
function marksAny(schema: z.ZodType, seen = new Set<z.ZodType>()): boolean {
  if (isUntrusted(schema)) return true;
  if (seen.has(schema)) return false;
  seen.add(schema);
  return heldBy(schema.def as Def).some((held) => marksAny(held, seen));
}

/** Whether `def` has an overwrite: a check that puts a value of its own making in place of the one parsed. */
function overwrites(def: Def): boolean {
  return (def.checks ?? []).some((check) => check._zod?.def?.check === 'overwrite');
}

/**
 * Whether `schema`, or a schema anywhere in it, changes what it parsed: by a transform, a codec's decoder, a coercion
 * or an overwrite. What comes out of one that does no longer has the shape of what went in.
 */
function changesAny(schema: z.ZodType, seen = new Set<z.ZodType>()): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  const def = schema.def as Def;
  if (def.type === 'transform' || def.transform !== undefined || def.coerce === true || overwrites(def)) return true;
  return heldBy(def).some((held) => changesAny(held, seen));
}

/**
 * `value` with every string in it marked, however deep: in a list, and under each own key of an object of any kind,
 * which is where a template reaches. An object comes back as plain data, which is all a template reads of it.
 */
function markAll(value: unknown, source: string): unknown {
  if (typeof value === 'string') return untrustedInput(value, source);
  if (Array.isArray(value)) return value.map((item, index) => markAll(item, `${source}.${index}`));
  if (!isRecord(value) || isUntrustedInput(value)) return value;
  return Object.fromEntries(ownEntries(value).map(([key, item]) => [key, markAll(item, `${source}.${key}`)]));
}

/** `value` with each string marked where the shape of `schema`, whose `def` is `def`, says an untrusted one is. */
function markByShape(schema: z.ZodType, def: Def, value: unknown, source: string): unknown {
  const at = (key: string | number) => `${source}.${key}`;

  if (WRAPPERS.includes(def.type) && def.innerType !== undefined) return markUntrusted(def.innerType, value, source);

  switch (def.type) {
    case 'object':
      if (!isRecord(value)) return value;
      return Object.fromEntries(
        ownEntries(value).map(([key, item]) => {
          const own = def.shape !== undefined && Object.hasOwn(def.shape, key) ? def.shape[key] : def.catchall;
          return [key, own === undefined ? item : markUntrusted(own, item, at(key))];
        }),
      );
    case 'array':
      if (!Array.isArray(value) || def.element === undefined) return value;
      return value.map((item, index) => markUntrusted(def.element as z.ZodType, item, at(index)));
    case 'tuple':
      if (!Array.isArray(value)) return value;
      return value.map((item, index) => {
        const own = def.items?.[index] ?? def.rest;
        return own === undefined || own === null ? item : markUntrusted(own, item, at(index));
      });
    case 'record':
      if (!isRecord(value) || def.valueType === undefined) return value;
      return Object.fromEntries(
        ownEntries(value).map(([key, item]) => [key, markUntrusted(def.valueType as z.ZodType, item, at(key))]),
      );
    case 'union':
      return (def.options ?? []).reduce<unknown>((marked, option) => markUntrusted(option, marked, source), value);
    case 'intersection':
      return markUntrusted(def.right as z.ZodType, markUntrusted(def.left as z.ZodType, value, source), source);
    case 'lazy':
      return markUntrusted((def.getter as () => z.ZodType)(), value, source);
    case 'template_literal':
      // One string made of its parts: no part of it can be marked alone.
      return typeof value === 'string' && marksAny(schema) ? untrustedInput(value, source) : value;
    case 'pipe': {
      const [from, into] = [def.in as z.ZodType, def.out as z.ZodType];
      const marked = markUntrusted(into, markUntrusted(from, value, source), source);
      // `into` parsed what `from` gave it. Where it changes nothing, each string is still where `from` says it is.
      // Where it changes anything, at any depth, or the pipe is a codec, part of the value is whatever a function made
      // of `from`'s strings.
      const changed = def.transform !== undefined || changesAny(into);
      return changed && marksAny(from) ? markAll(marked, source) : marked;
    }
    default:
      return value;
  }
}

/** `value` with each string `schema` marks as untrusted input from `source`. `value` itself is not changed. */
export function markUntrusted(schema: z.ZodType, value: unknown, source: string): unknown {
  if (value === null || value === undefined || isUntrustedInput(value)) return value;
  if (isUntrusted(schema)) return typeof value === 'string' ? untrustedInput(value, source) : value;

  const def = schema.def as Def;
  const marked = markByShape(schema, def, value, source);
  // An overwrite put a value of its own in place of the one this schema parsed, so a string is no longer where the
  // schema's shape says it is.
  return overwrites(def) && marksAny(schema) ? markAll(marked, source) : marked;
}
