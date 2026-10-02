// A repository's config, `.sail/project.yaml`, read once it validates against `sail.project.v1` and its `sail` range
// holds for the running sail. Phase 5.2 adds adapter loading and the credential preflight.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { projectIssues } from './sail-dir';
import type { SchemaIssue } from './schemas';

/** The outside systems a run talks to, one adapter each. */
export const PORTS = ['ticketSource', 'codeHost', 'harness', 'workspace'] as const;
export type Port = (typeof PORTS)[number];

/** An adapter by name for a built-in, or by module path for the repository's own, with its options beside it. */
export interface AdapterConfig {
  use: string;
  readonly [option: string]: unknown;
}

export interface ProjectConfig {
  name: string;
  /** The sail versions the repository accepts, as a semver range. */
  sail: string;
  label?: string;
  defaultWorkflow?: string;
  adapters: Record<Port, AdapterConfig>;
  /** Model aliases: alias → model id. Empty when `project.yaml` has none. */
  models: Record<string, string>;
  /** Empty when `project.yaml` has none. */
  budgets: { run?: { maxUsd?: number; maxMinutes?: number } };
}

/** `project.yaml` as written, where `models` and `budgets` may be left out. */
type AsWritten = Omit<ProjectConfig, 'models' | 'budgets'> & Partial<Pick<ProjectConfig, 'models' | 'budgets'>>;

const VERSION = String.raw`(?:[x*]|\d+(?:\.(?:[x*]|\d+)(?:\.(?:[x*]|\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)?)?)`;
const COMPARATOR = `(?:(?:\\^|~|>=|<=|>|<|=)?${VERSION})`;
const COMPARATOR_SET = `(?:${VERSION} +- +${VERSION}|${COMPARATOR}(?: +${COMPARATOR})*)`;
const RANGE = new RegExp(`^ *${COMPARATOR_SET}(?: *\\|\\| *${COMPARATOR_SET})* *$`);

/**
 * The issue a `sail` range raises against the running version, or undefined when it holds. `Bun.semver` reads a range
 * it can't parse as matching everything, so the grammar is checked first.
 */
export function rangeIssue(range: string, version: string): SchemaIssue | undefined {
  if (!RANGE.test(range)) return { path: '/sail', message: `is '${range}', which is not a version range` };
  if (!Bun.semver.satisfies(version, range)) {
    return { path: '/sail', message: `is '${range}', which sail ${version} doesn't satisfy` };
  }
  return undefined;
}

/**
 * Reads `<sailDir>/project.yaml`, or gives every way it is missing, breaks `sail.project.v1` or asks for a sail the
 * running one isn't. The caller sets each issue's `file`, relative to where the user ran the command.
 */
export function readConfig(sailDir: string, version: string = pkg.version): ProjectConfig | { issues: SchemaIssue[] } {
  const issues = projectIssues(sailDir);
  if (issues.length > 0) return { issues };
  const data = Bun.YAML.parse(readFileSync(join(sailDir, 'project.yaml'), 'utf8')) as AsWritten;
  const range = rangeIssue(data.sail, version);
  if (range) return { issues: [range] };
  return { ...data, models: data.models ?? {}, budgets: data.budgets ?? {} };
}
