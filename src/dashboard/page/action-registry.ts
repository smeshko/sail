// The page's actions, defined once: each thing a person can have done from the page (stop, stop now, resume, restart,
// clean, drop, requeue, move, poll, release a usage-limit hold, add, add skipping its checks, watch, unwatch, all clear) with its id and label, the subject it applies to, its
// availability from the server's offers, its parameters, its tier, its request and what its answer means. Pure: it
// holds no host, no state and no storage, so `act.ts` carries any entry out and `action-view.ts` draws any entry, and an
// entry added here needs nothing else. This is the only page module that names a POST endpoint.
//
// A subject is what an action is done to: a run, a queue item, a workflow, a repository, or nothing. The ids are the
// `data-action` names the markup already carries, `watch-set` split into `watch` and `unwatch`. A local action has
// `run`, the name of an effect the shell supplies, in place of a request. An answer names what the shell is to do
// (`reopen`, `leave`, `took`, or open a run), and never does it.
import type { RunActions } from '../actions';
import type { OfferedQueue, RepoOffers } from '../offers';
import type { DialogView } from './dialog-view';
import { cost } from './format';

const enc = encodeURIComponent;

export type SubjectKind = 'run' | 'item' | 'workflow' | 'repo' | 'none';

export type Subject =
  | { kind: 'run'; repo: string; runId: string }
  | { kind: 'item'; repo: string; workflow: string; item: string }
  | { kind: 'workflow'; repo: string; workflow: string }
  | { kind: 'repo'; repo: string }
  | { kind: 'none' };

/**
 * The first of `kinds` that `data` (a click's `data-*`) names. A run action with no `data-run` takes the open run, and a
 * queue item's key is its `data-item`, or `data-key` on a move.
 */
export function subjectOf(
  kinds: readonly SubjectKind[],
  data: Readonly<Record<string, string>>,
  openRun?: { repo: string; runId: string },
): Subject | undefined {
  for (const kind of kinds) {
    switch (kind) {
      case 'none':
        return { kind };
      case 'run': {
        const runId = data.run ?? openRun?.runId;
        const repo = data.run === undefined ? openRun?.repo : (data.repo ?? openRun?.repo);
        if (repo !== undefined && runId !== undefined) return { kind, repo, runId };
        break;
      }
      case 'item': {
        const item = data.item ?? data.key;
        if (data.repo !== undefined && data.workflow !== undefined && item !== undefined) {
          return { kind, repo: data.repo, workflow: data.workflow, item };
        }
        break;
      }
      case 'workflow':
        if (data.repo !== undefined && data.workflow !== undefined) {
          return { kind, repo: data.repo, workflow: data.workflow };
        }
        break;
      case 'repo':
        if (data.repo !== undefined) return { kind, repo: data.repo };
        break;
    }
  }
  return undefined;
}

interface ParamBase {
  /** The key of its value in `values` and in a click's `data-*` when `given`. */
  name: string;
  /** The `name` of the field that draws it, which `host.value()` reads. */
  dom: string;
  label?: string;
  /** The row supplies its value with its click (`data-<name>`): it is not drawn. */
  given?: 'data';
  /** Asked in the confirmation dialog, not drawn beside the button: the dialog's field, read at confirm. */
  ask?: 'dialog';
}

/** A number, a choice or a text. */
export type Param = ParamBase &
  (
    | { type: 'number'; min?: number; required?: boolean }
    | {
        type: 'choice';
        options: readonly { value: string; title?: string }[];
        /** The option chosen before one is. */
        initial?: string | undefined;
      }
    | { type: 'text'; placeholder?: string }
  );

/** `instant` is sent at once, `undoable` at once with a way back, `confirmed` after the confirmation dialog. */
export type Tier = 'instant' | 'undoable' | 'confirmed';

export type Values = Readonly<Record<string, string>>;

/** What a repository of the index offers: its queues' offers and its own. */
export interface OfferedRepo {
  name: string;
  /** The workflows its watcher watches, for what Unwatch all undoes. */
  watching?: { workflows: readonly string[] } | undefined;
  queues: readonly {
    workflow: string;
    offers?: OfferedQueue['offers'] | undefined;
    /** The queue's items, for what a dialog says of one. */
    queue?: { items?: readonly { dedupKey: string; state: string; attempts: number }[] } | undefined;
  }[];
  offers?: RepoOffers | undefined;
}

