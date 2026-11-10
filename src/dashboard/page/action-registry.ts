// The page's actions, defined once: each thing a person can have done from the page (stop, resume, restart, clean, drop,
// requeue, move, poll, add, watch, unwatch, all clear) with its id and label, the subject it applies to, its
// availability from the server's offers, its parameters, its tier, its request and what its answer means. Pure: it
// holds no host, no state and no storage, so `act.ts` carries any entry out and `action-view.ts` draws any entry, and an
// entry added here needs nothing else. This is the only page module that names a POST endpoint.
//
// A subject is what an action is done to: a run, a queue item, a workflow, a repository, or nothing. The ids are the
// `data-action` names the markup already carries, `watch-set` split into `watch` and `unwatch`. A local action has
// `run`, the name of an effect the shell supplies, in place of a request. An answer names what the shell is to do
// (`reopen`, `leave`, `took`, or open a run), and never does it.
import type { RunActions } from '../actions';
import type { IndexRepo } from '../files';
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

/** Whether `a` and `b` are the same thing: the same kind, and every field the same. */
export function sameSubject(a: Subject, b: Subject): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface ParamBase {
  /** The key of its value in `values` and in a click's `data-*` when `given`. */
  name: string;
  /** The `name` of the field that draws it, which `host.value()` reads. */
  dom: string;
  label?: string;
  /** The row supplies its value with its click (`data-<name>`): it is not drawn. */
  given?: 'data';
}

/** A number, a choice or a text. A tick is a choice whose value is `on` while ticked and `''` while not. */
export type Param = ParamBase &
  (
    | { type: 'number'; min?: number; required?: boolean }
    | {
        type: 'choice';
        options: readonly { value: string; title?: string }[];
        /** The option chosen before one is. */
        initial?: string | undefined;
        tick?: boolean;
        /** A second click that finds it changed arms again instead of confirming. */
        rearm?: boolean;
        /** The `data-action` its field carries, to redraw what depends on it. */
        change?: string;
      }
    | { type: 'text'; placeholder?: string }
  );

/** `instant` is sent at once, `confirmed` after a second click, `undoable` at once with a way back (no action uses it yet). */
export type Tier = 'instant' | 'undoable' | 'confirmed';

export type Values = Readonly<Record<string, string>>;

export interface OfferSource {
  /** What the open run offers. */
  run?: RunActions | undefined;
  index: readonly IndexRepo[];
}

type Offered = { enabled: boolean; why?: string };

export type Availability =
  | { offered: false; why?: string }
  | { offered: true; enabled: boolean; why?: string; offer: Offered };

export type ActResult = { text?: string; place: 'run' | 'queue' | 'repo' | 'rail'; effect?: Effect; keepMenu?: true };
export type Effect = 'reopen' | 'leave' | 'took' | { open: string };
export type ActionResult = ActResult;

