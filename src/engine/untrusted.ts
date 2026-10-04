// markUntrusted(): reads a schema beside a value and turns each string the schema marks into an `untrustedInput`, so the
// renderer wraps it wherever a template prints it. The walk follows the value, which is finite.
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
}

const WRAPPERS = ['optional', 'nullable', 'default', 'prefault', 'catch', 'nonoptional', 'readonly'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    case 'pipe':
      return markUntrusted(def.out as z.ZodType, markUntrusted(def.in as z.ZodType, value, source), source);
    default:
      return value;
  }
}
