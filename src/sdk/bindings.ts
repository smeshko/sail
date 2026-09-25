// Bindings: what a stage consumes, declared on the stage and supplied by the workflow or the engine.
// Each constructor returns a plain, frozen descriptor whose `kind` the engine reads. The brands exist only in types,
// so a workflow can't pass a hand-built object where a binding or a produced file is expected.

import type { z } from 'zod';

declare const bindingBrand: unique symbol;
declare const fileBrand: unique symbol;

/** A file a call produced, as the engine hands it to the workflow. Only the engine makes one. */
export interface ProducedFile {
  readonly [fileBrand]: true;
  readonly name: string;
}

export type BindingKind = 'file' | 'value' | 'gitDiff' | 'fromStep';

interface BindingBase<K extends BindingKind, Opt extends boolean> {
  readonly [bindingBrand]: K;
  readonly kind: K;
  /** Named `isOptional` because `optional` is the method that sets it. */
  readonly isOptional: Opt;
}

/** A binding the workflow supplies with a file some earlier call produced, of any name. */
export interface FileBinding<Opt extends boolean = boolean> extends BindingBase<'file', Opt> {
  /** The name the stage reads the file under. */
  readonly name: string;
  optional(): FileBinding<true>;
}

/** A binding the workflow supplies with a typed value, checked against `schema`. */
export interface ValueBinding<S extends z.ZodType = z.ZodType, Opt extends boolean = boolean>
  extends BindingBase<'value', Opt> {
  readonly schema: S;
  optional(): ValueBinding<S, true>;
}

/** A binding the engine resolves: the diff of the workspace over `range`. */
export interface GitDiffBinding<Opt extends boolean = boolean> extends BindingBase<'gitDiff', Opt> {
  readonly range: string;
  optional(): GitDiffBinding<true>;
}

/** A binding the engine resolves: the output of an earlier step in the same stage, one field of it, or a file it produced. */
export interface FromStepBinding<N extends string = string, Opt extends boolean = boolean>
  extends BindingBase<'fromStep', Opt> {
  readonly step: N;
  readonly key?: string;
  readonly file?: string;
  optional(): FromStepBinding<N, true>;
}

export type Binding = FileBinding | ValueBinding | GitDiffBinding | FromStepBinding;

/** What a stage or step consumes: its bindings by name. */
export type Consumes = Record<string, Binding>;

/** Picks a binding from an earlier step of the same stage. */
export interface FromStep<N extends string> {
  /** The step's whole output, or the field `key` of it. */
  output(key?: string): FromStepBinding<N, false>;
  /** A file the step produced. */
  file(name: string): FromStepBinding<N, false>;
}

const bindingMethods = {
  optional(this: object) {
    return describe({ ...this, isOptional: true });
  },
};

function describe<B>(fields: object): B {
  return Object.freeze(Object.assign(Object.create(bindingMethods), fields));
}

/** Binds a file, by the name the stage reads it under. The workflow supplies a file an earlier call produced. */
export function file(name: string): FileBinding<false> {
  return describe({ kind: 'file', name, isOptional: false });
}

/** Binds a typed value. The workflow supplies a value of the schema's type, such as another call's output. */
export function value<S extends z.ZodType>(schema: S): ValueBinding<S, false> {
  return describe({ kind: 'value', schema, isOptional: false });
}

/** Binds the diff of the workspace over a git range, such as `origin/main...HEAD`. The engine resolves it. */
export function gitDiff(range: string): GitDiffBinding<false> {
  return describe({ kind: 'gitDiff', range, isOptional: false });
}

/** Starts a binding to an earlier step of the same stage: `.output()`, `.output(key)` or `.file(name)`. */
export function fromStep<const N extends string>(step: N): FromStep<N> {
  return {
    output: (key) =>
      describe(
        key === undefined
          ? { kind: 'fromStep', step, isOptional: false }
          : { kind: 'fromStep', step, key, isOptional: false },
      ),
    file: (name) => describe({ kind: 'fromStep', step, file: name, isOptional: false }),
  };
}
