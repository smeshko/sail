// Generated from src/sdk by `bun run types`. Do not edit.
/** A fact a validator derives from a document: what `result.json`'s `derived` can hold. */
export type DerivedValue = number | string | boolean | readonly (number | string | boolean)[];
/** A list item at the top level of its list. `checked` is set only for a task item: `- [ ]` or `- [x]`. */
export interface DocumentItem {
    readonly checked?: boolean;
}
/** A heading: its text, trimmed, and its level, 1 for `#`. */
export interface DocumentHeading {
    readonly text: string;
    readonly level: number;
}
/** One heading's section: the top-level list items from it up to the next heading of the same or a higher level. */
export interface DocumentSection {
    readonly heading: string;
    readonly level: number;
    readonly items: readonly DocumentItem[];
}
/** A produced document as the engine parsed it, which every validator is handed. */
export interface DocumentContent {
    /** The file's name in `$STAGE_OUT`. */
    readonly name: string;
    readonly text: string;
    /** Every heading, in order. Fenced code holds none. */
    readonly headings: readonly DocumentHeading[];
    /** One per heading, in order. */
    readonly sections: readonly DocumentSection[];
    /** Every top-level list item of the document, in order. */
    readonly items: readonly DocumentItem[];
}
/** What a validator found: each problem as one plain sentence, and the facts it derived, by key. */
export interface Verdict {
    readonly problems: readonly string[];
    readonly derived?: Readonly<Record<string, DerivedValue>>;
}
/** A check of a document. A repository may write its own. */
export interface Validator {
    /** The check's label, as `result.json` and the `file:validated` event list it. */
    readonly check: string;
    /** The keys of every fact it may derive. Two validators of one step can't derive the same key. */
    readonly derives: readonly string[];
    validate(document: DocumentContent): Verdict;
}
/** A file an agent step completes in place: its template, rendered before the session, and its validators. */
export interface Document {
    readonly kind: 'document';
    /** The template, relative to the stage directory. */
    readonly template: string;
    readonly validators: readonly Validator[];
}
/** The bounds a count must keep. Each is a whole number of 0 or more, and `min` is no more than `max`. */
export interface Bounds {
    readonly min?: number;
    readonly max?: number;
}
/** Bounds, and the key the count is derived under. */
export interface CountOptions extends Bounds {
    readonly as?: string;
}
/**
 * Declares a document in an agent step's `produces`: `template` is rendered into `$STAGE_OUT` before the session,
 * with the step's bindings filled and its `{{name: hint}}` placeholders left for the agent, and `validators` check
 * what the session left there.
 */
export declare function doc(template: string, validators?: readonly Validator[]): Document;
/** Passes when every name is a heading's text, at any level. */
export declare function hasSections(...names: string[]): Validator;
/** Passes when no `{{name: hint}}` placeholder is left: a tag whose body holds a colon, as the renderer reads one. */
export declare function noPlaceholders(): Validator;
/**
 * Counts the top-level list items of `section`, from its heading to the next heading of the same or a higher level,
 * and passes when the section exists and the count is within the bounds. The count is derived under `as`, by default
 * the section's words in camelCase.
 */
export declare function countItems(section: string, options?: CountOptions): Validator;
/**
 * Counts the document's top-level task items, `- [ ]` and `- [x]`, and passes when the count is within the bounds.
 * The count is derived under `as`, `checklist` by default, and the checked ones under `as` + `Done`.
 */
export declare function checklist(options?: CountOptions): Validator;
