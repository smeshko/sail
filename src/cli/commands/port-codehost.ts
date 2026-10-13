// `sail port codehost`: the CodeHost port's operations, as `sail port` runs them. Port and operation names are the
// TypeScript names in kebab-case, arguments are positionals and flags, and each result is parsed with the port's schema
// before it is printed: an adapter's answer crosses a trust boundary.
//
//   push <branch>                         pushes HEAD:<branch> from the working directory
//   open-pull-request --base <branch> --head <branch> --title <text> [--body-file <path>] [--draft]
//                     [--ticket <ticket key>] [--label <name>]...
//
// `--ticket` is passed on as given: only the code host is resolved, so no ticket source parses it.
import type { z } from 'zod';
import type { CodeHost } from '../../ports/code-host';
import { PortError } from '../../ports/errors';
import { PullRequest, Pushed } from '../../ports/types';
import type { PortTable } from './port';

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
  },
};
