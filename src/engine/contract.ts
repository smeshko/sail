// The contract checks every step kind shares: its output against its schema, and its declared files in `$STAGE_OUT`.
// Each problem is a `ContractError`, which `result.json` lists under `errors` when the outcome is `error`.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Produces } from '../sdk/steps';
import { runRelative } from './call-dir';

/** Why an outcome is `error`, as `sail.result.v1` names the reasons. */
export type ErrorReason =
  | 'invalid_output'
  | 'missing_file'
  | 'timeout'
  | 'exit_code'
  | 'not_started'
  | 'budget_exceeded'
  | 'harness';

export interface ContractError {
  reason: ErrorReason;
  message: string;
}

/** A produced file as `result.json` records it. `path` is relative to the run directory. */
export interface FileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

/** Parses `value` with `schema`. The data is Zod's, with defaults and transforms applied, and the message is Zod's. */
export function validateOutput(
  schema: z.ZodType,
  value: unknown,
): { ok: true; data: unknown } | { ok: false; message: string } {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: z.prettifyError(parsed.error) };
}

const CHUNK = 1024 * 1024;

/** The sha256 of a file, read a chunk at a time so a large one is never held whole. */
function sha256(path: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  const buffer = Buffer.alloc(CHUNK);
  const fd = openSync(path, 'r');
  try {
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer))
      hasher.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hasher.digest('hex');
}

/** Records each declared file in `outDir` with its size and sha256. A file that isn't there is a `missing_file`. */
export function recordFiles(
  produces: Produces,
  outDir: string,
  runDir: string,
): { files: Record<string, FileEntry>; errors: ContractError[] } {
  const files: Record<string, FileEntry> = {};
  const errors: ContractError[] = [];
  for (const name of Object.keys(produces)) {
    const path = join(outDir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) {
      errors.push({ reason: 'missing_file', message: `'${name}' was not produced in $STAGE_OUT` });
    } else if (!stat.isFile()) {
      errors.push({ reason: 'missing_file', message: `'${name}' in $STAGE_OUT is not a regular file` });
    } else {
      files[name] = { path: runRelative(runDir, path), bytes: stat.size, sha256: sha256(path) };
    }
  }
  return { files, errors };
}
