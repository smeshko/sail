// markUntrusted(): reads a schema beside a value and turns each string the schema marks into an `untrustedInput`, so the
// renderer wraps it wherever a template prints it. The walk follows the value, which is finite.
//
// The value is what the schema parsed, so a transform has already run, and its output has whatever shape it was given:
// no schema says which of its strings came from an untrusted one. So every string a transform makes of input that holds
// an untrusted string is marked. That can mark a trusted string beside it, and never leaves an untrusted one bare.
import type { z } from 'zod';
import { isUntrusted } from '../sdk/untrusted';
import { isUntrustedInput, untrustedInput } from './render';

/** The children zod's `def` keeps, by `def.type`: probed on zod 4.6.5. */
interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: z.ZodType[];
  left?: z.ZodType;
  right?: z.ZodType;
  valueType?: z.ZodType;
  items?: z.ZodType[];
  rest?: z.ZodType | null;
  getter?: () => z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  /** A codec's decoder: a pipe that has one transforms what its `in` parsed, as a `transform` out does. */
  transform?: unknown;
  /** A template literal's parts: its fixed text, and the schemas of what goes between. */
  parts?: unknown[];
}

const WRAPPERS = ['optional', 'nullable', 'default', 'prefault', 'catch', 'nonoptional', 'readonly'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isSchema = (part: unknown): part is z.ZodType => isRecord(part) && 'def' in part;

/** Whether `schema` marks a string anywhere in it. `seen` holds the schemas already read: one may hold itself. */
function marksAny(schema: z.ZodType, seen = new Set<z.ZodType>()): boolean {
  if (isUntrusted(schema)) return true;
  if (seen.has(schema)) return false;
  seen.add(schema);
  const def = schema.def as Def;
  const children = [
    def.innerType,
    def.catchall,
    def.element,
    def.valueType,
    def.left,
    def.right,
    def.rest,
    def.in,
    def.out,
    def.getter?.(),
    ...Object.values(def.shape ?? {}),
    ...(def.options ?? []),
    ...(def.items ?? []),
    ...(def.parts ?? []).filter(isSchema),
  ];
  return children.some((child) => child !== undefined && child !== null && marksAny(child, seen));
}

/**
 * `value` with every string in it marked, however deep: in a list, and under each own key of an object of any kind,
 * which is where a template reaches. An object comes back as plain data, which is all a template reads of it.
 */
function markAll(value: unknown, source: string): unknown {
  if (typeof value === 'string') return untrustedInput(value, source);
  if (Array.isArray(value)) return value.map((item, index) => markAll(item, `${source}.${index}`));
  if (!isRecord(value) || isUntrustedInput(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, markAll(item, `${source}.${key}`)]));
}

/** `value` with each string `schema` marks as untrusted input from `source`. `value` itself is not changed. */
export function markUntrusted(schema: z.ZodType, value: unknown, source: string): unknown {
  if (value === null || value === undefined || isUntrustedInput(value)) return value;
  if (isUntrusted(schema)) return typeof value === 'string' ? untrustedInput(value, source) : value;

  const def = schema.def as Def;
  const at = (key: string | number) => `${source}.${key}`;

  if (WRAPPERS.includes(def.type) && def.innerType !== undefined) return markUntrusted(def.innerType, value, source);

  switch (def.type) {
    case 'object': {
      if (!isRecord(value)) return value;
      const out: Record<string, unknown> = { ...value };
      for (const key of Object.keys(value)) {
        const own = def.shape !== undefined && Object.hasOwn(def.shape, key) ? def.shape[key] : def.catchall;
        if (own !== undefined) out[key] = markUntrusted(own, value[key], at(key));
      }
      return out;
    }
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
        Object.entries(value).map(([key, item]) => [key, markUntrusted(def.valueType as z.ZodType, item, at(key))]),
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
      const marked = markUntrusted(def.out as z.ZodType, markUntrusted(def.in as z.ZodType, value, source), source);
      const transformed = (def.out as z.ZodType).def.type === 'transform' || def.transform !== undefined;
      return transformed && marksAny(def.in as z.ZodType) ? markAll(marked, source) : marked;
    }
    default:
      return value;
  }
}
