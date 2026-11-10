// The CodeHost port: the repository host in sail's words. State is honest: a merge counts once the host reports it,
// never when it was only requested (D4).
import type {
  CheckLog,
  Checks,
  CodeHostCapabilities,
  Labelled,
  MergeRequest,
  MergeResult,
  Posted,
  PullRequest,
  PullRequestDetails,
  Pushed,
  Rerun,
  UpdatedPullRequest,
  UpdatePullRequest,
} from './types';

export interface OpenPullRequest {
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
  /** False when left out. */
  readonly draft?: boolean;
  readonly ticketKey?: string;
  readonly labels?: readonly string[];
}

export interface CodeHost {
  readonly name: string;
  /** The pull request `ref` names: `12`, `#12`, or a pull-request URL the host owns. Undefined for anything else. */
  parseRef(ref: string): number | undefined;
  /**
   * Pushes `HEAD` from `cwd` to the branch, never forced. The repository's default branch is refused as `invalid`, before
   * anything is pushed. Emits `codehost:pushed`.
   */
  push(cwd: string, branch: string): Promise<Pushed>;
  /**
   * Emits `codehost:pr_opened`, then one `codehost:labelled` per label. From the head of an open pull request into its
   * base, it returns that pull request instead, adds the requested labels it lacks with one `codehost:labelled` each,
   * and emits no `codehost:pr_opened`: its title, body and draft stay as they are.
   */
  openPullRequest(request: OpenPullRequest): Promise<PullRequest>;
  /** The open, non-draft pull requests that carry `label`, whatever its case, with their head in this repository: never a fork. */
  listDesignated(label: string): Promise<PullRequest[]>;
  /**
   * The open pull request whose head is `branch` in this repository, a draft included, or undefined when there is none.
   * A fork's is never returned. A read: it emits nothing.
   */
  pullRequestFrom(branch: string): Promise<PullRequest | undefined>;
  /** The pull request with its details: its body, author, base sha, whether it is a fork, and its comments. */
  getPullRequest(number: number): Promise<PullRequestDetails>;
  /** The checks on the pull request's head sha. Emits `codehost:checks`. */
  checks(number: number): Promise<Checks>;
  /**
   * Runs the failed checks on the pull request's head again, and names them. Only a check the host can rerun is rerun:
   * a failed commit status is left out. Emits `codehost:checks_rerun` only when it reran a check.
   */
  rerunChecks(number: number): Promise<Rerun>;
  /**
   * The last 20 000 characters of the log of the check `name` on the pull request's head, or the whole log, uncut, with
   * `whole`. Emits nothing. A check the head doesn't have, or one with no log to read, is `not_found`.
   */
  checkLog(number: number, name: string, options?: { whole?: boolean }): Promise<CheckLog>;
  /**
   * Merges the pull request by `request.method`, only while its head is `request.expectedHeadSha`. It is `refused`, with
   * nothing sent, when the pull request is closed, a draft, or at another head. A rejection by the host is a PortError.
   * Emits `codehost:merged` only when the host reports the merge.
   */
  merge(number: number, request: MergeRequest): Promise<MergeResult>;
  /** Emits `codehost:labelled` only when the labels changed. */
  addLabel(number: number, label: string): Promise<Labelled>;
  /**
   * Emits `codehost:labelled` only when the labels changed. A label named `.` or `..` is refused, `invalid`, with
   * nothing sent.
   */
  removeLabel(number: number, label: string): Promise<Labelled>;
  /** Emits `codehost:commented`. */
  comment(number: number, body: string): Promise<Posted>;
  /**
   * Changes the pull request's title, body or both, and answers it with the body the host now holds. A request that names
   * neither is refused `invalid`, with nothing sent. It reads the pull request first and sends nothing when nothing would
   * change, and emits `codehost:pr_updated`, naming the fields, only on a change. The GitHub adapter keeps the pull
   * request's ticket marker in the body.
   */
  updatePullRequest(number: number, update: UpdatePullRequest): Promise<UpdatedPullRequest>;
  capabilities(): CodeHostCapabilities;
}
