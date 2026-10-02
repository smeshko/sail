// The CodeHost port: the repository host in sail's words. State is honest: a merge counts once the host reports it,
// never when it was only requested (D4).
import type {
  Checks,
  CodeHostCapabilities,
  Labelled,
  MergeMethod,
  MergeResult,
  Posted,
  PullRequest,
  Pushed,
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
  /** Pushes `HEAD:<branch>` from `cwd`. Emits `codehost:pushed`. */
  push(cwd: string, branch: string): Promise<Pushed>;
  /** Emits `codehost:pr_opened`, then one `codehost:labelled` per label. */
  openPullRequest(request: OpenPullRequest): Promise<PullRequest>;
  /** The open, non-draft pull requests that carry `label`. */
  listDesignated(label: string): Promise<PullRequest[]>;
  getPullRequest(number: number): Promise<PullRequest>;
  /** The checks on the pull request's head sha. Emits `codehost:checks`. */
  checks(number: number): Promise<Checks>;
  /** Emits `codehost:merged` only when the host reports the merge. */
  merge(number: number, method: MergeMethod): Promise<MergeResult>;
  /** Emits `codehost:labelled` only when the labels changed. */
  addLabel(number: number, label: string): Promise<Labelled>;
  /** Emits `codehost:labelled` only when the labels changed. */
  removeLabel(number: number, label: string): Promise<Labelled>;
  /** Emits `codehost:commented`. */
  comment(number: number, body: string): Promise<Posted>;
  capabilities(): CodeHostCapabilities;
}
