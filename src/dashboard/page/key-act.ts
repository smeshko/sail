// A key of the registry's actions (`ActionDef.key`, `variantKeys`), done to the focused subject: the row under the
// list's cursor while the list has the keys, else the open run or queue, else the row under the pointer (`focus.ts`
// resolves it, as it does for the command menu); with a queue item's ⋯ menu open, that item. The key goes through the
// actor as the action's button does, so a confirmed action opens its confirmation dialog and one that asks in its
// dialog asks there. One whose parameter is typed beside its button (add's ticket key) opens the command menu at that
// step, as its command-menu row does. A key whose action can't be done says why in a red toast: no subject it applies
// to, not offered, or disabled with the server's reason. A run that isn't open has its offers read first, and the key
// is done once they land.
import { type ActionDef, type Subject, subjectName } from './action-registry';
import { focused, syncOpen } from './focus';
import { type ActionKey, actionKeys, keyLabel } from './keymap';
import { askInMenu } from './menu';
import { subjectData } from './menu-model';
import { readSubjectOffers } from './reads';
import { openQueue, type Store, sourceFor } from './store';
import { toast } from './toast';

/** The subject a key acts on: an open item menu's item, else the focused subject. */
export function keySubject(store: Store): Subject | undefined {
  syncOpen(store);
  const panel = openQueue(store);
  const { itemMenu } = store.ui;
  if (panel !== undefined && itemMenu !== undefined)
    return { kind: 'item', repo: panel.repo, workflow: panel.workflow, item: itemMenu };
  return focused(store.ui);
}

/** What a key's action needs, said when none is focused. */
const NEEDS: Record<string, string> = {
  run: "a run: open one, or put the list's cursor on one",
  item: 'a queue item: point at one, or open its ⋯',
  workflow: "a queue: open one, or put the list's cursor on one",
};

const labelOf = ({ def, variant }: ActionKey) => variant ?? def.label({ kind: 'none' });

/** Whether `bound` can be done to `subject` in the view shown: an Inbox action anywhere in the Inbox. */
const fits = (store: Store, def: ActionDef, subject: Subject | undefined) =>
  def.keyIn === undefined ? def.appliesTo.includes(subject?.kind ?? 'none') : def.keyIn === store.ui.view;

/** Whether `def` has a parameter typed beside its button, which a key can't give: the command menu asks it. */
const typesParams = (def: ActionDef, subject: Subject, store: Store) =>
  def
    .params(subject, sourceFor(store, subject))
    .some((param) => param.given === undefined && param.ask !== 'dialog' && param.type !== 'tick');

/** Does the action `key` names to the focused subject, or says why not. False when no action has the key. */
export function actOnKey(store: Store, key: string, retried = false): boolean {
  const bound = actionKeys().filter((each) => each.key === key);
  if (bound.length === 0) return false;
  const subject = keySubject(store);
  const hit = bound.find((each) => fits(store, each.def, subject));
  if (hit === undefined) {
    // One action says what it needs; two that share the key each say it, by name.
    const why = bound.map((each) => {
      const needs =
        each.def.keyIn === 'inbox'
          ? 'works in the Inbox'
          : `needs ${NEEDS[each.def.appliesTo[0] ?? ''] ?? 'a subject'}`;
      return bound.length === 1 ? needs : `${labelOf(each)} ${needs}`;
    });
    toast(store, 'bad', `${bound.map(labelOf).join(' or ')} (${keyLabel(key)})`, why.join('; '));
    return true;
  }
  const { def, variant } = hit;
  if (subject === undefined || def.keyIn !== undefined) {
    store.actor.act(def.id, {});
    return true;
  }
  const head = `${labelOf(hit)} ${subjectName(subject)}`;
  let source = sourceFor(store, subject);
  if (subject.kind === 'run' && source.run === undefined && !retried) {
    // A run that isn't open: its offers are read, and the key is done once they land.
    void readSubjectOffers(store, subject)?.then(() => {
      if (!store.stopped) actOnKey(store, key, true);
    });
    return true;
  }
  source = sourceFor(store, subject);
  const available = def.available(subject, source);
  if (!available.offered || !available.enabled) {
    const why =
      available.why ??
      (subject.kind === 'run' && source.run === undefined ? "its actions can't be read" : 'not offered');
    toast(store, 'bad', head, why);
    return true;
  }
  const row =
    variant === undefined ? undefined : def.variants?.(subject, source).find((each) => each.label === variant);
  if (variant !== undefined && row === undefined) {
    toast(store, 'bad', head, `${subjectName(subject)} has no ${variant}`);
    return true;
  }
  const data = { ...subjectData(subject), ...row?.data };
  if (typesParams(def, subject, store)) askInMenu(store, def.id, subject, data);
  else store.actor.act(def.id, data);
  return true;
}
