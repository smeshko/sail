// The `sail` entry: everything a repository's `.sail/` imports. The built-in intakes are `sail/intakes`.

export { z } from 'zod';
export {
  type Binding,
  type BindingKind,
  type Consumes,
  type FileBinding,
  type FromStep,
  type FromStepBinding,
  file,
  fromStep,
  type GitDiffBinding,
  gitDiff,
  type ProducedFile,
  type ValueBinding,
  value,
} from './bindings';
export { type Intake, type IntakeOptions, intake, type SourceKind } from './intake';
export {
  type AgentOptions,
  type AgentOutcome,
  type AgentStep,
  agent,
  type Budget,
  type ExitCodes,
  type KindOf,
  type OutcomeOf,
  type Permissions,
  type Produces,
  type ScriptOptions,
  type ScriptOutcome,
  type ScriptStep,
  type Stage,
  type StageDefinition,
  type StageOptions,
  type Step,
  type StepList,
  script,
  stage,
} from './steps';
