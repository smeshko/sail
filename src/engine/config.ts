// A repository's config, `.sail/project.yaml`, read once it validates against `sail.project.v1`. Phase 5.2 adds the
// sail version-range check, adapter loading and the credential preflight here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Reads `<sailDir>/project.yaml`, or gives every way it is missing or breaks `sail.project.v1`. The caller sets each
 * issue's `file`, relative to where the user ran the command.
 */
export function readConfig(sailDir: string): ProjectConfig | { issues: SchemaIssue[] } {
  const issues = projectIssues(sailDir);
  if (issues.length > 0) return { issues };
  const data = Bun.YAML.parse(readFileSync(join(sailDir, 'project.yaml'), 'utf8')) as AsWritten;
  return { ...data, models: data.models ?? {}, budgets: data.budgets ?? {} };
}
