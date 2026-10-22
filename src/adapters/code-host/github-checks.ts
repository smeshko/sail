// A pull request's checks on GitHub: the check runs and the commit statuses on its head sha, in the port's words
// (DECISIONS D4). Each is read in pages of 100 until GitHub's `total_count` is reached, and an answer GitHub doesn't
// document reads as failed: a check sail can't read is never one that passed.
import { PortError } from '../../ports/errors';
import type { Check, CheckStatus } from '../../ports/types';
import type { GitHubClient } from './github-client';

/** A check run as GitHub's `check-runs` endpoint lists it: the fields the adapter reads. */
export interface GitHubCheckRun {
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
 * or its count, one whose count differs from the first page's, or one that ends the list short of the count, is
 * `unavailable`: a check left unread could have failed.
 */
async function readPaged<T>(
  client: GitHubClient,
  op: string,
  sha: string,
  endpoint: 'check-runs' | 'status',
  field: 'check_runs' | 'statuses',
): Promise<T[]> {
  const read: T[] = [];
  let expected: number | undefined;
  const path = client.repoPath('commits', sha, endpoint);
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) });
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

/** The checks on `sha`: its check runs, then its commit statuses, each in GitHub's order. */
export async function readChecks(
  client: GitHubClient,
  op: string,
  sha: string,
): Promise<{ checks: Check[]; raw: { checkRuns: GitHubCheckRun[]; statuses: GitHubStatus[] } }> {
  const checkRuns = await readPaged<GitHubCheckRun>(client, op, sha, 'check-runs', 'check_runs');
  const statuses = await readPaged<GitHubStatus>(client, op, sha, 'status', 'statuses');
  const runUrl = (run: GitHubCheckRun) => run.html_url ?? run.details_url ?? undefined;
  const checks: Check[] = [
    ...checkRuns.map((run) => {
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
