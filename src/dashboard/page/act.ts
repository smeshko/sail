// Carries any action of the registry out, with the one state `ui.act` holds: `act(id, data)` resolves the action's
// subject from the click's `data-*`, checks the offer, reads the parameters, and then by tier opens the confirmation
// dialog (a confirmed action, sent when `confirm()` is called), or sends at once (an instant or undoable one). The
// answer is the registry's to interpret (`answer()`) and is always a toast, and what it asks the shell to do (reopen
// the run, open another, leave it, empty the field) the shell's `effects` perform. The only module that posts, and it
// names no endpoint: the request is the registry's.
//
// - One dialog is open at most. Confirming clears it before it sends, so a second confirm does nothing. Cancelling, or
//   the shell closing it, sends nothing.
// - An undoable action's ok toast carries an Undo that posts the reverse the registry names, read at the click.
// - A request the registry calls invalid sends nothing and is a red toast.
// - While a run action's request is out, another run action is ignored, until its answer.
// - While a request is out, `ui.underway` holds the word its subject's row reads in place of its status.
// - What was typed for a parameter is read from the page (`host.value()`), else from its draft, and kept in
//   `ui.act.drafts`, which a draw reads back first (`keep`) so a typed field survives it.

import {
  ACTIONS,
  type ActionDef,
  type ActResult,
  actionOf,
  type OfferSource,
  type Param,
  type Subject,
  subjectName,
  subjectOf,
  underwayId,
  type Values,
} from './action-registry';
import { renderDialog } from './dialog-view';
import type { PageHost, Region } from './host';
import type { UiState } from './ui-state';

export interface ActorEffects {
  /** Reads the run again, keeping its ⋯ menu open when `keepMenu`. */
  reopen(repo: string, runId: string, keepMenu: boolean): void;
  /** Opens the run `runId`. */
  open(repo: string, runId: string): void;
  /** Leaves the open run, which no longer exists. */
  leave(): void;
  /** Draws the field a change that took emptied as it is, not as it was typed. */
  took(): void;
  /** Puts a toast on the stack. */
  toast(kind: 'ok' | 'bad', head: string, text: string, undo?: () => void): void;
  /** The local actions' effects, by the name their entry's `run` gives: the text of their toast and what undoes them. */
  local: Record<string, () => { text: string; undo: () => void } | undefined>;
}

export interface ActorDeps {
  host: Pick<PageHost, 'post' | 'value' | 'openDialog' | 'closeDialog'>;
  ui: UiState;
  source(): OfferSource;
  openRun(): { repo: string; runId: string } | undefined;
  effects: ActorEffects;
  mark(...regions: Region[]): void;
  stopped(): boolean;
  /** The actions it carries out: the registry's, unless a test gives its own. */
  registry?: readonly ActionDef[];
}

export interface Actor {
  /** Carries out action `id` for the subject `data` names. */
  act(id: string, data: Readonly<Record<string, string>>): void;
  /** Reads the drawn parameters of the actions shown in `place` into the drafts, before a draw. */
  keep(place: 'run' | 'queue', subject?: Subject): void;
  /** Forgets what a run's actions hold: an open dialog for it and the drafts. */
  forget(kind: 'run'): void;
  /** The subject of the confirmation dialog open now, if any. */
  dialogFor(): Subject | undefined;
  /** Confirms the open dialog: it sends what it asks, once. */
  confirm(): void;
  /** Closes the open dialog and sends nothing. */
  cancel(): void;
}

const tickOf = (value: string) => (value === '' ? '' : 'on');

/** An actor that does nothing, until the shell wires the real one. */
export function inertActor(): Actor {
  return {
    act: () => {},
    keep: () => {},
    forget: () => {},
    dialogFor: () => undefined,
    confirm: () => {},
    cancel: () => {},
  };
}