export interface ActionDef {
  id: string;
  label(subject: Subject): string;
  /** The noun a refusal names: "the <word> was refused (409)". */
  word: string;
  appliesTo: readonly SubjectKind[];
  tier: Tier;
  /** The key that does it: declared, and no entry sets one yet. */
  key?: string;
  /** A disabled offer stops the click before its request: otherwise the server's refusal comes with the POST. */
  holdsDisabled?: boolean;
  /** Where its answer shows: the run menu, the queue's header, under the repository's header, or the rail's top. */
  place: 'run' | 'queue' | 'repo' | 'rail';
  params(subject: Subject, source: OfferSource): Param[];
  available(subject: Subject, source: OfferSource): Availability;
  /** The armed button's label. */
  confirm?(subject: Subject, values: Values, source: OfferSource): string;
  /** What shows while its request is out. */
  sending?(subject: Subject): string;
  /** What to post, `{ invalid }` for a value it can't send, or nothing when there is nothing to send. */
  request?(
    subject: Subject,
    values: Values,
    source: OfferSource,
  ): { path: string; body: unknown } | { invalid: string } | undefined;
  answer?(status: number, body: string, subject: Subject): ActResult;
  /** The name of the effect a local action has the shell perform. */
  run?: string;
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

const REPO = (subject: Subject) => ('repo' in subject ? subject.repo : '');

function availability(offer: (Offered & { why?: string | undefined }) | undefined): Availability {
  if (offer === undefined) return { offered: false };
  return {
    offered: true,
    enabled: offer.enabled,
    ...(offer.why === undefined ? {} : { why: offer.why }),
    offer,
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
  subject.kind === 'run' ? `/api/repos/${enc(subject.repo)}/runs/${enc(subject.runId)}/${op}` : '';
const queuePath = (subject: Subject, op: string) =>
  subject.kind === 'item' || subject.kind === 'workflow'
    ? `/api/repos/${enc(subject.repo)}/queues/${enc(subject.workflow)}/${op}`
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
    if (status !== 200 && status !== 202) return { place: 'queue', text: refusal(status, body, word) };
    const text = answerField(body, status === 200 ? 'message' : 'waiting');
    return {
      place: 'queue',
      ...(text === undefined ? {} : { text }),
      ...(status === 200 ? { effect: 'took' as const } : {}),
    };
  };
}

function queueItemAction(id: string, op: 'requeue' | 'drop', tier: Tier): ActionDef {
  return {
    id,
    label: () => op,
    word: op,
    appliesTo: ['item'],
    tier,
    place: 'queue',
    params: () => [],
    available: itemOffer(op),
    ...(tier === 'confirmed' ? { confirm: () => 'confirm drop' } : {}),
    request: (subject) => ({ path: queuePath(subject, op), body: { dedupKey: itemKey(subject) } }),
    answer: queueAnswer(op),
  };
}

function watchAction(op: 'watch' | 'unwatch'): ActionDef {
  return {
    id: op,
    label: (subject) => (subject.kind === 'repo' ? `${op} all` : op),
    word: op,
    appliesTo: ['workflow', 'repo'],
    tier: op === 'unwatch' ? 'confirmed' : 'instant',
    place: 'repo',
    params: () => [],
    available: watchOffer(op),
    ...(op === 'unwatch'
      ? { confirm: (subject: Subject) => `${subject.kind === 'repo' ? 'unwatch all' : 'unwatch'}? click again` }
      : {}),
    sending: () => (op === 'watch' ? 'watching…' : 'unwatching…'),
    request: (subject) => ({
      path: `/api/repos/${enc(REPO(subject))}/${op}`,
      body: { workflows: subject.kind === 'workflow' ? [subject.workflow] : [] },
    }),
    answer: (status, body) => {
      if (status !== 200 && status !== 202) return { place: 'repo', text: refusal(status, body, op) };
      const text = answerField(body, 'message') ?? answerField(body, 'waiting');
      return { place: 'repo', ...(text === undefined ? {} : { text }) };
    },
  };
}

const STOP_NOW = (): Param => ({
  name: 'now',
  dom: 'now',
  label: 'stop now',
  type: 'choice',
  options: [],
  tick: true,
  change: 'stop-now',
});

export const ACTIONS: readonly ActionDef[] = [
  {
    id: 'resume-run',
    label: () => 'resume',
    word: 'resume',
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
            },
          ];
    },
    available: runOffer('resume'),
    confirm: (_, __, source) =>
      source.run?.resume === undefined ? 'resume' : `confirm resume · ${spentOf(source.run.resume)}`,
    sending: (subject) => `resuming ${subject.kind === 'run' ? subject.runId : ''}…`,
    request: (subject, values, source) => {
      const raising = source.run?.resume?.raise;
      const path = runPath(subject, 'resume');
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
      ok(status) ? { place: 'run', effect: 'reopen' } : { place: 'run', text: refusal(status, body, 'resume') },
  },
  {
    id: 'restart-run',
    label: () => 'restart',
    word: 'restart',
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
              rearm: true,
            },
          ];
    },
    available: runOffer('restart'),
    confirm: (_, values, source) => {
      const offer = source.run?.restart;
      if (offer === undefined) return 'restart';
      const chosen = offer.stages.some((each) => each.stage === values.stage) ? values.stage : offer.stage;
      return `confirm restart from ${chosen} · ${budgetOf(offer)}`;
    },
    sending: (subject) => `restarting ${subject.kind === 'run' ? subject.runId : ''}…`,
    request: (subject, values, source) => ({
      path: runPath(subject, 'restart'),
      body: { stage: values.stage ?? source.run?.restart?.stage },
    }),
    answer: (status, body) => {
      if (!ok(status)) return { place: 'run', text: refusal(status, body, 'restart') };
      const runId = answerField(body, 'runId');
      return runId === undefined ? { place: 'run' } : { place: 'run', effect: { open: runId } };
    },
  },
  {
    id: 'stop-run',
    label: () => 'stop',
    word: 'stop',
    appliesTo: ['run'],
    tier: 'confirmed',
    place: 'run',
    holdsDisabled: true,
    params: () => [STOP_NOW()],
    available: runOffer('stop'),
    confirm: (_, values) =>
      values.now === 'on' ? 'confirm stop now · ends its running call' : 'confirm stop · at its next call boundary',
    sending: (subject) => `stopping ${subject.kind === 'run' ? subject.runId : ''}…`,
    request: (subject, values) => ({ path: runPath(subject, 'stop'), body: { now: values.now === 'on' } }),
    answer: (status, body) => {
      if (!ok(status)) return { place: 'run', text: refusal(status, body, 'stop') };
      const text = answerField(body, 'message');
      return { place: 'run', effect: 'reopen', keepMenu: true, ...(text === undefined ? {} : { text }) };
    },
  },
  {
    id: 'clean-run',
    label: () => 'clean',
    word: 'clean',
    appliesTo: ['run'],
    tier: 'confirmed',
    place: 'run',
    holdsDisabled: true,
    params: () => [],
    available: runOffer('clean'),
    confirm: (_, __, source) => {
      const offer = source.run?.clean;
      if (offer === undefined) return 'clean';
      const where = offer.archive === undefined ? '' : ` · run directory -> ${offer.archive}`;
      return `confirm clean · removes ${offer.removes.join(', ') || 'nothing'}${where}`;
    },
    sending: (subject) => `cleaning ${subject.kind === 'run' ? subject.runId : ''}…`,
    request: (subject) => ({ path: runPath(subject, 'clean'), body: {} }),
    answer: (status, body) => {
      if (!ok(status)) return { place: 'run', text: refusal(status, body, 'clean') };
      const text = answerField(body, 'message');
      return { place: 'rail', effect: 'leave', ...(text === undefined ? {} : { text }) };
    },
  },
  queueItemAction('drop-item', 'drop', 'confirmed'),
  queueItemAction('requeue-item', 'requeue', 'instant'),
  {
    id: 'move-item',
    label: () => 'move',
    word: 'move',
    appliesTo: ['item'],
    tier: 'instant',
    place: 'queue',
    params: () => [
      { name: 'dir', dom: 'dir', type: 'choice', options: [{ value: 'up' }, { value: 'down' }], given: 'data' },
      { name: 'target', dom: 'target', type: 'text', given: 'data' },
    ],
    available: itemOffer('move'),
    request: (subject, values) => ({
      path: queuePath(subject, 'move'),
      body:
        values.dir === 'up'
          ? { dedupKey: itemKey(subject), before: values.target }
          : { dedupKey: itemKey(subject), after: values.target },
    }),
    answer: queueAnswer('move'),
  },
  {
    id: 'poll-queue',
    label: () => 'poll',
    word: 'poll',
    appliesTo: ['workflow'],
    tier: 'instant',
    place: 'queue',
    params: () => [],
    available: queueOffer('poll'),
    request: (subject) => ({ path: queuePath(subject, 'poll'), body: {} }),
    answer: queueAnswer('poll'),
  },
  {
    id: 'add-ticket',
    label: () => 'add',
    word: 'add',
    appliesTo: ['workflow'],
    tier: 'instant',
    place: 'queue',
    params: () => [
      { name: 'ticket', dom: 'add-ticket', label: 'ticket key', type: 'text', placeholder: 'ticket key' },
      { name: 'force', dom: 'add-force', label: 'force', type: 'choice', options: [], tick: true },
    ],
    available: queueOffer('add'),
    request: (subject, values) => {
      const ticketKey = (values.ticket ?? '').trim();
      if (ticketKey === '') return undefined;
      return {
        path: queuePath(subject, 'add'),
        body: values.force === 'on' ? { ticketKey, force: true } : { ticketKey },
      };
    },
    answer: queueAnswer('add'),
  },
  watchAction('watch'),
  watchAction('unwatch'),
  {
    id: 'clear-attention',
    label: () => 'all clear',
    word: 'all clear',
    appliesTo: ['none'],
    tier: 'instant',
    place: 'rail',
    params: () => [],
    available: () => ({ offered: true, enabled: true, offer: { enabled: true } }),
    run: 'clear-attention',
  },
];

/** The action `id` names, among `registry`. */
export function actionOf(id: string, registry: readonly ActionDef[] = ACTIONS): ActionDef | undefined {
  return registry.find((each) => each.id === id);
}
