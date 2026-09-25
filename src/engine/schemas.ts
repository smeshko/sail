// The sail.*.v1 JSON Schemas and the checks against them: one document, a whole run directory, or a project.yaml.
// Ajv compiles a schema the first time it is used, so importing this module compiles nothing.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { type AnySchemaObject, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import event from '../../schemas/sail.event.v1.json' with { type: 'json' };
import journal from '../../schemas/sail.journal.v1.json' with { type: 'json' };
import project from '../../schemas/sail.project.v1.json' with { type: 'json' };
import result from '../../schemas/sail.result.v1.json' with { type: 'json' };
import run from '../../schemas/sail.run.v1.json' with { type: 'json' };
import summary from '../../schemas/sail.summary.v1.json' with { type: 'json' };

export const SCHEMA_NAMES = [
  'sail.run.v1',
  'sail.journal.v1',
  'sail.event.v1',
  'sail.summary.v1',
  'sail.result.v1',
  'sail.project.v1',
] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

const SCHEMAS: Record<SchemaName, AnySchemaObject> = {
  'sail.run.v1': run,
  'sail.journal.v1': journal,
  'sail.event.v1': event,
  'sail.summary.v1': summary,
  'sail.result.v1': result,
  'sail.project.v1': project,
};

/** One way a document breaks its schema. `path` is a JSON pointer into the document, `/` for the whole of it. */
export interface SchemaIssue {
  /** Relative to the run directory. */
  file?: string;
  /** 1-based, for an NDJSON line. */
  line?: number;
  schema?: SchemaName;
  path: string;
  message: string;
}

export interface RunDirReport {
  /** Documents checked per schema, whether or not they parsed. */
  counts: Partial<Record<SchemaName, number>>;
  issues: SchemaIssue[];
}

let ajv: Ajv2020 | undefined;
const validators = new Map<SchemaName, ValidateFunction>();

function validatorFor(schema: SchemaName): ValidateFunction {
  let validate = validators.get(schema);
  if (validate === undefined) {
    ajv ??= new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
    validate = ajv.compile(SCHEMAS[schema]);
    validators.set(schema, validate);
  }
  return validate;
}

function pointer(base: string, property: string): string {
  return `${base}/${property.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

// Ajv reports a missing, unknown or badly named property at its parent object. Pointing at the property reads better.
function toIssue(error: ErrorObject): Pick<SchemaIssue, 'path' | 'message'> {
  if (error.propertyName !== undefined) {
    return { path: pointer(error.instancePath, error.propertyName), message: `name ${error.message}` };
  }
  switch (error.keyword) {
    case 'additionalProperties':
      return { path: pointer(error.instancePath, error.params.additionalProperty), message: 'is not allowed' };
    case 'required':
      return { path: pointer(error.instancePath, error.params.missingProperty), message: 'is required' };
    case 'false schema':
      return { path: error.instancePath || '/', message: 'is not allowed' };
    default:
      return { path: error.instancePath || '/', message: error.message ?? 'is invalid' };
  }
}

const RESTATING = new Set(['if', 'propertyNames']);

// Rules JSON Schema can't state, checked once a document matches its schema. A multi-step call's outcome is its last
// step's, and JSON Schema can't compare against the last element of an array.
function ruleIssues(schema: SchemaName, data: unknown): SchemaIssue[] {
  if (schema !== 'sail.result.v1') return [];
  const result = data as { outcome: string; steps?: { outcome: string }[] };
  const last = result.steps?.at(-1);
  if (last === undefined || last.outcome === result.outcome) return [];
  return [{ schema, path: '/outcome', message: `must equal the last step's outcome (${last.outcome})` }];
}

/** Validates one parsed document against its schema and the rules beside it. An empty array means it is valid. */
export function validateDocument(schema: SchemaName, data: unknown): SchemaIssue[] {
  const validate = validatorFor(schema);
  if (validate(data)) return ruleIssues(schema, data);
  // `if` and `propertyNames` errors only restate the errors reported beneath them.
  return (validate.errors ?? [])
    .filter((error) => !RESTATING.has(error.keyword))
    .map((error) => ({ schema, ...toIssue(error) }));
}

function checkText(report: RunDirReport, schema: SchemaName, file: string, text: string, line?: number): void {
  report.counts[schema] = (report.counts[schema] ?? 0) + 1;
  const at: Pick<SchemaIssue, 'file' | 'line' | 'schema'> =
    line === undefined ? { file, schema } : { file, line, schema };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    report.issues.push({ ...at, path: '/', message: `is not valid JSON: ${(error as Error).message}` });
    return;
  }
  for (const issue of validateDocument(schema, data)) report.issues.push({ ...issue, ...at });
}

// Call directories are `NN-<stage>/call-N/`, with a multi-step call's steps below them. Nothing else in a run
// directory is walked: the workspace in particular is the repository's checkout and may hold any result.json.
const RESULT_FILES = new Bun.Glob('[0-9][0-9]*-*/**/result.json');

/** Validates run.json, every journal and event line, summary.json and every call's result.json in `dir`. */
export function validateRunDir(dir: string): RunDirReport {
  const report: RunDirReport = { counts: {}, issues: [] };
  const read = (file: string): string | undefined =>
    existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : undefined;

  const header = read('run.json');
  if (header === undefined)
    report.issues.push({ file: 'run.json', schema: 'sail.run.v1', path: '/', message: 'is missing' });
  else checkText(report, 'sail.run.v1', 'run.json', header);

  for (const [file, schema] of [
    ['journal.ndjson', 'sail.journal.v1'],
    ['events.ndjson', 'sail.event.v1'],
  ] as const) {
    const lines = read(file)?.split('\n') ?? [];
    lines.forEach((text, i) => {
      if (text.trim() !== '') checkText(report, schema, file, text, i + 1);
    });
  }

  const summaryText = read('summary.json');
  if (summaryText !== undefined) checkText(report, 'sail.summary.v1', 'summary.json', summaryText);

  for (const file of [...RESULT_FILES.scanSync({ cwd: dir })].sort()) {
    checkText(report, 'sail.result.v1', file, readFileSync(join(dir, file), 'utf8'));
  }
  return report;
}

/** Reads and validates a `.sail/project.yaml`. A file that can't be read or parsed is one issue at `/`. */
export function validateProjectFile(path: string): SchemaIssue[] {
  let data: unknown;
  try {
    data = Bun.YAML.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return [{ schema: 'sail.project.v1', path: '/', message: (error as Error).message }];
  }
  return validateDocument('sail.project.v1', data);
}

/** `file[:line]  [schema]  path message`, leaving out what the issue doesn't carry. */
export function formatIssue(issue: SchemaIssue): string {
  const where = issue.file === undefined ? '' : `${issue.file}${issue.line === undefined ? '' : `:${issue.line}`}  `;
  const schema = issue.schema === undefined ? '' : `[${issue.schema}]  `;
  return `${where}${schema}${issue.path} ${issue.message}`;
}