export function createActor(deps: ActorDeps): Actor {
  const { host, ui, effects, mark } = deps;
  const registry = deps.registry ?? ACTIONS;
  const state = ui.act;
  /** The places whose fields the shell has just given up: the next `keep` leaves the page's stale values alone. */
  const stale = new Set<string>();
  /** How many run actions' requests are out: until each is answered, another run action is ignored. */
  let runsOut = 0;
  /** The confirmation dialog open: who it is for, and what its confirm sends. */
  let dialog: { subject: Subject; send(): void } | undefined;

  const draftsOf = (id: string) => {
    state.drafts[id] ??= {};
    return state.drafts[id] as Record<string, string>;
  };

  /** What the page holds for `param`: its field, else its draft, else the choice it starts at. */
  function typed(def: ActionDef, param: Param, data: Readonly<Record<string, string>>): string | undefined {
    if (param.given !== undefined) return data[param.name];
    const drafts = draftsOf(def.id);
    let value = host.value(param.dom) ?? drafts[param.name];
    if (value === undefined && param.type === 'choice' && param.tick !== true) value = param.initial;
    if (value !== undefined && param.type === 'choice' && param.tick === true) value = tickOf(value);
    if (value !== undefined) drafts[param.name] = value;
    return value;
  }

  function read(def: ActionDef, subject: Subject, data: Readonly<Record<string, string>>): Values {
    const values: Record<string, string> = {};
    for (const param of def.params(subject, deps.source())) {
      const value = typed(def, param, data);
      if (value !== undefined) values[param.name] = value;
    }
    return values;
  }

  /** The head of `def`'s toast: `<verb> <subject>`. */
  const headOf = (def: ActionDef, subject: Subject) => `${def.label(subject)} ${subjectName(subject)}`.trim();

  /** The toast an answer is: `<verb> <subject>`, then sail's own words, with an Undo on a success when it has one. */
  function say(def: ActionDef, subject: Subject, status: number, answer: ActResult, undo?: () => void) {
    const head = headOf(def, subject);
    if (answer.refused === true) effects.toast('bad', head, answer.text ?? `the ${def.label(subject)} was refused`);
    else effects.toast('ok', head, answer.text ?? (status === 200 ? 'done' : 'asked'), undo);
  }

  type Undo = NonNullable<ReturnType<NonNullable<ActionDef['undo']>>>;

  /** Posts what reverses an undoable action, and toasts its answer as the action it was. */
  function reverse(subject: Subject, undo: Undo) {
    const reverser = actionOf(undo.action, registry);
    if (reverser === undefined) return;
    void host.post(undo.path, undo.body).then(({ status, body }) => {
      if (deps.stopped()) return;
      say(reverser, subject, status, reverser.answer?.(status, body, subject) ?? {});
      mark('list', 'main');
    });
  }

  function finish(def: ActionDef, subject: Subject, status: number, body: string, undo?: Undo) {
    if (subject.kind === 'run') runsOut--;
    if (deps.stopped()) return;
    const answer = def.answer?.(status, body, subject) ?? {};
    const { effect } = answer;
    delete ui.underway[underwayId(def, subject)];
    const open = deps.openRun();
    const runEffect = effect !== undefined && effect !== 'took';
    const stillOpen = subject.kind === 'run' && open?.repo === subject.repo && open.runId === subject.runId;
    if (!(runEffect && !stillOpen)) {
      if (effect === 'reopen' && subject.kind === 'run')
        effects.reopen(subject.repo, subject.runId, answer.keepMenu === true);
      else if (effect === 'leave') effects.leave();
      else if (typeof effect === 'object' && subject.kind === 'run') effects.open(subject.repo, effect.open);
      else if (effect === 'took') {
        // A change that took empties the text typed for it, and keeps what was ticked. One with no text of its own,
        // such as a poll or a drop, leaves every field as it is typed.
        const texts = def
          .params(subject, deps.source())
          .filter((param) => param.type === 'text' && param.given === undefined);
        if (texts.length > 0) {
          const drafts = draftsOf(def.id);
          for (const param of texts) delete drafts[param.name];
          stale.add(def.place === 'run' ? 'run' : 'queue');
          effects.took();
        }
      }
    }
    say(def, subject, status, answer, undo === undefined ? undefined : () => reverse(subject, undo));
    mark('list', 'main');
    if (effect === 'leave') mark('sidebar', 'inspector', 'status');
  }

  function send(def: ActionDef, subject: Subject, request: { path: string; body: unknown }, undo: Undo | undefined) {
    if (subject.kind === 'run') runsOut++;
    if (def.underway !== undefined) ui.underway[underwayId(def, subject)] = def.underway;
    mark('list', 'main');
    void host.post(request.path, request.body).then(({ status, body }) => finish(def, subject, status, body, undo));
  }

  function act(id: string, data: Readonly<Record<string, string>>) {
    const def = actionOf(id, registry);
    if (def === undefined) return;
    const subject = subjectOf(def.appliesTo, data, deps.openRun());
    if (subject === undefined) return;
    if (subject.kind === 'run' && runsOut > 0) return;
    if (def.run !== undefined) {
      const done = effects.local[def.run]?.();
      if (done !== undefined) effects.toast('ok', headOf(def, subject), done.text, done.undo);
      return;
    }
    const source = deps.source();
    const available = def.available(subject, source);
    if (!available.offered) return;
    if (!available.enabled && def.holdsDisabled === true) return;
    const values = read(def, subject, data);
    const request = def.request?.(subject, values, source);
    if (request === undefined) return;
    if ('invalid' in request) {
      effects.toast('bad', headOf(def, subject), request.invalid);
      mark('list', 'main');
      return;
    }
    const undo = def.undo?.(subject, source);
    if (def.tier === 'confirmed' && def.dialog !== undefined) {
      const view = def.dialog(subject, values, source);
      dialog = { subject, send: () => send(def, subject, request, undo) };
      ui.dialog = view;
      host.openDialog(renderDialog(view).value);
      // What was typed for its parameters is kept in the drafts, and drawn again.
      mark('list', 'main');
      return;
    }
    send(def, subject, request, undo);
  }

  function closeDialog() {
    if (dialog === undefined) return undefined;
    const { send: confirmed } = dialog;
    dialog = undefined;
    delete ui.dialog;
    host.closeDialog();
    return confirmed;
  }

  return {
    act,
    dialogFor: () => dialog?.subject,
    confirm() {
      // The dialog is cleared first, so the click a browser makes of Enter on its focused button finds nothing to do.
      closeDialog()?.();
    },
    cancel() {
      closeDialog();
    },
    keep(place, subject) {
      if (stale.delete(place)) return;
      const at = place === 'run' ? deps.openRun() : undefined;
      const where: Subject | undefined =
        place === 'run' ? (at === undefined ? undefined : { kind: 'run', ...at }) : subject;
      if (where === undefined) return;
      const source = deps.source();
      for (const def of registry) {
        if (def.run !== undefined || def.place !== place) continue;
        for (const param of def.params(where, source)) {
          if (param.given !== undefined) continue;
          const value = host.value(param.dom);
          if (value === undefined) continue;
          draftsOf(def.id)[param.name] = param.type === 'choice' && param.tick === true ? tickOf(value) : value;
        }
      }
    },
    forget() {
      if (dialog?.subject.kind === 'run') closeDialog();
      for (const def of registry) if (def.appliesTo.includes('run')) delete state.drafts[def.id];
      stale.add('run');
    },
  };
}
