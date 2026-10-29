// A repository's config, `.sail/project.yaml`, read once it validates against `sail.project.v1` and its `sail` range
// holds for the running sail. Phase 5.2 adds adapter loading and the credential preflight.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { projectIssues } from './sail-dir';
import type { SchemaIssue } from './schemas';

/** The outside systems a run talks to, one adapter each. */
export const PORTS = ['ticketSource', 'codeHost', 'harness', 'workspace'] as const;
/** The ports every run resolves. */
export type RunPort = (typeof PORTS)[number];
/** The ports `project.yaml` may leave out, resolved only when something asks for them. */
export const OPTIONAL_PORTS = ['jev'] as const;
export type Port = RunPort | (typeof OPTIONAL_PORTS)[number];

/** An adapter by name for a built-in, or by module path for the repository's own, with its options beside it. */
export interface AdapterConfig {
  use: string;
  readonly [option: string]: unknown;
}

/** sail's own designation label: what `sail.project.v1`'s `label` falls back to when `project.yaml` sets none. */
export const DEFAULT_LABEL = 'sail';

/** A model id on the default harness, or a model id on the harness `adapters.harnesses` names. */
export type ModelAlias = string | { harness: string; model: string };

/** The model id `alias` names, and its named harness when it has one. Undefined when `models` doesn't define it. */
export function aliasOf(config: ProjectConfig, alias: string): { model: string; harness?: string } | undefined {
  if (!Object.hasOwn(config.models, alias)) return undefined;
  const value = config.models[alias] as ModelAlias;
  return typeof value === 'string' ? { model: value } : { model: value.model, harness: value.harness };
}

export interface ProjectConfig {
  name: string;
  /** The sail versions the repository accepts, as a semver range. */
  sail: string;
  /** The designation label. `DEFAULT_LABEL` applies when it is left out. */
  label?: string;
  defaultWorkflow?: string;
  /** What a run's branch starts with. `DEFAULT_BRANCH_PREFIX` applies when it is left out. */
  branchPrefix?: string;
  adapters: Record<RunPort, AdapterConfig> & {
    /** The Jev adapter, which only `sail port jev` resolves. */
    jev?: AdapterConfig;
    /** The named harnesses, which a model alias may name. A run preflights each only when it reaches it. */
    harnesses?: Record<string, AdapterConfig>;
  };
  /** Model aliases: alias → model id, or the model id on a named harness. Empty when `project.yaml` has none. */
  models: Record<string, ModelAlias>;
  /** Empty when `project.yaml` has none. */
  budgets: { run?: { maxUsd?: number; maxMinutes?: number } };
  /**
   * The convention files appended to every agent prompt, each relative to the repository's root. Left out, `AGENTS.md`
   * and `CLAUDE.md` are appended where they exist. An empty list appends none.
   */
  conventions?: string[];
}

/** `project.yaml` as written, where `models` and `budgets` may be left out. */
type AsWritten = Omit<ProjectConfig, 'models' | 'budgets'> & Partial<Pick<ProjectConfig, 'models' | 'budgets'>>;

// The grammar leaves out the forms `Bun.semver` reads differently from npm:
// - A number of 2^64 or more matches every version, so a number has at most 15 digits, which is within npm's bound too.
// - `>x` and `<*` match every version where npm matches none, and `^x` and `~*` miss versions npm matches. So these
//   four operators take a version that starts with a number.
// - A number after a wildcard, as in `1.x.3`, which npm ignores, breaks a hyphen range. So a wildcard ends a version.
// - A version with no operator, or with `=`, after another comparator in its set starts an alternative: `>=5.0.0 0.x`
//   holds for 0.1.0. So such a version may only come first.
const NUMBER = String.raw`\d{1,15}`;
const WILDCARDS = String.raw`\.[x*](?:\.[x*])?`;
const NUMBERED = String.raw`(?:${NUMBER}(?:${WILDCARDS}|\.${NUMBER}(?:\.[x*]|\.${NUMBER}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)?)?)`;
const VERSION = `(?:[x*]|${NUMBERED})`;
/** A comparator with an operator other than `=`. */
const BOUND = `(?:(?:>=|<=)${VERSION}|(?:\\^|~|>|<)${NUMBERED})`;
const COMPARATOR_SET = `(?:${VERSION} +- +${VERSION}|(?:=?${VERSION}|${BOUND})(?: +${BOUND})*)`;
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
  const config = { ...data, models: data.models ?? {}, budgets: data.budgets ?? {} };
  const undefinedHarness = Object.keys(config.models).flatMap((alias): SchemaIssue[] => {
    const { harness } = aliasOf(config, alias) ?? {};
    if (harness === undefined || Object.hasOwn(config.adapters.harnesses ?? {}, harness)) return [];
    return [
      {
        path: `/models/${alias}/harness`,
        message: `names the harness '${harness}', which adapters.harnesses doesn't define`,
      },
    ];
  });
  return undefinedHarness.length > 0 ? { issues: undefinedHarness } : config;
}
