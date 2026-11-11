// The page's keys, declared once. `NAV` is the table of the fixed navigation keys: what each does is `keys.ts`'s, by
// the entry's id, and `keys.ts` finds a key's entry only here, so a key handled is a key listed. The registry's actions
// carry their own keys (`ActionDef.key`, `variantKeys`), done to the focused subject (`key-act.ts`). The shortcut sheet
// (`keys-view.ts`) lists both, grouped, and every tooltip and menu row that names a key draws it with `keyLabel()`.
// Pure: data and the words for it.
//
// A key is written as the handler receives it: a letter in its case (`S` is Shift+S), a `KeyboardEvent.key` name
// (`Backspace`, `ArrowDown`), `Alt+` or `Mod+` (Cmd or Ctrl) before a chord's key, and a space between the two keys of
// a sequence (`g q` is G then Q).
import { ACTIONS, type ActionDef } from './action-registry';

export const KEY_GROUPS = ['Global', 'List', 'Run', 'Queue item', 'Inbox'] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number];

export interface NavKey {
  id: string;
  /** Each key that does it; the sheet shows them in this order. */
  keys: readonly string[];
  group: KeyGroup;
  /** What it does, as the sheet says it. */
  text: string;
}

export const NAV = [
  { id: 'menu', keys: ['Mod+k'], group: 'Global', text: 'commands' },
  { id: 'filter', keys: ['/'], group: 'Global', text: 'filter the list' },
  { id: 'sheet', keys: ['?'], group: 'Global', text: 'these keys' },
  { id: 'inbox', keys: ['g i', '1'], group: 'Global', text: 'go to Inbox' },
  { id: 'active', keys: ['g a', '2'], group: 'Global', text: 'go to Active' },
  { id: 'queues', keys: ['g q', '3'], group: 'Global', text: 'go to Queues' },
  { id: 'history', keys: ['g h', '4'], group: 'Global', text: 'go to History' },
  { id: 'pane', keys: ['w'], group: 'Global', text: 'give the keys to the other pane' },
  { id: 'inspector', keys: ['i'], group: 'Global', text: 'pin the inspector' },
  { id: 'back', keys: ['Escape'], group: 'Global', text: 'back one level' },
  { id: 'down', keys: ['j', 'ArrowDown', 'ArrowRight'], group: 'List', text: 'move down' },
  { id: 'up', keys: ['k', 'ArrowUp', 'ArrowLeft'], group: 'List', text: 'move up' },
  { id: 'open', keys: ['Enter'], group: 'List', text: 'open the row, or the card' },
  { id: 'select', keys: ['x'], group: 'List', text: 'select several (History)' },
  { id: 'row-menu', keys: ['.'], group: 'List', text: "the row's actions" },
  { id: 'copy', keys: ['Mod+.'], group: 'List', text: 'copy the id' },
  { id: 'link', keys: ['o'], group: 'Run', text: 'open its pull request, else its ticket' },
  { id: 'log', keys: ['l'], group: 'Run', text: 'log' },
  { id: 'files', keys: ['f'], group: 'Run', text: 'files' },
  { id: 'previous', keys: ['['], group: 'Run', text: 'previous call' },
  { id: 'next', keys: [']'], group: 'Run', text: 'next call' },
  { id: 'undo', keys: ['z'], group: 'Inbox', text: "undo the newest toast's action" },
] as const satisfies readonly NavKey[];

export type NavId = (typeof NAV)[number]['id'];

/** The first key of each sequence: `g`, which waits for the next key. */
export const LEADS: ReadonlySet<string> = new Set(
  NAV.flatMap((entry): string[] => entry.keys.flatMap((key) => (key.includes(' ') ? [key.split(' ')[0] ?? ''] : []))),
);

/** The navigation entry `key` does. */
export const navOf = (key: string): NavKey | undefined =>
  (NAV as readonly NavKey[]).find((entry) => entry.keys.includes(key));

/** An action's key as the sheet lists it: the action, its row when it has rows, and the key. */
export interface ActionKey {
  def: ActionDef;
  key: string;
  /** The label of the row the key does, for an action with rows of its own. */
  variant?: string;
}

/** Every key the registry's actions have, in the registry's order. */
export function actionKeys(registry: readonly ActionDef[] = ACTIONS): ActionKey[] {
  return registry.flatMap((def): ActionKey[] => [
    ...(def.key === undefined ? [] : [{ def, key: def.key }]),
    ...Object.entries(def.variantKeys ?? {}).map(([variant, key]) => ({ def, key, variant })),
  ]);
}

/** The group an action's key is listed under: the Inbox's own, else by the subject it is done to. */
export function groupOf(def: ActionDef): KeyGroup {
  if (def.keyIn === 'inbox') return 'Inbox';
  return def.appliesTo.includes('run') ? 'Run' : 'Queue item';
}

const NAMES: Readonly<Record<string, string>> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backspace: '⌫',
  Enter: '↵',
  Escape: 'Esc',
  Alt: '⌥',
  Mod: '⌘',
};

/** How a key is drawn, one label per key of a sequence: `S` is `⇧S`, `Alt+ArrowUp` is `⌥↑`, `g q` is `G`, `Q`. */
export function keyLabels(key: string): string[] {
  return key.split(' ').map((one) =>
    one
      .split('+')
      .map((part, _, parts) => {
        if (NAMES[part] !== undefined) return NAMES[part];
        if (/^[A-Z]$/.test(part) && parts.length === 1) return `⇧${part}`;
        return part.toUpperCase();
      })
      .join(''),
  );
}

/** A key as one label, the keys of a sequence joined by a space: what a tooltip says and a menu row's box holds. */
export const keyLabel = (key: string): string => keyLabels(key).join(' ');

/** A button's tooltip with its key: `stop (S)`. */
export const withKey = (title: string, key: string | undefined): string =>
  key === undefined ? title : `${title} (${keyLabel(key)})`;
