// A pull request's checks on GitHub: the latest check run of each name, app and workflow and the commit statuses on its
// head sha, in the port's words (DECISIONS D4); a run a later run of its name, app and workflow superseded is dropped.
// Each is read in pages of 100 until GitHub's `total_count` is reached, and an answer GitHub doesn't document reads as
// failed: a check sail can't read is never one that passed.
import { PortError } from '../../ports/errors';
import type { Check, CheckStatus } from '../../ports/types';
import type { GitHubClient } from './github-client';

/** A check run as GitHub's `check-runs` endpoint lists it: the fields the adapter reads. */
export interface GitHubCheckRun {
  readonly id?: number;
  readonly app?: { readonly id?: number } | null;
  readonly check_suite?: { readonly id?: number } | null;
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string | null;
  readonly html_url?: string | null;
  readonly details_url?: string | null;
}

/** A commit status as GitHub's combined status lists it: the latest per context. */
export interface GitHubStatus {
  readonly context: string;
  readonly state: string;
  readonly target_url?: string | null;
}

/** A GitHub Actions workflow run as the `actions/runs` endpoint lists it: the fields the adapter reads. */
export interface GitHubWorkflowRun {
  readonly id?: number;
  readonly check_suite_id: number;
  readonly workflow_id?: number;
}

const PER_PAGE = 100;
/** How many pages of each are read before the read gives up rather than cut the list short. */
const MAX_PAGES = 10;

/** A check run's status: one not completed is pending, and a conclusion other than success, neutral or skipped failed. */
export function checkRunStatus(run: Pick<GitHubCheckRun, 'status' | 'conclusion'>): CheckStatus {
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion === 'success') return 'passed';
  if (run.conclusion === 'neutral' || run.conclusion === 'skipped') return 'skipped';
  return 'failed';
}

/** A commit status's state: pending, success as passed, and failure, error or anything else failed. */
export function commitStatus(status: Pick<GitHubStatus, 'state'>): CheckStatus {
  if (status.state === 'pending') return 'pending';
  if (status.state === 'success') return 'passed';
  return 'failed';
}

/**
 * Every item of a paged list, page after page of 100, until `total_count` items have been read. A page without its list
 * or its count, one whose count differs from the first page's, one that ends the list short of the count, or one
 * listing an entry that is no object or holds no string under `nameField`, is `unavailable`: a check left unread could have failed.
 * An `actions/runs` entry holds an integer `check_suite_id` in place of a name.
 */
async function readPaged<T>(
  client: GitHubClient,
  op: string,
  sha: string,
  endpoint: 'check-runs' | 'status' | 'actions/runs',
  field: 'check_runs' | 'statuses' | 'workflow_runs',
  nameField: 'name' | 'context' | 'check_suite_id',
): Promise<T[]> {
  const read: T[] = [];
  let expected: number | undefined;
  const actions = endpoint === 'actions/runs';
  const path = actions ? client.repoPath('actions', 'runs') : client.repoPath('commits', sha, endpoint);
  const named = (value: unknown) => (actions ? Number.isInteger(value) : typeof value === 'string');
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({
      ...(actions ? { head_sha: sha } : {}),
      per_page: String(PER_PAGE),
      page: String(page),
    });
    const answer = await client.request<unknown>(op, 'GET', `${path}?${query}`);
    const { [field]: listed, total_count: total } = (typeof answer === 'object' && answer !== null ? answer : {}) as {
      [key: string]: unknown;
    };
    if (!Array.isArray(listed) || typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
      throw new PortError(
        'codeHost',
        op,
        'unavailable',
        `GitHub's ${endpoint} answer for ${sha} holds no list and total_count`,
      );
    }
    // The count the first page gave holds for the whole read: a later page's count can't end it early.
    expected ??= total;
    if (total !== expected) {
      throw new PortError(
        'codeHost',
        op,
        'unavailable',
        `GitHub's ${endpoint} count for ${sha} changed from ${expected} to ${total} while it was read`,
      );
    }
    if (!listed.every((entry) => typeof entry === 'object' && entry !== null && named(entry[nameField]))) {
      throw new PortError(
        'codeHost',
        op,
        'unavailable',
        `GitHub's ${endpoint} answer for ${sha} lists an entry without a ${nameField}`,
      );
    }
    read.push(...(listed as T[]));
    if (read.length >= total) return read;
    if (listed.length === 0) {
      throw new PortError(
        'codeHost',
        op,
        'unavailable',
        `GitHub listed ${read.length} of ${total} ${endpoint} on ${sha}`,
      );
    }
  }
  throw new PortError('codeHost', op, 'unavailable', `more than ${PER_PAGE * MAX_PAGES} checks on ${sha}`);
}

/** Whether runs of one name from one app sit in more than one check suite, as runs of two workflows' jobs do. */
function suitesShareNames(runs: readonly GitHubCheckRun[]): boolean {
  const suites = new Map<string, unknown>();
  for (const run of runs) {
    const check = JSON.stringify([run.app?.id ?? null, run.name]);
    const suite = run.check_suite?.id;
    if (suites.has(check) && suites.get(check) !== suite) return true;
    suites.set(check, suite);
  }
  return false;
}

/**
 * Each check's latest run, the greatest id, in GitHub's order. A check is a name from one app and, for a run whose
 * check suite `workflowOf` maps, one workflow: two apps' or two workflows' runs of a name are two checks, while a
 * workflow's later runs supersede its earlier ones. A check with a run lacking an integer id keeps every run.
 */
