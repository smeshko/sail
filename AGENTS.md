# AGENTS.md

## What this is

sail is a software factory: a ticket goes in and a pull request comes out, along a workflow the repository defines.
[`CONTEXT.md`](CONTEXT.md) is its glossary.

## Commands

Bun `>=1.3.14` is the only runtime. No command needs Node.

- `bun install`: installs dependencies and points `core.hooksPath` at `.githooks`, so the pre-push hook runs `verify`.
- `bun run verify`: typecheck, lint, then tests with the coverage gate. A change is green when this passes.
- `bun run test [path]`: tests without the coverage gate. A path filters the run.
- `bun run typecheck`, `bun run lint`, `bun run fix`: `tsc --noEmit`, `biome check`, and `biome check --write`.
- `npm link`, then `sail --version` from any directory: puts this checkout's `sail` bin on the `PATH`. `bun link` does
  the same once `~/.bun/bin` is on the `PATH`.

## Branches and PRs

- `staging` is the base branch, and every PR targets it. `main` receives releases.
- Branch names carry the Linear issue id, as in `chore/adw-77-<slug>`. One commit per task, in Conventional Commits.
- Stage files by name: `git add <paths>`.
- `staging` is protected, admins included. Every change lands through a PR whose `verify` check is green on a head that
  contains the latest `staging`. The pre-push hook runs the same `bun run verify`, so a red check shows up before the
  push.

## Tracker

Linear, team `ADW`. Issues are `ADW-<n>`. Apply every label that fits:

- Type: `feature`, `bug`, `refactoring`
- Platform: `core`, `cli`, `dashboard`
- Source: `dogfooding`, `code-review`, `field-report`
- `epic` marks an epic's parent issue.

## Vocabulary

`CONTEXT.md` is the glossary. Identifiers, event names, schemas, docs, commit messages and PR text use its terms, and
replace the synonyms each entry lists under `_Avoid_`. When a term is missing, add it to `CONTEXT.md` first, then use it.

## Tests

- Run tests with `bun run test`. Bun reads `HOME` once at startup, so `scripts/test.ts` starts `bun test` with a
  throwaway `HOME` and git identity. Plain `bun test` refuses to run.
- Anything that touches git or `HOME` runs inside `withTempRepo()` from `test/helpers/temp-repo.ts`, and passes
  `repo.env` to every spawn: Bun spawns inherit the startup environment, not a mutated `process.env`.
- Tests live under `test/`, mirroring `src/`: `test/cli/run.test.ts` tests `src/cli/index.ts`.
- `src/` modules have no import-time side effects, because `test/coverage-census.test.ts` imports every one of them.
  The bin shim `src/cli/main.ts` is the one exception.
- Type tests live in `test/types/`. Each `// @ts-expect-error TSnnnn: <why>` names the code its next line fails with,
  and `test/types/expect-error.test.ts` proves it on a temp copy, so cases import only `sail` and `sail/intakes`.
- Every `src/` file needs 80% line coverage on its own: Bun applies the threshold per file. Reach it by testing the
  branch. A file that genuinely can't goes in `coveragePathIgnorePatterns` in `bunfig.toml`, where review sees it.

## Done means demonstrated

A change is done when its behaviour is shown at runtime, through test output, a command transcript or a log excerpt. A
clean compile or a diff that looks right is not the bar.

## Public repository

This repository is public. Design docs, ADRs and plans stay outside git, as `.gitignore` shows. Committed files, commit
messages and PR bodies name only sail and its `ADW-<n>` issues. Private projects and other trackers' tickets stay out,
including as examples in this file.

## Layout

- `src/sdk`: what a repository imports from `sail`: `workflow()`, `stage()`, `agent()`, `script()`, `intake()` and the
  run helpers. `src/sdk/intakes.ts` is `sail/intakes`, the built-in intakes.
- `src/engine`: loads `project.yaml`, claims a source, leases its branch, runs intake and stages, validates and
  journals.
- `src/ports`: the interfaces to outside systems: TicketSource, CodeHost, Harness, Workspace.
- `src/adapters`: one per port (linear, github, claude-code, git-worktree), plus a fake of each.
- `src/kinds`: step kinds, agent and script. `StepKind` is the extension point.
- `src/events`: the event bus and its consumers: `events.ndjson`, the terminal, `summary.json`.
- `src/watch`: the per-repository watcher: poll, queue, claim, and dispatch detached runs.
- `src/dashboard`: reads the watcher registry, the branch leases and run files across the machine.
- `src/cli`: the `sail` command. `src/cli/main.ts` is the bin.
- `schemas/`: the JSON Schemas for a run directory and `project.yaml`, `sail.*.v1`.
- `test/fixtures/`: `repo/` is the fixture repository and `runs/` the golden run directories. Both are data, edited by
  hand when a schema changes.
