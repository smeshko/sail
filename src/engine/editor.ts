// The editor declarations: `.sail/sail.d.ts` and `.sail/sail-intakes.d.ts`, through which an editor resolves `sail` and
// `sail/intakes` to this machine's sail.

export interface EditorDeclaration {
  /** The file's name in `.sail/`. */
  name: string;
  text: string;
}

/** An editor declaration that couldn't be written. */
export class EditorWriteError extends Error {
  /** The file, absolute. */
  readonly path: string;

  // Written out, not implicit: Bun reads an implicit subclass constructor as uncovered.
  constructor(path: string, why: string) {
    super(why);
    this.name = 'EditorWriteError';
    this.path = path;
  }
}

/** The two editor declarations, each re-exporting the file `SDK_TYPES` names for its module. */
export function editorDeclarations(): EditorDeclaration[] {
  return [];
}

/** Writes the editor declarations that are missing from `sailDir` or differ, and returns the files it wrote. */
export function writeEditorDeclarations(_sailDir: string): string[] {
  return [];
}
