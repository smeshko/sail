// The command menu's rows, from its state, the offers and the index. Pure: it reads the registry and returns rows, and
// the shell (`menu.ts`) acts on them. A row is one of the subject's actions (an offered but disabled one is drawn
// disabled with its reason, one that is not offered is left out), a "go to" match, one of the actions that need no
// subject, or an option of the step being asked. An action's parameters are asked as steps, one for each parameter its
// registry entry doesn't take from the click.
import type { IndexRepo } from '../files';
import {
  ACTIONS,
  type ActionDef,
  actionOf,
  type OfferSource,
  type Param,
  type Subject,
  subjectName,
} from './action-registry';
import { listRepos, queuePanels, workflowOf } from './index-model';
import type { MenuState, MenuStep } from './ui-state';

export type MenuRun =
  | { act: string; subject: Subject; data: Record<string, string> }
  | { goto: Subject }
  | { view: string }
  | { pollAll: true }
  | { pick: string }
  | { queue: { repo: string; workflow: string } }
  | { value: string };

export interface MenuRow {
  group: 'subject' | 'goto' | 'general' | 'step';
  label: string;
  hint?: string;
  key?: string;
  why?: string;
  /** A run's go-to row: its pull request (`PR #12`), else its ticket key, else its run id, as the list's row leads. */
  lead?: string;
  /** A run's go-to row: the run's status, drawn as the list's dot. */
  status?: string;
  /** A run's go-to row: the run id's part after its last `-`, set only while another listed row reads the same. */
  id?: string;
  disabled: boolean;
  run: MenuRun;
}

/** The parameter a typed step asks, and the lines the action's dialog gives for the values so far. */
export interface StepModel {
  /** What is asked: `from`, `raise $`, `ticket key`, `queue`. */
  label: string;
  /** The field the step draws: none for a choice. */
  field?: { type: 'number' | 'text'; placeholder?: string; min?: number };
  lines: string[];
  rows: MenuRow[];
  /** The row the highlight starts on. */
  start: number;
}

export interface MenuModel {
  head?: string;
  rows: MenuRow[];
  step?: StepModel;
}

/** How well `query` matches `text` as a case-insensitive subsequence: lower is better, undefined for no match. */
export function fuzzy(query: string, text: string): number | undefined {
  const needle = query.trim().toLowerCase();
  const hay = text.toLowerCase();
  let at = -1;
  let score = 0;
  for (const char of needle) {
    const next = hay.indexOf(char, at + 1);
    if (next < 0) return undefined;
    score += at < 0 ? next : next - at - 1;
    at = next;
  }
  return score;
}

/** How a "go to" candidate matches a query: tier 0 exact, 1 prefix, 2 whole title words, 3 subsequence; lower scores first within a tier. */
export interface Rank {
  tier: 0 | 1 | 2 | 3;
  score: number;
}

const WORD = /[^\p{L}\p{N}]+/u;
const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(WORD)
    .filter((word) => word !== '');

/**
 * How well `query` matches a candidate with the key texts `keys` (ids, keys, names) and the `titles` it reads: the tier
 * (a key equal to the query, a key it starts, every query word a word of one title, a subsequence of any text) and, within
 * it, a score where lower is better. Undefined for no match.
 */
export function rank(query: string, keys: readonly string[], titles: readonly string[]): Rank | undefined {
  const needle = query.trim().toLowerCase();
  const lowered = keys.map((key) => key.toLowerCase());
  if (lowered.includes(needle)) return { tier: 0, score: 0 };
  const starts = lowered.filter((key) => key.startsWith(needle)).map((key) => key.length - needle.length);
  if (starts.length > 0) return { tier: 1, score: Math.min(...starts) };
  const asked = wordsOf(needle);
  if (asked.length > 0 && titles.some((title) => asked.every((word) => wordsOf(title).includes(word)))) {
    return { tier: 2, score: 0 };
  }
  const scores = [...keys, ...titles].map((text) => fuzzy(query, text)).filter((score) => score !== undefined);
  return scores.length === 0 ? undefined : { tier: 3, score: Math.min(...scores) };
}

