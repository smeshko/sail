// The built-in `pr` intake's body: it fetches the run's pull request through the CodeHost, checks its ticket marker
// against its head branch, and leaves `pr.json`, `diff.patch` and `brief.md` in the call directory (DECISIONS D7). Every
// string the host returned is wrapped as untrusted input in the brief. It returns the run's input, unvalidated: the
// engine checks it against `PrInput`.
//
// The head sha in the output is the run's own: the source's, never the one the host sends back now. `diff.patch` is the
// run's workspace against the merge base of the pull request's base sha, the change as the host shows it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BRANCH_PREFIX } from '../../../engine/branch';
import { getPullRequestDetails, markerKey } from '../../../engine/pr-source';
import { render, untrustedInput } from '../../../engine/render';
import { PortError } from '../../../ports/errors';
import type { PullRequestDetails } from '../../../ports/types';
import type { IntakeContext } from '../index';

/**
 * `pr.json`: the details as fetched, with the run's own head sha as `headSha` and the host's now as `hostHeadSha`, and
 * what became of the ticket marker.
 */
export type PrFile = PullRequestDetails & { hostHeadSha: string; ticketMarker: { key: string; kept: boolean } | null };

/** The brief's values: every host string marked with where it came from, so the renderer wraps each one. */
function briefValues(pr: PullRequestDetails, headSha: string, ticketKey: string | undefined) {
  const from = (what: string) => `pull request #${pr.number}, ${what}`;
  return {
    pr: {
      number: pr.number,
      title: untrustedInput(pr.title, from('title')),
      body: untrustedInput(pr.body, from('body')),
      url: untrustedInput(pr.url, from('url')),
      author: untrustedInput(pr.author, from('author')),
      base: untrustedInput(pr.base, from('base')),
      head: untrustedInput(pr.head, from('head')),
      headSha,
      draft: pr.draft ? 'yes' : 'no',
    },
    labels: pr.labels.map((label, index) => untrustedInput(label, from(`label ${index + 1}`))),
    ticketKey,
    comments: pr.comments.map((comment, index) => ({
      author: untrustedInput(comment.author, from(`comment ${index + 1} author`)),
      body: untrustedInput(comment.body, from(`comment ${index + 1}`)),
    })),
  };
}

/**
 * Runs the `pr` intake once: one `getPullRequest`, the diff, the three files, the output. A failed port call leaves it
 * as a PortError, and so does an answer that is no PullRequestDetails or a ticket marker that doesn't match the head
 * branch, before any file is written.
 */
export async function prIntake(context: IntakeContext): Promise<unknown> {
  const { source, codeHost, workspace } = context;
  if (source.kind !== 'pr' || codeHost === undefined || workspace === undefined) {
    throw new Error("the pr intake reads a pull request, with the run's code host and workspace");
  }
  const pr = await getPullRequestDetails(codeHost, source.number);
  const marker = markerKey(pr, context.branchPrefix ?? DEFAULT_BRANCH_PREFIX);
  // The start refused a mismatch already: one here means the body changed since, and its key is never handed on.
  if ('refused' in marker) throw new PortError('codeHost', 'getPullRequest', 'invalid', marker.refused);
  const { headSha } = source;
  const diff = await workspace.port.diff(workspace.path, `${pr.baseSha}...`);

  const file: PrFile = {
    ...pr,
    headSha,
    hostHeadSha: pr.headSha,
    ticketMarker: pr.ticketKey === undefined ? null : { key: pr.ticketKey, kept: marker.ticketKey !== undefined },
  };
  writeFileSync(join(context.out, 'pr.json'), `${JSON.stringify(file, null, 2)}\n`);
  writeFileSync(join(context.out, 'diff.patch'), diff.patch);
  const template = readFileSync(join(import.meta.dir, 'brief.md'), 'utf8');
  writeFileSync(join(context.out, 'brief.md'), render(template, briefValues(pr, headSha, marker.ticketKey)).text);

  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    body: pr.body,
    author: pr.author,
    base: pr.base,
    head: pr.head,
    headSha,
    baseSha: pr.baseSha,
    draft: pr.draft,
    labels: pr.labels,
    comments: pr.comments.map(({ author, body }) => ({ author, body })),
    ...(marker.ticketKey === undefined ? {} : { ticketKey: marker.ticketKey }),
  };
}