export function latestRuns(
  runs: readonly GitHubCheckRun[],
  workflowOf: ReadonlyMap<number, number> = new Map(),
): GitHubCheckRun[] {
  const workflow = (run: GitHubCheckRun) => {
    const suite = run.check_suite?.id;
    return suite === undefined ? undefined : workflowOf.get(suite);
  };
  const check = (run: GitHubCheckRun) => JSON.stringify([run.app?.id ?? null, workflow(run) ?? null, run.name]);
  const latest = new Map<string, number>();
  const unordered = new Set<string>();
  for (const run of runs) {
    if (!Number.isInteger(run.id)) unordered.add(check(run));
    else latest.set(check(run), Math.max(latest.get(check(run)) ?? Number.NEGATIVE_INFINITY, run.id as number));
  }
  return runs.filter((run) => unordered.has(check(run)) || run.id === latest.get(check(run)));
}

/**
 * The workflow of each check suite on `sha`, from its GitHub Actions workflow runs. A token GitHub refuses them to, one
 * without Actions read access or on a repository without Actions, gets each suite as a workflow of its own: a later
 * event's run then no longer supersedes an earlier one, but no run of one workflow ever hides another's failure.
 */
async function readWorkflows(
  client: GitHubClient,
  op: string,
  sha: string,
  checkRuns: readonly GitHubCheckRun[],
): Promise<Map<number, number>> {
  let workflowRuns: GitHubWorkflowRun[];
  try {
    workflowRuns = await readPaged<GitHubWorkflowRun>(
      client,
      op,
      sha,
      'actions/runs',
      'workflow_runs',
      'check_suite_id',
    );
  } catch (error) {
    if (!(error instanceof PortError && (error.code === 'forbidden' || error.code === 'not_found'))) throw error;
    return new Map(
      checkRuns.flatMap((run) => (run.check_suite?.id === undefined ? [] : [[run.check_suite.id, run.check_suite.id]])),
    );
  }
  return new Map(
    workflowRuns.flatMap((run) =>
      Number.isInteger(run.workflow_id) ? [[run.check_suite_id, run.workflow_id as number] as const] : [],
    ),
  );
}

/**
 * The checks on `sha`: its latest check run of each name, app and workflow, then its commit statuses, each in GitHub's
 * order. A run a later one of its name, app and workflow superseded is dropped from `checks` and kept in `raw`. The
 * workflows are read only when one app's runs of a name sit in more than one check suite.
 */
async function readRuns(client: GitHubClient, op: string, sha: string) {
  const checkRuns = await readPaged<GitHubCheckRun>(client, op, sha, 'check-runs', 'check_runs', 'name');
  // A name repeated across check suites may be two workflows' jobs: their workflow runs tell which suite is which.
  const workflowOf = suitesShareNames(checkRuns) ? await readWorkflows(client, op, sha, checkRuns) : new Map();
  const statuses = await readPaged<GitHubStatus>(client, op, sha, 'status', 'statuses', 'context');
  return { checkRuns, statuses, latest: latestRuns(checkRuns, workflowOf) };
}

/**
 * Runs the failed jobs of each GitHub Actions workflow run that holds a failed latest check run of `sha`, once per
 * workflow run, and names the failed checks that were rerun. A failed commit status, a check run of another app and a
 * workflow run GitHub won't rerun (no Actions access, still running) are left out.
 */
export async function rerunFailed(client: GitHubClient, op: string, sha: string): Promise<string[]> {
  const { latest } = await readRuns(client, op, sha);
  const failed = latest.filter((run) => checkRunStatus(run) === 'failed' && Number.isInteger(run.check_suite?.id));
  if (failed.length === 0) return [];
  let workflowRuns: GitHubWorkflowRun[];
  try {
    workflowRuns = await readPaged<GitHubWorkflowRun>(
      client,
      op,
      sha,
      'actions/runs',
      'workflow_runs',
      'check_suite_id',
    );
  } catch (error) {
    if (error instanceof PortError && (error.code === 'forbidden' || error.code === 'not_found')) return [];
    throw error;
  }
  const rerunnable = new Set(['forbidden', 'not_found', 'conflict']);
  const names: string[] = [];
  const rerunSuites = new Map<number, boolean>();
  for (const run of failed) {
    const suite = run.check_suite?.id as number;
    const workflowRun = workflowRuns.find((each) => each.check_suite_id === suite);
    if (workflowRun === undefined || !Number.isInteger(workflowRun.id)) continue;
    if (!rerunSuites.has(suite)) {
      try {
        await client.request<undefined>(
          op,
          'POST',
          client.repoPath('actions', 'runs', workflowRun.id as number, 'rerun-failed-jobs'),
        );
        rerunSuites.set(suite, true);
      } catch (error) {
        if (!(error instanceof PortError && rerunnable.has(error.code))) throw error;
        rerunSuites.set(suite, false);
      }
    }
    if (rerunSuites.get(suite) === true && !names.includes(run.name)) names.push(run.name);
  }
  return names;
}

export async function readChecks(
  client: GitHubClient,
  op: string,
  sha: string,
): Promise<{ checks: Check[]; raw: { checkRuns: GitHubCheckRun[]; statuses: GitHubStatus[] } }> {
  const { checkRuns, statuses, latest } = await readRuns(client, op, sha);
  const runUrl = (run: GitHubCheckRun) => run.html_url ?? run.details_url ?? undefined;
  const checks: Check[] = [
    ...latest.map((run) => {
      const url = runUrl(run);
      return { name: run.name, status: checkRunStatus(run), ...(url === undefined ? {} : { url }) };
    }),
    ...statuses.map((status) => ({
      name: status.context,
      status: commitStatus(status),
      ...(status.target_url ? { url: status.target_url } : {}),
    })),
  ];
  return { checks, raw: { checkRuns, statuses } };
}