/** The `data-*` a click on a row of `subject` carries: what `subjectOf` reads. */
export function subjectData(subject: Subject): Record<string, string> {
  switch (subject.kind) {
    case 'run':
      return { repo: subject.repo, run: subject.runId };
    case 'item':
      return { repo: subject.repo, workflow: subject.workflow, item: subject.item };
    case 'workflow':
      return { repo: subject.repo, workflow: subject.workflow };
    case 'repo':
      return { repo: subject.repo };
    case 'none':
      return {};
  }
}

/** The first line of the menu: what the subject is. */
export function headOf(subject: Subject | undefined): string | undefined {
  if (subject === undefined || subject.kind === 'none') return undefined;
  const word = subject.kind === 'repo' ? 'repository' : subject.kind;
  return `${word} ${subjectName(subject)}`;
}

/**
 * The menu's chip: a run as its ticket key or pull request and its title, a queue item as its key and title, when the
 * index has them; anything else as `headOf` names it.
 */
export function chipOf(subject: Subject | undefined, index: readonly IndexRepo[], now: number): string | undefined {
  const named = (key: string | undefined, title: string | undefined) =>
    key !== undefined && title !== undefined && title !== '' ? `${key} · ${title}` : undefined;
  if (subject?.kind === 'run') {
    const run = listRepos(index, now)
      .find((repo) => repo.name === subject.repo)
      ?.runs.find((each) => each.runId === subject.runId);
    const key = run?.ticketKey ?? (run?.pr === undefined ? undefined : `#${run.pr}`);
    return named(key, run?.title) ?? headOf(subject);
  }
  if (subject?.kind === 'item') {
    const item = queuePanels(index)
      .find((panel) => panel.repo === subject.repo && panel.workflow === subject.workflow)
      ?.items.find((each) => each.dedupKey === subject.item);
    return named(subject.item.replace(/^[a-z-]+:/, ''), item?.title) ?? headOf(subject);
  }
  return headOf(subject);
}

/** Each action of the registry that applies to `subject` and is offered, as a row: disabled, with its reason, when it isn't enabled. */
export function subjectRows(subject: Subject, source: OfferSource): MenuRow[] {
  return ACTIONS.flatMap((def) => {
    if (def.run !== undefined || !def.appliesTo.includes(subject.kind)) return [];
    const available = def.available(subject, source);
    if (!available.offered) return [];
    const row = (label: string, extra: Record<string, string>): MenuRow => ({
      group: 'subject',
      label,
      ...(def.key === undefined ? {} : { key: def.key }),
      ...(available.enabled || available.why === undefined ? {} : { why: available.why }),
      disabled: !available.enabled,
      run: { act: def.id, subject, data: { ...subjectData(subject), ...extra } },
    });
    return def.variants === undefined
      ? [row(def.label(subject), {})]
      : def.variants(subject, source).map((variant) => row(variant.label, variant.data));
  });
}

/**
 * The eight best "go to" matches for `query`: runs, queues, queue items and repositories, ranked by `rank` and, when
 * equal, in the index's order. A query that is a run's ticket key in full (or its pull request) lists only the runs of
 * that ticket. None for an empty query.
 */
