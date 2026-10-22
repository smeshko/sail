// `sail port codehost`: the CodeHost port's operations, as `sail port` runs them. Port and operation names are the
// TypeScript names in kebab-case, arguments are positionals and flags, and each result is parsed with the port's schema
// before it is printed: an adapter's answer crosses a trust boundary.
//
//   push <branch>                         pushes HEAD:<branch> from the working directory
//   open-pull-request --base <branch> --head <branch> --title <text> [--body-file <path>] [--draft]
//                     [--ticket <ticket key>] [--label <name>]...
//   get-pull-request <pr>
//   list-designated <label>
//   checks <pr>
//   merge <pr> --method <merge|squash|rebase>
//   add-label <pr> <label>
//   remove-label <pr> <label>
//   comment <pr> [--body-file <path>]
//
// `<pr>` goes through the adapter's `parseRef`: a number, `#12`, or a pull-request URL the host owns. `--ticket` is
// passed on as given: only the code host is resolved, so no ticket source parses it. `--method` too, and the port
// refuses one it doesn't know. A merge the host answers `pending` or `refused` is a printed result: its state is in
// the JSON, and exit code 1 means the port call itself failed.
import { z } from 'zod';
import type { CodeHost } from '../../ports/code-host';
import { PortError } from '../../ports/errors';
import {
  Checks,
  Labelled,
  type MergeMethod,
  MergeResult,
  Posted,
  PullRequest,
  PullRequestDetails,
  Pushed,
} from '../../ports/types';
import type { PortCall, PortOperation, PortTable } from './port';

/**
 * `answer`, which the code host's `op` gave, as `schema` parses it. An answer that is no `what` is a PortError of
 * `op`, code `invalid`, saying where it isn't one.
 */
function answered<T>(op: string, what: string, schema: z.ZodType<T>, answer: unknown): { value: T } {
  const parsed = schema.safeParse(answer);
  if (parsed.success) return { value: parsed.data };
  const [issue] = parsed.error.issues;
  const where = [issue?.path.join('.'), issue?.message].filter(Boolean).join(' ');
  throw new PortError('codeHost', op, 'invalid', `its answer is not a ${what}: ${where}`, answer);
}

/** An option's value when it was given as text. */
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Why `ref` names no pull request of the code host `adapterName`. */
export function notAPullRequest(ref: string, adapterName: string): string {
  return `'${ref}' is not a pull request of the ${adapterName} code host: a number, or a URL it owns`;
}

/** An operation on the pull request `<pr>` names: `run` is given its number, once the adapter has read the ref. */
const onPullRequest = (
  rest: Omit<PortOperation<CodeHost>, 'run'>,
  run: (host: CodeHost, number: number, call: PortCall) => Promise<{ value: unknown }>,
): PortOperation<CodeHost> => ({
  ...rest,
  async run(host, call) {
    const [ref = ''] = call.positionals;
    const number = host.parseRef(ref);
    if (number === undefined) return { refused: notAPullRequest(ref, host.name) };
    return run(host, number, call);
  },
});

export const CODEHOST: PortTable<'codeHost'> = {
  port: 'codeHost',
  operations: {
    push: {
      positionals: ['branch'],
      run: async (host: CodeHost, { cwd, positionals: [branch = ''] }) =>
        answered('push', 'Pushed', Pushed, await host.push(cwd, branch)),
    },
    'open-pull-request': {
      positionals: [],
      options: {
        base: { value: 'branch', required: true },
        head: { value: 'branch', required: true },
        title: { value: 'text', required: true },
        'body-file': { value: 'path' },
        draft: {},
        ticket: { value: 'ticket key' },
        label: { value: 'name', repeats: true },
      },
      body: true,
      async run(host: CodeHost, { values, body }) {
        const ticketKey = text(values.ticket);
        const opened = await host.openPullRequest({
          base: text(values.base) ?? '',
          head: text(values.head) ?? '',
          title: text(values.title) ?? '',
          body: await body(),
          ...(values.draft === true ? { draft: true } : {}),
          ...(ticketKey === undefined ? {} : { ticketKey }),
          ...(Array.isArray(values.label) ? { labels: values.label } : {}),
        });
        return answered('openPullRequest', 'PullRequest', PullRequest, opened);
      },
    },
    'get-pull-request': onPullRequest({ positionals: ['pr'] }, async (host, number) =>
      answered('getPullRequest', 'PullRequestDetails', PullRequestDetails, await host.getPullRequest(number)),
    ),
    'list-designated': {
      positionals: ['label'],
      run: async (host: CodeHost, { positionals: [label = ''] }) =>
        answered('listDesignated', 'list of PullRequests', z.array(PullRequest), await host.listDesignated(label)),
    },
    checks: onPullRequest({ positionals: ['pr'] }, async (host, number) =>
      answered('checks', 'Checks', Checks, await host.checks(number)),
    ),
    merge: onPullRequest(
      { positionals: ['pr'], options: { method: { value: 'merge|squash|rebase', required: true } } },
      // The method as given: the port refuses one it doesn't know.
      async (host, number, { values }) =>
        answered('merge', 'MergeResult', MergeResult, await host.merge(number, text(values.method) as MergeMethod)),
    ),
    'add-label': onPullRequest(
      { positionals: ['pr', 'label'] },
      async (host, number, { positionals: [, label = ''] }) =>
        answered('addLabel', 'Labelled', Labelled, await host.addLabel(number, label)),
    ),
    'remove-label': onPullRequest(
      { positionals: ['pr', 'label'] },
      async (host, number, { positionals: [, label = ''] }) =>
        answered('removeLabel', 'Labelled', Labelled, await host.removeLabel(number, label)),
    ),
    comment: onPullRequest(
      { positionals: ['pr'], options: { 'body-file': { value: 'path' } }, body: true },
      async (host, number, { body }) => answered('comment', 'Posted', Posted, await host.comment(number, await body())),
    ),
  },
};
