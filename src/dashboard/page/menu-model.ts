// The command menu's rows, from its state, the offers and the index. Pure: it reads the registry and returns rows, and
// the shell (`menu.ts`) acts on them. A row is one of the subject's actions (an offered but disabled one is drawn
// disabled with its reason, one that is not offered is left out), a "go to" match, one of the actions that need no
// subject, or an option of the step being asked. An action's parameters are asked as steps, one for each parameter its
// registry entry doesn't take from the click.
import type { IndexRepo } from '../files';
import {
  ACTIONS,
  type ActionDef,
  type Availability,
  actionOf,
  type OfferSource,
  type Param,
  type Subject,
  subjectName,
} from './action-registry';
import { listRepos, type QueuePanel, queuePanels, workflowOf } from './index-model';
import { VIEWS, type ViewName } from './list-model';
import { VIEW_ACTIONS } from './top-bar';
import type { MenuState, MenuStep } from './ui-state';

export type MenuRun =
  | { act: string; subject: Subject; data: Record<string, string> }
  | { goto: Subject }
  | { show: ViewName }
  | { view: string }
  | { pollAll: true }
  | { pick: string; of?: 'repo' }
  | { repo: string }
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
  /** The one reason every row of the subject is disabled, said once under the chip in place of on each row. */
  why?: string;
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

const WORD = /[^\p{L}\p{N}]+/u;
const isWord = (char: string) => !WORD.test(char);

/**
 * How well `query` matches `text` as a case-insensitive subsequence that starts at the start of a word of it and skips
 * no character between words: lower is better, undefined for none. `qs` finds "queue store" through its separator only
 * when it is typed; `fk1` finds no `FAKE-1`.
 */
export function wordFuzzy(query: string, text: string): number | undefined {
  const needle = query.trim().toLowerCase();
  const hay = text.toLowerCase();
  let best: number | undefined;
  for (let start = hay.indexOf(needle.charAt(0)); start >= 0; start = hay.indexOf(needle.charAt(0), start + 1)) {
    if (start > 0 && isWord(hay.charAt(start - 1))) continue;
    let at = start;
    let score = 0;
    for (const char of needle.slice(1)) {
      let next = at + 1;
      while (next < hay.length && hay.charAt(next) !== char && isWord(hay.charAt(next))) next++;
      if (hay.charAt(next) !== char) {
        score = -1;
        break;
      }
      score += next - at - 1;
      at = next;
    }
    if (score >= 0 && (best === undefined || score < best)) best = score;
  }
  return best;
}

/** How a "go to" candidate matches a query: tier 0 exact, 1 prefix, 2 whole title words, 3 subsequence; lower scores first within a tier. */
export interface Rank {
  tier: 0 | 1 | 2 | 3;
  score: number;
}

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(WORD)
    .filter((word) => word !== '');

/**
 * How well `query` matches a candidate with the key texts `keys` (ids, keys, names) and the `titles` it reads: the tier
 * (a key equal to the query, a key it starts, every query word a word of one title, a subsequence of a key or a title
 * within one word, as `wordFuzzy` finds it) and, within it, a score where lower is better. Undefined for no match: a
 * subsequence whose letters are spread over several words is none.
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
  const scores = [...keys, ...titles].map((text) => wordFuzzy(needle, text)).filter((score) => score !== undefined);
  return scores.length === 0 ? undefined : { tier: 3, score: Math.min(...scores) };
}

/**
 * How well `query` matches an action's label: 0 the label itself, 1 its start, 2 the start of a later word of it, 3 a
 * subsequence. Undefined for no match.
 */