export function gotoRows(query: string, index: readonly IndexRepo[], now: number): MenuRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  type Found = { rank: Rank; row: MenuRow };
  const found: Found[] = [];
  const named: Found[] = [];
  const add = (
    hint: string,
    label: string,
    keys: string[],
    titles: string[],
    subject: Subject,
    full = false,
    extra: Partial<MenuRow> = {},
  ) => {
    const ranked = rank(query, keys, titles);
    if (ranked === undefined) return;
    const entry: Found = {
      rank: ranked,
      row: { group: 'goto', label, hint, disabled: false, run: { goto: subject }, ...extra },
    };
    found.push(entry);
    if (full) named.push(entry);
  };
  for (const repo of listRepos(index, now)) {
    add('repository', repo.name, [repo.name], [], { kind: 'repo', repo: repo.name });
    for (const run of repo.runs) {
      const prKeys = run.pr === undefined ? [] : [`PR #${run.pr}`, `#${run.pr}`];
      const ticket = run.ticketKey === undefined ? [] : [run.ticketKey];
      add(
        `${repo.name} › ${workflowOf(run)}`,
        run.title ?? '',
        [run.runId, ...ticket, ...prKeys],
        [run.title ?? ''],
        { kind: 'run', repo: repo.name, runId: run.runId },
        [...ticket, ...prKeys].some((key) => key.toLowerCase() === needle),
        { lead: run.pr === undefined ? (run.ticketKey ?? run.runId) : `PR #${run.pr}`, status: run.status },
      );
    }
  }
  for (const panel of queuePanels(index)) {
    const queue: Subject = { kind: 'workflow', repo: panel.repo, workflow: panel.workflow };
    const name = `${panel.repo} / ${panel.workflow}`;
    add('queue', name, [name, panel.repo, panel.workflow, `${panel.repo} ${panel.workflow}`], [], queue);
    for (const item of panel.items) {
      add('item', item.dedupKey, [item.dedupKey, item.dedupKey.replace(/^[a-z-]+:/, '')], [item.title], {
        kind: 'item',
        repo: panel.repo,
        workflow: panel.workflow,
        item: item.dedupKey,
      });
    }
  }
  const rows = (named.length > 0 ? named : found)
    .sort((a, b) => a.rank.tier - b.rank.tier || a.rank.score - b.rank.score)
    .slice(0, 8)
    .map((each) => each.row);
  // A run's row shows no run id; two rows that would read the same show the random part to tell them apart.
  const reads = (row: MenuRow) => JSON.stringify([row.lead, row.label, row.hint]);
  return rows.map((row) => {
    if (row.lead === undefined || !('goto' in row.run) || row.run.goto.kind !== 'run') return row;
    const runId = row.run.goto.runId;
    const same = rows.some((other) => other !== row && reads(other) === reads(row));
    return same ? { ...row, id: runId.slice(runId.lastIndexOf('-') + 1) } : row;
  });
}

/** The queues of the index that offer `id`, with the offer: the repository, the workflow and its availability. */
function queuesOffering(id: string, source: OfferSource) {
  const def = actionOf(id);
  return source.index.flatMap((repo) =>
    repo.queues.flatMap((view) => {
      const subject: Subject = { kind: 'workflow', repo: repo.name, workflow: view.workflow };
      const available = def?.available(subject, source);
      return available?.offered === true ? [{ subject, available }] : [];
    }),
  );
}

/** A row for an action that works on every queue offering it: disabled, with the first reason, while none is enabled. */
function everyQueueRow(label: string, id: string, run: MenuRun, source: OfferSource): MenuRow[] {
  const offering = queuesOffering(id, source);
  if (offering.length === 0) return [];
  const enabled = offering.some((each) => each.available.enabled);
  const why = offering.find((each) => !each.available.enabled)?.available.why;
  return [{ group: 'general', label, disabled: !enabled, ...(enabled || why === undefined ? {} : { why }), run }];
}

/** The actions that need no subject: the registry's, adding a ticket, polling every queue, and the two view actions. */
export function generalRows(source: OfferSource): MenuRow[] {
  const none: Subject = { kind: 'none' };
  return [
    // A local action is always there; one that asks the server is there while its offers give it.
    ...ACTIONS.filter((def) => def.appliesTo.includes('none')).flatMap((def): MenuRow[] => {
      const available = def.run === undefined ? def.available(none, source) : undefined;
      if (available !== undefined && !available.offered) return [];
      const disabled = available !== undefined && !available.enabled;
      return [
        {
          group: 'general',
          label: def.label(none),
          ...(def.key === undefined ? {} : { key: def.key }),
          ...(disabled && available?.why !== undefined ? { why: available.why } : {}),
          disabled,
          run: { act: def.id, subject: none, data: {} },
        },
      ];
    }),
    ...everyQueueRow('add a ticket…', 'add-ticket', { pick: 'add-ticket' }, source),
    ...everyQueueRow('poll every queue', 'poll-queue', { pollAll: true }, source),
    { group: 'general', label: 'switch theme', disabled: false, run: { view: 'toggle-theme' } },
    { group: 'general', label: 'toggle inspector', disabled: false, run: { view: 'toggle-inspector' } },
  ];
}

