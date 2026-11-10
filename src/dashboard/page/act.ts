// Carries any action of the registry out, with the one state `ui.act` holds: `act(id, data)` resolves the action's
// subject from the click's `data-*`, checks the offer, reads the parameters, and then by tier arms a confirmed action on
// a first click and sends it on a second, or sends an instant one. The answer is the registry's to interpret
// (`answer()`), and what it asks the shell to do (reopen the run, open another, leave it, empty the field) the shell's
// `effects` perform. The only module that posts, and it names no endpoint: the request is the registry's.
//
// - A confirmed action is armed by a first click: `pending` is it, on its subject, unsent. A second click on the same
//   action and subject, with every `rearm` parameter unchanged, sends it. Any other click drops the confirmation.
// - A request the registry calls invalid arms nothing and shows why.
// - While a run action's request is out, another run action is ignored, until its answer, whatever took `pending` since.
// - What was typed for a parameter is read from the page (`host.value()`), else from its draft, and kept in
//   `ui.act.drafts`, which a draw reads back first (`keep`) so a typed field survives it.

import {
  ACTIONS,
  type ActionDef,
  actionOf,
  type OfferSource,
  type Param,
  type Subject,
  sameSubject,
  subjectOf,
  type Values,
} from './action-registry';
import type { PageHost, Region } from './host';
import type { ActPlace, UiState } from './ui-state';

export interface ActorEffects {
  /** Reads the run again, keeping its ⋯ menu open when `keepMenu`. */
  reopen(repo: string, runId: string, keepMenu: boolean): void;
  /** Opens the run `runId`. */
  open(repo: string, runId: string): void;
  /** Leaves the open run, which no longer exists. */
  leave(): void;
  /** Draws the field a change that took emptied as it is, not as it was typed. */
  took(): void;
  /** The local actions' effects, by the name their entry's `run` gives. */
  local: Record<string, () => void>;
}

export interface ActorDeps {
  host: Pick<PageHost, 'post' | 'value'>;
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
  /** Drops an unsent confirmation, unless it is `except`: whether it dropped one. */
  disarm(except?: { id: string; subject: Subject }): boolean;
  /** Whether `id` on the subject `data` names is armed, awaiting its second click. */
  armed(id: string, data: Readonly<Record<string, string>>): boolean;
  /** Reads the drawn parameters of the actions shown in `place` into the drafts, before a draw. */
  keep(place: 'run' | 'queue', subject?: Subject): void;
  /** Forgets what a run's actions hold: the pending one, the result shown in the run's menu and the drafts. */
  forget(kind: 'run'): void;
  /** Clears the last result shown at `place`. */
  clearResult(place: ActPlace): void;
}

const tickOf = (value: string) => (value === '' ? '' : 'on');

/** An actor that does nothing, until the shell wires the real one. */
export function inertActor(): Actor {
  return {
    act: () => {},
    disarm: () => false,
    armed: () => false,
    keep: () => {},
    forget: () => {},
    clearResult: () => {},
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

  const draftsOf = (id: string) => {
    state.drafts[id] ??= {};
    return state.drafts[id] as Record<string, string>;
  };

  function setResult(id: string, subject: Subject, place: ActPlace, text: string | undefined) {
    if (text === undefined) delete state.results[place];
    else state.results[place] = { id, subject, text, place };
  }

  /** Clears what `def` showed at its own place for `subject`, such as its sending line, and leaves any other's. */
  function clearOwn(def: ActionDef, subject: Subject) {
    const shown = state.results[def.place];
    if (shown !== undefined && shown.id === def.id && sameSubject(shown.subject, subject))
      delete state.results[def.place];
  }

  function disarm(except?: { id: string; subject: Subject }): boolean {
    const { pending } = state;
    if (pending === undefined || pending.sent) return false;
    if (except !== undefined && pending.id === except.id && sameSubject(pending.subject, except.subject)) return false;
    delete state.pending;
    return true;
  }

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

  function finish(def: ActionDef, subject: Subject, status: number, body: string) {
    if (subject.kind === 'run') runsOut--;
    if (deps.stopped()) return;
    const { pending } = state;
    if (pending?.sent === true && pending.id === def.id && sameSubject(pending.subject, subject)) delete state.pending;
    const answer = def.answer?.(status, body, subject) ?? { place: def.place };
    const { effect } = answer;
    const open = deps.openRun();
    const runEffect = effect !== undefined && effect !== 'took';
    const stillOpen = subject.kind === 'run' && open?.repo === subject.repo && open.runId === subject.runId;
    if (runEffect && !stillOpen) {
      clearOwn(def, subject);
    } else {
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
      clearOwn(def, subject);
      setResult(def.id, subject, answer.place, answer.text);
    }
    mark('rail', 'main');
    if (answer.place === 'rail' || effect === 'leave') mark('inspector', 'status');
  }

  function send(def: ActionDef, subject: Subject, values: Values, request: { path: string; body: unknown }) {
    if (def.tier === 'confirmed') state.pending = { id: def.id, subject, values: { ...values }, sent: true };
    if (subject.kind === 'run') runsOut++;
    if (def.sending !== undefined) setResult(def.id, subject, def.place, def.sending(subject));
    else if (subject.kind === 'run') delete state.results.run;
    mark('rail', 'main');
    void host.post(request.path, request.body).then(({ status, body }) => finish(def, subject, status, body));
  }

  function act(id: string, data: Readonly<Record<string, string>>) {
    const def = actionOf(id, registry);
    if (def === undefined) return;
    const subject = subjectOf(def.appliesTo, data, deps.openRun());
    if (subject === undefined) {
      if (disarm()) mark('rail', 'main');
      return;
    }
    if (subject.kind === 'run' && runsOut > 0) return;
    if (disarm({ id, subject })) mark('rail', 'main');
    if (def.run !== undefined) {
      effects.local[def.run]?.();
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
      delete state.pending;
      setResult(def.id, subject, def.place, request.invalid);
      mark('rail', 'main');
      return;
    }
    if (def.tier === 'confirmed') {
      const { pending } = state;
      const rearms = def.params(subject, source).filter((param) => param.type === 'choice' && param.rearm === true);
      const confirms =
        pending !== undefined &&
        !pending.sent &&
        pending.id === def.id &&
        sameSubject(pending.subject, subject) &&
        rearms.every((param) => pending.values[param.name] === values[param.name]);
      if (!confirms) {
        state.pending = { id: def.id, subject, values: { ...values }, sent: false };
        if (subject.kind === 'run') delete state.results.run;
        mark('rail', 'main');
        return;
      }
    }
    send(def, subject, values, request);
  }

  return {
    act,
    disarm: (except) => disarm(except),
    armed(id, data) {
      const def = actionOf(id, registry);
      const { pending } = state;
      if (def === undefined || pending === undefined || pending.sent || pending.id !== id) return false;
      const subject = subjectOf(def.appliesTo, data, deps.openRun());
      return subject !== undefined && sameSubject(pending.subject, subject);
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
      if (state.pending?.subject.kind === 'run') delete state.pending;
      delete state.results.run;
      for (const def of registry) if (def.appliesTo.includes('run')) delete state.drafts[def.id];
      stale.add('run');
    },
    clearResult(place) {
      delete state.results[place];
    },
  };
}