export function labelTier(query: string, label: string): 0 | 1 | 2 | 3 | undefined {
  const needle = query.trim().toLowerCase();
  const hay = label.toLowerCase();
  if (hay === needle) return 0;
  if (hay.startsWith(needle)) return 1;
  for (let at = hay.indexOf(needle, 1); at > 0; at = hay.indexOf(needle, at + 1)) {
    if (WORD.test(hay.charAt(at - 1))) return 2;
  }
  return fuzzy(needle, hay) === undefined ? undefined : 3;
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

/** A queue item's key without its kind: `FAKE-5` for `ticket:FAKE-5`. */
const bareKey = (dedupKey: string) => dedupKey.replace(/^[a-z-]+:/, '');

/** The first line of the menu: what the subject is, as the list names it: a run's id, an item's key, `repository › workflow`, a repository. */
export function headOf(subject: Subject | undefined): string | undefined {
  if (subject === undefined || subject.kind === 'none') return undefined;
  if (subject.kind === 'workflow') return `${subject.repo} › ${subject.workflow}`;
  return subject.kind === 'item' ? bareKey(subject.item) : subjectName(subject);
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
    return named(bareKey(subject.item), item?.title) ?? headOf(subject);
  }
  return headOf(subject);
}

/** Each action of the registry that applies to `subject` and is offered, as a row: disabled, with its reason, when it isn't enabled. */
export function subjectRows(subject: Subject, source: OfferSource): MenuRow[] {
  return ACTIONS.flatMap((def) => {
    if (def.run !== undefined || !def.appliesTo.includes(subject.kind)) return [];
    const available = def.available(subject, source);
    if (!available.offered) return [];
    const row = (label: string, extra: Record<string, string>, key = def.key): MenuRow => ({
      group: 'subject',
      label,
      ...(key === undefined ? {} : { key }),
      ...(available.enabled || available.why === undefined ? {} : { why: available.why }),
      disabled: !available.enabled,
      run: { act: def.id, subject, data: { ...subjectData(subject), ...extra } },
    });
    return def.variants === undefined
      ? [row(def.label(subject), {})]
      : def
          .variants(subject, source)
          .map((variant) => row(variant.label, variant.data, def.variantKeys?.[variant.label]));
  });
}

/** A view's go-to row: its name, its key, and the words that name it besides. */
const VIEW_ROWS: Record<ViewName, { label: string; key: string; words: string[] }> = {
  inbox: { label: 'Inbox', key: '1', words: ['inbox', 'attention'] },
  active: { label: 'Active', key: '2', words: ['active', 'live'] },
  queues: { label: 'Queues', key: '3', words: ['queues', 'queue'] },
  history: { label: 'History', key: '4', words: ['history', 'finished'] },
};

/** Where a kind of go-to row stands among rows that match as well: a view first, a queue item last. */
const KIND_ORDER = { view: 0, queue: 1, repo: 2, run: 3, item: 4 } as const;

/** The words that name a kind of go-to row: typing one lists every row of the kind. */
const KIND_WORDS: Partial<Record<Subject['kind'], string[]>> = {
  repo: ['repository', 'repositories', 'repo', 'repos'],
  workflow: ['queue', 'queues'],
};

/** A run that ended: it is listed after everything else, and only on a match better than a subsequence. */
const finished = (status: string) => status === 'completed' || status === 'failed';

/**
 * The eight best "go to" matches for `query`: views, queues, repositories, runs and queue items, ranked by `rank`,
 * then by kind (`KIND_ORDER`) and, when equal, in the index's order. A kind's own word lists that kind: `queue` the
 * Queues view and every queue, `repo` every repository. A repository's name, in full or from its third letter, lists
 * its queues and its live runs right after it. A run that ended comes after every other row, and is left out when it
 * matches only as a subsequence. A query that is a run's ticket key in full (or its pull request) lists only the runs
 * of that ticket. An empty query lists the four views.
 */