export interface OfferSource {
  /** What the open run offers. */
  run?: RunActions | undefined;
  index: readonly OfferedRepo[];
}

type Offered = { enabled: boolean; why?: string };

export type Availability = { offered: false; why?: string } | { offered: true; enabled: boolean; why?: string };

export type ActResult = {
  text?: string;
  effect?: Effect;
  keepMenu?: true;
  /** The request was refused: its text is sail's refusal. */
  refused?: true;
};
export type Effect = 'reopen' | 'leave' | 'took' | { open: string };

export interface ActionDef {
  id: string;
  label(subject: Subject): string;
  appliesTo: readonly SubjectKind[];
  tier: Tier;
  /** The key that does it: declared, and no entry sets one yet. */
  key?: string;
  /** A disabled offer stops the click before its request: otherwise the server's refusal comes with the POST. */
  holdsDisabled?: boolean;
  /** The id of the action whose drafts it reads and empties, when it shares its parameters with another's. */
  drafts?: string;
  /** Where its parameters are drawn: the run menu, the queue's header, on the repository's row, or the list's head. */
  place: 'run' | 'queue' | 'repo' | 'list';
  params(subject: Subject, source: OfferSource): Param[];
  available(subject: Subject, source: OfferSource): Availability;
  /** The confirmation dialog a confirmed action opens: its title, a line per consequence, its verb. */
  dialog?(subject: Subject, values: Values, source: OfferSource): DialogView;
  /** What its subject's row reads, in place of its status, while its request is out. */
  underway?: string;
  /** What reverses an undoable action once it took, read from the source at the click: the request, and the action whose answer it gets. */
  undo?(subject: Subject, source: OfferSource): { action: string; path: string; body: unknown } | undefined;
  /** What to post, `{ invalid }` for a value it can't send, or nothing when there is nothing to send. */
  request?(
    subject: Subject,
    values: Values,
    source: OfferSource,
  ): { path: string; body: unknown } | { invalid: string } | undefined;
  answer?(status: number, body: string, subject: Subject): ActResult;
  /** The name of the effect a local action has the shell perform. */
  run?: string;
  /** The rows the action is more than one: each its own label, with the `data-*` a click on it gives. */
  variants?(subject: Subject, source: OfferSource): { label: string; data: Record<string, string> }[];
}

/** Why a request of kind `what` (a move, a resume, a restart) was refused: the `error` its answer carries, else its status. */
export function refusal(status: number, body: string, what: string): string {
  if (status === 0) return `the ${what} could not be sent: the dashboard did not answer`;
  try {
    const { error } = JSON.parse(body) as { error?: unknown };
    if (typeof error === 'string' && error !== '') return error;
  } catch {
    // An answer that isn't JSON is told by its status.
  }
  return `the ${what} was refused (${status})`;
}