/** The parameters an action asks in the menu: those its click doesn't give, and no tick, which only its dialog asks. */
export function askedParams(def: ActionDef, subject: Subject, source: OfferSource): Param[] {
  return def.params(subject, source).filter((param) => param.given === undefined && param.type !== 'tick');
}

const stepRow = (label: string, run: MenuRun, hint?: string): MenuRow => ({
  group: 'step',
  label,
  ...(hint === undefined ? {} : { hint }),
  disabled: false,
  run,
});

/**
 * The step: what it asks, the lines the action's dialog gives for the values so far (with `typed` as the value of a typed
 * step's parameter), and its rows. A choice lists its options, starting on its initial one; the queue to pick lists each queue that offers the action.
 */
export function stepOf(step: MenuStep, source: OfferSource, typed = ''): StepModel {
  if ('pick' in step) {
    const rows = queuesOffering(step.action, source).map((each) => {
      const subject = each.subject;
      const name = subject.kind === 'workflow' ? { repo: subject.repo, workflow: subject.workflow } : undefined;
      return {
        ...stepRow(subjectName(subject), name === undefined ? { value: '' } : { queue: name }),
        disabled: !each.available.enabled,
        ...(each.available.enabled || each.available.why === undefined ? {} : { why: each.available.why }),
      };
    });
    return {
      label: 'queue',
      lines: [],
      rows,
      start: Math.max(
        0,
        rows.findIndex((row) => !row.disabled),
      ),
    };
  }
  const def = actionOf(step.action);
  const param = def === undefined ? undefined : askedParams(def, step.subject, source)[step.at];
  if (def === undefined || param === undefined) return { label: '', lines: [], rows: [], start: 0 };
  const values = { ...step.values, [param.name]: typed };
  const lines = def.dialog?.(step.subject, values, source).lines ?? [];
  const label = param.label ?? param.name;
  if (param.type === 'choice') {
    const rows = param.options.map((option) => stepRow(option.value, { value: option.value }, option.title));
    const start = rows.findIndex((row) => 'value' in row.run && row.run.value === param.initial);
    return { label, lines, rows, start: Math.max(0, start) };
  }
  const field =
    param.type === 'tick'
      ? { type: 'text' as const }
      : param.type === 'number'
        ? { type: 'number' as const, ...(param.min === undefined ? {} : { min: param.min }) }
        : { type: 'text' as const, ...(param.placeholder === undefined ? {} : { placeholder: param.placeholder }) };
  return { label, field, lines, rows: [], start: 0 };
}

/**
 * What the menu draws: its head, its rows and the step open, if any. Without a step: the subject's group, then, in the
 * full menu, "go to" for a typed query and the general group, each filtered by the query. The context menu is the
 * subject's group alone, unfiltered.
 */
export function menuRows(state: MenuState, source: OfferSource, index: readonly IndexRepo[], now: number): MenuModel {
  const head = chipOf(state.subject, index, now);
  const step = state.steps.at(-1);
  if (step !== undefined) {
    const model = stepOf(step, source, state.query);
    return { ...(head === undefined ? {} : { head }), rows: model.rows, step: model };
  }
  const subject = state.subject === undefined ? [] : subjectRows(state.subject, source);
  const matching = (rows: MenuRow[]) =>
    rows.filter((row) => state.query.trim() === '' || fuzzy(state.query, row.label) !== undefined);
  const rows =
    state.mode === 'context'
      ? subject
      : [...matching(subject), ...gotoRows(state.query, index, now), ...matching(generalRows(source))];
  return { ...(head === undefined ? {} : { head }), rows };
}
