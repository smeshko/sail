// What the actor (`act.ts`) is given and what it offers: the effects the shell performs for it, its dependencies, and
// the calls the shell makes on it. Types only.
import type { ActionDef, OfferSource, SeveralRun, Subject, Values } from './action-registry';
import type { PageHost, Region } from './host';
import type { UiState } from './ui-state';

type Data = Readonly<Record<string, string>>;

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
  toast(kind: 'ok' | 'bad', head: string, text: string, undo?: () => void, label?: string): void;
  /** The local actions' effects, by the name their entry's `run` gives: the text of their toast and what undoes them. */
  local: Record<string, (data: Data) => { text: string; undo: () => void } | undefined>;
}

export interface ActorDeps {
  host: Pick<PageHost, 'post' | 'value' | 'openDialog' | 'closeDialog' | 'dialogValue' | 'redrawDialog'>;
  ui: UiState;
  /** What the offers say for `subject`: a run that is not open has its own. */
  source(subject?: Subject): OfferSource;
  openRun(): { repo: string; runId: string } | undefined;
  effects: ActorEffects;
  mark(...regions: Region[]): void;
  stopped(): boolean;
  /** The actions it carries out: the registry's, unless a test gives its own. */
  registry?: readonly ActionDef[];
}

export interface Actor {
  /** Carries out action `id` for the subject `data` names. */
  act(id: string, data: Data, values?: Values): void;
  /**
   * Carries out `id` over `runs`: one dialog listing each, then a request per run that can, in order. False when it took
   * nothing: a run request is still out, which a red toast says, or the action has no several form.
   */
  actSeveral(id: string, runs: readonly SeveralRun[]): boolean;
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
  /** A field of the open dialog changed: reads its fields and draws its lines again. */
  changed(): void;
}