/** The string field `field` of a JSON answer, undefined when it has none. */
export function answerField(body: string, field: string): string | undefined {
  try {
    const value = (JSON.parse(body) as Record<string, unknown>)[field];
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** What a toast names an action's subject as: the run, the item's key, `<repo> / <workflow>`, the repository. */
export function subjectName(subject: Subject): string {
  switch (subject.kind) {
    case 'run':
      return subject.runId;
    case 'item':
      return subject.item;
    case 'workflow':
      return `${subject.repo} / ${subject.workflow}`;
    case 'repo':
      return subject.repo;
    case 'none':
      return '';
  }
}

/** The key of `ui.underway` that `def` done to `subject` sets while its request is out. */
export function underwayId(def: ActionDef, subject: Subject): string {
  const watching = def.id === 'watch' || def.id === 'unwatch';
  switch (subject.kind) {
    case 'run':
      return `run:${subject.repo}/${subject.runId}`;
    case 'item':
      return `item:${subject.repo}/${subject.workflow}/${subject.item}`;
    case 'workflow':
      return `${watching ? 'watch' : 'queue'}:${subject.repo}/${subject.workflow}`;
    case 'repo':
      return `watch:${subject.repo}`;
    case 'none':
      return '';
  }
}

const runName = (subject: Subject) => (subject.kind === 'run' ? subject.runId : '');

const REPO = (subject: Subject) => ('repo' in subject ? subject.repo : '');

function availability(offer: (Offered & { why?: string | undefined }) | undefined): Availability {
  if (offer === undefined) return { offered: false };
  return {
    offered: true,
    enabled: offer.enabled,
    ...(offer.why === undefined ? {} : { why: offer.why }),
  };
}

const NOT_OFFERED: Availability = { offered: false };

function runOffer(key: 'resume' | 'restart' | 'stop' | 'clean') {
  return (_: Subject, source: OfferSource): Availability => availability(source.run?.[key]);
}

const own = (record: object | undefined, key: string): boolean => record !== undefined && Object.hasOwn(record, key);

function queueOf(subject: Subject, source: OfferSource) {
  if (subject.kind !== 'item' && subject.kind !== 'workflow') return undefined;
  return source.index
    .find((repo) => repo.name === subject.repo)
    ?.queues.find((view) => view.workflow === subject.workflow);
}

function itemOffer(kind: 'requeue' | 'drop' | 'move') {
  return (subject: Subject, source: OfferSource): Availability => {
    const items = queueOf(subject, source)?.offers?.items;
    if (subject.kind !== 'item' || items === undefined || !own(items, subject.item)) return NOT_OFFERED;
    const offers = Object.getOwnPropertyDescriptor(items, subject.item)?.value as
      | Partial<Record<'requeue' | 'drop' | 'move', Offered>>
      | undefined;
    return own(offers, kind) ? availability(offers?.[kind]) : NOT_OFFERED;
  };
}

function queueOffer(kind: 'poll' | 'add') {
  return (subject: Subject, source: OfferSource): Availability =>
    availability(queueOf(subject, source)?.offers?.[kind]);
}

function watchOffer(kind: 'watch' | 'unwatch') {
  return (subject: Subject, source: OfferSource): Availability => {
    if (subject.kind !== 'workflow' && subject.kind !== 'repo') return NOT_OFFERED;
    const offers = source.index.find((repo) => repo.name === subject.repo)?.offers;
    if (offers === undefined) return NOT_OFFERED;
    if (subject.kind === 'repo') return availability(offers[kind]);
    const workflows = offers.workflows;
    if (!own(workflows, subject.workflow)) return NOT_OFFERED;
    const each = Object.getOwnPropertyDescriptor(workflows, subject.workflow)?.value as
      | Partial<Record<'watch' | 'unwatch', Offered>>
      | undefined;
    return own(each, kind) ? availability(each?.[kind]) : NOT_OFFERED;
  };
}

const runPath = (subject: Subject, op: string) =>
  subject.kind === 'run' ? `/api/repos/${enc(subject.repo)}/runs/${enc(subject.runId)}${op}` : '';
const queuePath = (subject: Subject, op: string) =>
  subject.kind === 'item' || subject.kind === 'workflow'
    ? `/api/repos/${enc(subject.repo)}/queues/${enc(subject.workflow)}${op}`
    : '';
const itemKey = (subject: Subject) => (subject.kind === 'item' ? subject.item : '');

const ok = (status: number) => status >= 200 && status < 300;

/** What a resume has spent against its budget, in the unit a raise is in. */
function spentOf(offer: NonNullable<RunActions['resume']>): string {
  const { budget } = offer;
  if (offer.raise === 'minutes') {
    const of = budget.maxMinutes === undefined ? '' : ` of ${budget.maxMinutes} min`;
    return `spent ${offer.spentMinutes === undefined ? '?' : `${offer.spentMinutes} min`}${of}`;
  }
  return `spent ${cost(offer.spentUsd)}${budget.maxUsd === undefined ? '' : ` of ${cost(budget.maxUsd)}`}`;
}

/** The budget a restart gives the new run. */
function budgetOf(offer: NonNullable<RunActions['restart']>): string {
  const { maxUsd, maxMinutes } = offer.budget;
  if (maxUsd !== undefined) return `budget ${cost(maxUsd)}`;
  return maxMinutes === undefined ? 'no budget' : `budget ${maxMinutes} min`;
}

/** An answer a queue change got: a 200's message (the change was taken) or a 202's waiting, else the refusal. */
function queueAnswer(word: string) {
  return (status: number, body: string): ActResult => {
    if (status !== 200 && status !== 202) return { text: refusal(status, body, word), refused: true };
    const text = answerField(body, status === 200 ? 'message' : 'waiting');
    return {
      ...(text === undefined ? {} : { text }),
      ...(status === 200 ? { effect: 'took' as const } : {}),
    };
  };
}

/** What dropping a queue item says before it is done: what leaves which queue, and what state the item is in. */
function dropDialog(subject: Subject, _values: Values, source: OfferSource): DialogView {
  if (subject.kind !== 'item') return { title: 'drop', lines: [], verb: 'drop' };
  const item = queueOf(subject, source)?.queue?.items?.find((each) => each.dedupKey === subject.item);
  return {
    title: `drop ${subject.item}`,
    lines: [
      `removes ${subject.item} from ${subject.repo} / ${subject.workflow}'s queue`,
      ...(item === undefined ? [] : [`it is ${item.state} after ${item.attempts} attempts`]),
    ],
    verb: 'drop',
  };
}

function queueItemAction(id: string, op: 'requeue' | 'drop', tier: Tier, path: string): ActionDef {
  return {
    id,
    label: () => op,
    appliesTo: ['item'],
    tier,
    holdsDisabled: true,
    place: 'queue',
    params: () => [],
    available: itemOffer(op),
    ...(tier === 'confirmed' ? { dialog: dropDialog } : {}),
    request: (subject) => ({ path: queuePath(subject, path), body: { dedupKey: itemKey(subject) } }),
    underway: op === 'drop' ? 'dropping…' : 'requeuing…',
    answer: queueAnswer(op),
  };
}

function watchAction(op: 'watch' | 'unwatch', path: string): ActionDef {
  return {
    id: op,
    label: (subject) => (subject.kind === 'repo' ? `${op} all` : op),
    appliesTo: ['workflow', 'repo'],
    tier: op === 'unwatch' ? 'undoable' : 'instant',
    place: 'repo',
    params: () => [],
    available: watchOffer(op),
    ...(op === 'unwatch'
      ? {
          undo: (subject: Subject, source: OfferSource) => {
            const repo = source.index.find((each) => each.name === REPO(subject));
            const workflows = subject.kind === 'workflow' ? [subject.workflow] : [...(repo?.watching?.workflows ?? [])];
            return { action: 'watch', path: `/api/repos/${enc(REPO(subject))}/watch`, body: { workflows } };
          },
        }
      : {}),
    underway: op === 'watch' ? 'watching…' : 'unwatching…',
    request: (subject) => ({
      path: `/api/repos/${enc(REPO(subject))}${path}`,
      body: { workflows: subject.kind === 'workflow' ? [subject.workflow] : [] },
    }),
    answer: (status, body) => {
      if (status !== 200 && status !== 202) return { text: refusal(status, body, op), refused: true };
      const text = answerField(body, 'message') ?? answerField(body, 'waiting');
      return { ...(text === undefined ? {} : { text }) };
    },
  };
}

/** Stop, or Stop now: two actions that differ in what they post and in what their dialog says, and read one offer. */
function stopAction(id: string, now: boolean): ActionDef {
  return {
    id,
    label: () => (now ? 'stop now' : 'stop'),
    appliesTo: ['run'],
    tier: 'confirmed',
    place: 'run',
    holdsDisabled: true,
    params: () => [],
    available: runOffer('stop'),
    underway: 'stopping…',
    dialog: (subject) => ({
      title: now ? `stop ${runName(subject)} now` : `stop ${runName(subject)}`,
      lines: [now ? 'ends its running call now' : 'stops at its next call boundary', 'the run fails as stopped'],
      verb: now ? 'stop now' : 'stop',
    }),
    request: (subject) => ({ path: runPath(subject, '/stop'), body: { now } }),
    answer: (status, body) => {
      if (!ok(status)) return { text: refusal(status, body, 'stop'), refused: true };
      const text = answerField(body, 'message');
      return { effect: 'reopen', keepMenu: true, ...(text === undefined ? {} : { text }) };
    },
  };
}

/** The ticket key field the two adds share. */
const addParams = (): Param[] => [
  { name: 'ticket', dom: 'add-ticket', label: 'ticket key', type: 'text', placeholder: 'ticket key' },
];

export const ACTIONS: readonly ActionDef[] = [
  {
    id: 'resume-run',
    label: () => 'resume',
    appliesTo: ['run'],
    tier: 'confirmed',
    place: 'run',
    holdsDisabled: true,
    params: (_, source) => {
      const raise = source.run?.resume?.raise;
      return raise === undefined
        ? []
        : [
            {
              name: 'raise',
              dom: 'raise',
              label: `raise ${raise === 'usd' ? '$' : 'min'}`,
              type: 'number',
              min: 0.01,
              required: true,
              ask: 'dialog',
            },
          ];
    },
    available: runOffer('resume'),
    underway: 'resuming…',
    dialog: (subject, values, source) => {
      const offer = source.run?.resume;
      const raise = Number(values.raise);
      const raised =
        offer?.raise === undefined || !Number.isFinite(raise) || raise <= 0
          ? []
          : [offer.raise === 'usd' ? `raises the budget by ${cost(raise)}` : `raises the budget by ${raise} min`];
      return {
        title: `resume ${runName(subject)}`,
        lines: [...(offer === undefined ? [] : [spentOf(offer)]), ...raised],
        verb: 'resume',
      };
    },
    request: (subject, values, source) => {
      const raising = source.run?.resume?.raise;
      const path = runPath(subject, '/resume');
      if (raising === undefined) return { path, body: {} };
      const typed = values.raise;
      const amount = Number(typed);
      if (typed === undefined || typed.trim() === '' || !Number.isFinite(amount) || amount < 0.01) {
        return {
          invalid: `give the ${raising === 'usd' ? 'dollars' : 'minutes'} to raise the budget by: at least 0.01`,
        };
      }
      return { path, body: { raise: { [raising]: amount } } };
    },
    answer: (status, body) =>
      ok(status) ? { effect: 'reopen', text: 'resumed' } : { text: refusal(status, body, 'resume'), refused: true },
  },
  {
    id: 'restart-run',
    label: () => 'restart',
    appliesTo: ['run'],
    tier: 'confirmed',
    place: 'run',
    holdsDisabled: true,
    params: (_, source) => {
      const offer = source.run?.restart;
      return offer === undefined
        ? []
        : [
            {
              name: 'stage',
              dom: 'stage',
              label: 'from',
              type: 'choice',
              options: offer.stages.map((each) => ({ value: each.stage, title: each.runsAgain })),
              initial: offer.stage,
              ask: 'dialog',
            },
          ];
    },
    available: runOffer('restart'),
    underway: 'restarting…',
    dialog: (subject, values, source) => {
      const offer = source.run?.restart;
      const chosen =
        offer?.stages.find((each) => each.stage === values.stage) ??
        offer?.stages.find((each) => each.stage === offer.stage);
      return {
        title: `restart ${runName(subject)}`,
        lines:
          offer === undefined
            ? []
            : [
                ...(chosen === undefined ? [] : [`runs again: ${chosen.runsAgain}`]),
                budgetOf(offer),
                `starts a new run seeded from ${runName(subject)}`,
              ],
        verb: 'restart',
      };
    },
    request: (subject, values, source) => ({
      path: runPath(subject, '/restart'),
      body: { stage: values.stage ?? source.run?.restart?.stage },
    }),
    answer: (status, body) => {
      if (!ok(status)) return { text: refusal(status, body, 'restart'), refused: true };
      const runId = answerField(body, 'runId');
      return runId === undefined ? {} : { effect: { open: runId }, text: `started ${runId}` };
    },
  },
  stopAction('stop-run', false),
  stopAction('stop-run-now', true),
  {
    id: 'clean-run',
    label: () => 'clean',
    appliesTo: ['run'],
    tier: 'confirmed',
    place: 'run',
    holdsDisabled: true,
    params: () => [],
    available: runOffer('clean'),
    underway: 'cleaning…',
    dialog: (subject, _, source) => {
      const offer = source.run?.clean;
      return {
        title: `clean ${runName(subject)}`,
        lines:
          offer === undefined
            ? []
            : [
                ...(offer.removes.length === 0 ? ['removes nothing'] : offer.removes.map((each) => `removes ${each}`)),
                ...(offer.archive === undefined ? [] : [`run directory → ${offer.archive}`]),
              ],
        verb: 'clean',
      };
    },
    request: (subject) => ({ path: runPath(subject, '/clean'), body: {} }),
    answer: (status, body) => {
      if (!ok(status)) return { text: refusal(status, body, 'clean'), refused: true };
      const text = answerField(body, 'message');
      return { effect: 'leave', ...(text === undefined ? {} : { text }) };
    },
  },
  queueItemAction('requeue-item', 'requeue', 'instant', '/requeue'),
  queueItemAction('drop-item', 'drop', 'confirmed', '/drop'),
  {
    id: 'move-item',
    label: () => 'move',
    appliesTo: ['item'],
    tier: 'instant',
    holdsDisabled: true,
    place: 'queue',
    params: () => [
      { name: 'dir', dom: 'dir', type: 'choice', options: [{ value: 'up' }, { value: 'down' }], given: 'data' },
      { name: 'target', dom: 'target', type: 'text', given: 'data' },
    ],
    available: itemOffer('move'),
    variants: (subject, source) => {
      if (subject.kind !== 'item') return [];
      const waiting = (queueOf(subject, source)?.queue?.items ?? []).filter((each) => each.state === 'queued');
      const at = waiting.findIndex((each) => each.dedupKey === subject.item);
      if (at < 0) return [];
      const above = waiting[at - 1];
      const below = waiting[at + 1];
      return [
        ...(above === undefined ? [] : [{ label: 'move up', data: { dir: 'up', target: above.dedupKey } }]),
        ...(below === undefined ? [] : [{ label: 'move down', data: { dir: 'down', target: below.dedupKey } }]),
      ];
    },
    request: (subject, values) => ({
      path: queuePath(subject, '/move'),
      body:
        values.dir === 'up'
          ? { dedupKey: itemKey(subject), before: values.target }
          : { dedupKey: itemKey(subject), after: values.target },
    }),
    underway: 'moving…',
    answer: queueAnswer('move'),
  },
  {
    id: 'poll-queue',
    label: () => 'poll',
    appliesTo: ['workflow'],
    tier: 'instant',
    holdsDisabled: true,
    place: 'queue',
    params: () => [],
    available: queueOffer('poll'),
    request: (subject) => ({ path: queuePath(subject, '/poll'), body: {} }),
    underway: 'polling…',
    answer: queueAnswer('poll'),
  },
  {
    id: 'release-hold',
    label: () => 'release',
    appliesTo: ['workflow'],
    tier: 'confirmed',
    place: 'queue',
    // The hold is the machine's, not the watcher's: a release needs no watcher, so no offer gates it.
    params: () => [{ name: 'harness', dom: 'harness', type: 'text', given: 'data' }],
    available: () => ({ offered: true, enabled: true }),
    underway: 'releasing…',
    dialog: (_subject, values) => ({
      title: `release the usage-limit hold on ${values.harness ?? ''}`,
      lines: [`releasing ends every watcher's hold on ${values.harness ?? ''}, and dispatch resumes`],
      verb: 'release',
    }),
    request: (subject, values) => ({ path: queuePath(subject, '/release'), body: { harnessKey: values.harness } }),
    answer: queueAnswer('release'),
  },
  {
    id: 'add-ticket',
    label: () => 'add',
    appliesTo: ['workflow'],
    tier: 'instant',
    holdsDisabled: true,
    place: 'queue',
    params: addParams,
    available: queueOffer('add'),
    request: (subject, values) => {
      const ticketKey = (values.ticket ?? '').trim();
      if (ticketKey === '') return undefined;
      return { path: queuePath(subject, '/add'), body: { ticketKey } };
    },
    underway: 'adding…',
    answer: queueAnswer('add'),
  },
  {
    id: 'add-ticket-force',
    label: () => 'add, skipping its checks',
    appliesTo: ['workflow'],
    tier: 'confirmed',
    holdsDisabled: true,
    place: 'queue',
    drafts: 'add-ticket',
    params: addParams,
    available: queueOffer('add'),
    dialog: (subject, values) => {
      const ticketKey = (values.ticket ?? '').trim();
      return {
        title: `add ${ticketKey}, skipping its checks`,
        lines: [
          `adds ${ticketKey} to ${subjectName(subject)}'s queue`,
          'skips its checks: the ticket need not be designated or in a pick-up state',
        ],
        verb: 'add',
      };
    },
    request: (subject, values) => {
      const ticketKey = (values.ticket ?? '').trim();
      if (ticketKey === '') return undefined;
      return { path: queuePath(subject, '/add'), body: { ticketKey, force: true } };
    },
    underway: 'adding…',
    answer: queueAnswer('add'),
  },
  watchAction('watch', '/watch'),
  watchAction('unwatch', '/unwatch'),
  {
    id: 'clear-attention',
    label: () => 'all clear',
    appliesTo: ['none'],
    tier: 'undoable',
    place: 'list',
    params: () => [],
    available: () => ({ offered: true, enabled: true }),
    run: 'clear-attention',
  },
];

/** The action `id` names, among `registry`. */
export function actionOf(id: string, registry: readonly ActionDef[] = ACTIONS): ActionDef | undefined {
  return registry.find((each) => each.id === id);
}