export function gotoRows(query: string, index: readonly IndexRepo[], now: number): MenuRow[] {
  const needle = query.trim().toLowerCase();
  const viewRow = (view: ViewName): MenuRow => ({
    group: 'goto',
    label: VIEW_ROWS[view].label,
    hint: 'view',
    key: VIEW_ROWS[view].key,
    disabled: false,
    run: { show: view },
  });
  if (needle === '') return VIEWS.map(viewRow);
  type Found = { rank: Rank; row: MenuRow; kind: keyof typeof KIND_ORDER; late: boolean };
  const found: Found[] = [];
  const named: Found[] = [];
  for (const view of VIEWS) {
    const ranked = rank(query, VIEW_ROWS[view].words, []);
    if (ranked !== undefined && ranked.tier < 2 && (ranked.tier === 0 || needle.length >= 3))
      found.push({ rank: ranked, row: viewRow(view), kind: 'view', late: false });
  }
  const listed = new Set<string>();
  const add = (
    hint: string,
    label: string,
    keys: string[],
    titles: string[],
    subject: Subject,
    full = false,
    extra: Partial<MenuRow> = {},
    via?: Rank,
  ) => {
    // A row is listed once, whatever else would list it again.
    const id = JSON.stringify(subject);
    if (listed.has(id)) return;
    // A kind's own word, in full or from its third letter, lists the kind; it is no text for a subsequence to match.
    const byWord = needle.length < 3 ? undefined : rank(query, KIND_WORDS[subject.kind] ?? [], []);
    const ranked = via ?? (byWord !== undefined && byWord.tier < 2 ? byWord : rank(query, keys, titles));
    if (ranked === undefined) return;
    const late = subject.kind === 'run' && finished(extra.status ?? '');
    if (late && ranked.tier === 3 && !full) return;
    listed.add(id);
    const entry: Found = {
      rank: ranked,
      row: { group: 'goto', label, hint, disabled: false, run: { goto: subject }, ...extra },
      // A row listed by its repository's name stands with the repository's row, after it in the index's order.
      kind:
        via !== undefined
          ? 'repo'
          : subject.kind === 'workflow'
            ? 'queue'
            : subject.kind === 'none'
              ? 'item'
              : subject.kind,
      late,
    };
    found.push(entry);
    if (full) named.push(entry);
  };
  const panels = queuePanels(index);
  const addQueue = (panel: QueuePanel, via?: Rank) => {
    const queue: Subject = { kind: 'workflow', repo: panel.repo, workflow: panel.workflow };
    const name = `${panel.repo} › ${panel.workflow}`;
    const keys = [
      name,
      `${panel.repo} / ${panel.workflow}`,
      panel.repo,
      panel.workflow,
      `${panel.repo} ${panel.workflow}`,
    ];
    add('queue', name, keys, [], queue, false, {}, via);
  };
  for (const repo of listRepos(index, now)) {
    add('repository', repo.name, [repo.name], [], { kind: 'repo', repo: repo.name });
    // The repository's own name, in full or from its third letter, lists its queues and live runs after it.
    const byName = rank(query, [repo.name], []);
    const via =
      byName !== undefined && (byName.tier === 0 || (byName.tier === 1 && needle.length >= 3)) ? byName : undefined;
    if (via !== undefined) for (const panel of panels.filter((each) => each.repo === repo.name)) addQueue(panel, via);
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
        finished(run.status ?? '') ? undefined : via,
      );
    }
  }
  for (const panel of panels) {
    addQueue(panel);
    for (const item of panel.items) {
      const key = bareKey(item.dedupKey);
      add(
        `${panel.repo} › ${panel.workflow}`,
        item.title,
        [item.dedupKey, key],
        [item.title],
        { kind: 'item', repo: panel.repo, workflow: panel.workflow, item: item.dedupKey },
        false,
        { lead: key, status: item.state },
      );
    }
  }
  const rows = (named.length > 0 ? named : found)
    .sort(
      (a, b) =>
        Number(a.late) - Number(b.late) ||
        a.rank.tier - b.rank.tier ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.rank.score - b.rank.score,
    )
    .slice(0, 8)
    .map((each) => each.row);
  // A run's row shows no run id; two run rows that would read the same show the random part to tell them apart. A
  // queue item's row that reads as its run's is told apart by its icon.
  const reads = (row: MenuRow) =>
    'goto' in row.run && row.run.goto.kind === 'run' ? JSON.stringify([row.lead, row.label, row.hint]) : undefined;
  return rows.map((row) => {
    if (row.lead === undefined || !('goto' in row.run) || row.run.goto.kind !== 'run') return row;
    const runId = row.run.goto.runId;
    const same = rows.some((other) => other !== row && reads(other) !== undefined && reads(other) === reads(row));
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

/** The repositories of the index that offer `id`, with the offer: the repository and its availability. */
function reposOffering(id: string, source: OfferSource) {
  const def = actionOf(id);
  return source.index.flatMap((repo) => {
    const subject: Subject = { kind: 'repo', repo: repo.name };
    const available = def?.available(subject, source);
    return available?.offered === true ? [{ subject, available }] : [];
  });
}

/** The reasons that say the same of each repository, by how they start, and what they say of the machine. */
const SHARED: readonly [string, string][] = [
  ['no watcher is running', 'no watcher is running'],
  ['no workflow in ', 'no repository has a workflow in .sail/workflows'],
];

/**
 * A row for an action that first asks which of the queues or repositories offering it to act on: left out when none
 * offers it, and disabled while none is enabled, with their reason when they share one, else with what a reason they
 * all start with says of the machine (`SHARED`), else with `otherwise`.
 */
function pickRow(
  label: string,
  offering: readonly { available: Extract<Availability, { offered: true }> }[],
  run: MenuRun,
  otherwise: string,
): MenuRow[] {
  if (offering.length === 0) return [];
  const enabled = offering.some((each) => each.available.enabled);
  const whys = [
    ...new Set(
      offering.flatMap(({ available }) => (available.enabled || available.why === undefined ? [] : [available.why])),
    ),
  ];
  const common = SHARED.find(([start]) => whys.every((each) => each.startsWith(start)))?.[1];
  const why = whys.length <= 1 ? whys[0] : (common ?? otherwise);
  return [{ group: 'general', label, disabled: !enabled, ...(enabled || why === undefined ? {} : { why }), run }];
}

/**
 * The actions that need no subject: the registry's (those with rows of their own, such as start anyway, by their
 * variants; an action whose key works in one view, such as the Inbox's dismiss, only in that view), starting a run,
 * adding a ticket, polling every queue, and the two view actions.
 */
export function generalRows(source: OfferSource): MenuRow[] {
  const none: Subject = { kind: 'none' };
  return [
    // A local action is always there; one that asks the server is there while its offers give it. One with rows of its
    // own, such as start anyway, is a row per variant.
    ...ACTIONS.filter(
      (def) => def.appliesTo.includes('none') && (def.keyIn === undefined || def.keyIn === source.view),
    ).flatMap((def): MenuRow[] => {
      const available = def.run === undefined ? def.available(none, source) : undefined;
      if (available !== undefined && !available.offered) return [];
      const disabled = available !== undefined && !available.enabled;
      const row = (label: string, data: Record<string, string>): MenuRow => ({
        group: 'general',
        label,
        ...(def.key === undefined ? {} : { key: def.key }),
        ...(disabled && available?.why !== undefined ? { why: available.why } : {}),
        disabled,
        run: { act: def.id, subject: none, data },
      });
      return def.variants === undefined
        ? [row(def.label(none), {})]
        : def.variants(none, source).map((variant) => row(variant.label, variant.data));
    }),
    ...pickRow(
      actionOf('start-run')?.label({ kind: 'none' }) ?? 'start a run…',
      reposOffering('start-run', source),
      { pick: 'start-run', of: 'repo' },
      'no repository can start a run',
    ),
    ...pickRow(
      actionOf('add-ticket')?.label({ kind: 'none' }) ?? 'add a ticket…',
      queuesOffering('add-ticket', source),
      { pick: 'add-ticket' },
      'no queue is watched from this clone',
    ),
    ...pickRow(
      'poll every queue',
      queuesOffering('poll-queue', source),
      { pollAll: true },
      'no queue is watched from this clone',
    ),
    { group: 'general', label: VIEW_ACTIONS['toggle-theme'].label, disabled: false, run: { view: 'toggle-theme' } },
    {
      group: 'general',
      label: VIEW_ACTIONS['toggle-inspector'].label,
      disabled: false,
      run: { view: 'toggle-inspector' },
    },
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

/** What a choice with no option says, in place of no row at all. */
const nothingToChoose = (label: string) => `no ${label} to choose`;

/**
 * The step: what it asks, the lines the action's dialog gives for the values so far (with `typed` as the value of a typed
 * step's parameter), and its rows. A choice lists its options, starting on its initial one, and says so when it has
 * none; the repository or the queue to pick lists each that offers the action, a disabled one with its reason.
 */
export function stepOf(step: MenuStep, source: OfferSource, typed = ''): StepModel {
  if ('pick' in step) {
    const label = step.pick === 'repo' ? 'repository' : 'queue';
    const offering = step.pick === 'repo' ? reposOffering(step.action, source) : queuesOffering(step.action, source);
    const rows = offering.map(({ subject, available }) => ({
      ...stepRow(
        subjectName(subject),
        subject.kind === 'workflow'
          ? { queue: { repo: subject.repo, workflow: subject.workflow } }
          : { repo: subject.kind === 'repo' ? subject.repo : '' },
      ),
      disabled: !available.enabled,
      ...(available.enabled || available.why === undefined ? {} : { why: available.why }),
    }));
    return {
      label,
      lines: rows.length === 0 ? [nothingToChoose(label)] : [],
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
    return {
      label,
      lines: rows.length === 0 ? [...lines, nothingToChoose(label)] : lines,
      rows,
      start: Math.max(0, start),
    };
  }
  const field =
    param.type === 'tick'
      ? { type: 'text' as const }
      : param.type === 'number'
        ? { type: 'number' as const, ...(param.min === undefined ? {} : { min: param.min }) }
        : { type: 'text' as const, ...(param.placeholder === undefined ? {} : { placeholder: param.placeholder }) };
  return { label, field, lines, rows: [], start: 0 };
}

/** The reason every one of `rows` is disabled, when there are two or more and they all give the same one. */
function sharedWhy(rows: readonly MenuRow[]): string | undefined {
  const why = rows[0]?.why;
  return rows.length > 1 && why !== undefined && rows.every((row) => row.disabled && row.why === why) ? why : undefined;
}

/**
 * Where a group of rows stands for `query`, lower first: one of actions with a label that is the query, starts with
 * it or has a word that does comes before "go to", unless "go to" leads with a view the query names, and "go to"
 * comes before one of actions that only match as a subsequence. Groups that stand alike keep their order.
 */
function standing(rows: readonly MenuRow[], query: string): number {
  const first = rows[0];
  if (first?.group === 'goto') return 'show' in first.run ? 0 : 1;
  return rows.some((row) => (labelTier(query, row.label) ?? 3) < 3) ? 0 : 2;
}

/**
 * What the menu draws: its head, its rows and the step open, if any. Without a step: the subject's group, then, in the
 * full menu, "go to" and the general group, which leaves out what the subject's group has. A query filters the action
 * groups by label, each ordered by how well its rows match (`labelTier`), and orders the groups by `standing`, so an
 * action the query names comes before every "go to" row. When every row of the subject is disabled for one reason, the
 * reason is said once, under the head. The context menu is the subject's group alone, unfiltered.
 */
export function menuRows(state: MenuState, source: OfferSource, index: readonly IndexRepo[], now: number): MenuModel {
  const head = chipOf(state.subject, index, now);
  const step = state.steps.at(-1);
  if (step !== undefined) {
    const model = stepOf(step, source, state.query);
    return { ...(head === undefined ? {} : { head }), rows: model.rows, step: model };
  }
  const all = state.subject === undefined ? [] : subjectRows(state.subject, source);
  const why = sharedWhy(all);
  const subject = why === undefined ? all : all.map(({ why: _, ...row }) => row);
  const top = { ...(head === undefined ? {} : { head }), ...(why === undefined ? {} : { why }) };
  if (state.mode === 'context') return { ...top, rows: subject };
  const shown = new Set(subject.map((row) => row.label));
  const general = generalRows(source).filter((row) => !shown.has(row.label));
  const query = state.query.trim();
  if (query === '') return { ...top, rows: [...subject, ...gotoRows(query, index, now), ...general] };
  const matching = (rows: MenuRow[]) =>
    rows
      .map((row) => ({ row, tier: labelTier(query, row.label) }))
      .filter((each) => each.tier !== undefined)
      .sort((a, b) => (a.tier ?? 3) - (b.tier ?? 3))
      .map((each) => each.row);
  const groups = [matching(subject), gotoRows(query, index, now), matching(general)]
    .filter((rows) => rows.length > 0)
    .sort((a, b) => standing(a, query) - standing(b, query));
  return { ...top, rows: groups.flat() };
}
