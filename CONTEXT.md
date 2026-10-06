# sail

sail is a software factory: a ticket goes in and a pull request comes out, along a workflow the repository defines. The engine, the SDK, the ports and every adapter share this language, and every identifier, schema and event name follows it.

## Language

### Product

**sail**:
The tool: one package and one command that runs a repository's workflows. Also the word in every name the tool owns (`.sail/`, `sail.result.v1`).
_Avoid_: factory (as a name), the loop, ADW

**Software factory**:
The kind of system sail is. Names the concept, never the tool.
_Avoid_: pipeline, bot, the agent (for the whole)

### Input

**Source**:
What a run was started from: a ticket key such as `ADW-23`, or a pull request. It comes from the CLI or from the watcher's queue, and intake resolves it into the input.
_Avoid_: trigger, argument, request

**Input**:
The typed value a workflow needs. Its intake's output schema fixes the shape, and it is produced from the source. "Input" on its own always means this; what a stage consumes is a binding.
_Avoid_: stage input, context, payload

**Intake**:
How a run gets its input. Before any workflow code runs, the engine takes the source, fetches what it points to and builds the typed input the workflow needs. Each workflow names the intake it uses, and workflow code can never call one.
_Avoid_: intake stage, fetch, ingest, load

**Ticket**:
A unit of work in a ticket system. The TicketSource port always gives it the same shape, whatever the provider.
_Avoid_: issue, work item, task, story (each is one provider's word)

**Ticket key**:
The ticket's human-readable identifier, such as `ADW-23`. Always say "ticket key" in full; a bare "key" names a call or step.
_Avoid_: ticket id (the provider's internal id), ref

**Designated ticket**:
A ticket its team has marked for sail with a label (`sail` by default, configurable). It is the only kind an intake accepts unless forced. A poll collects it only while it is also unstarted (Backlog or Todo), because a claim moves it to In Progress (ADR-0015).
_Avoid_: tagged ticket, eligible ticket, allowlisted ticket

**Designated pull request**:
An open, non-draft pull request carrying the designation label. A workflow that opens a pull request adds the label to hand it to a workflow that watches pull requests, and a human adds it to consent to the same. The watcher polls these, and the built-in `pr` intake accepts them.
_Avoid_: tagged PR, labelled PR, bot PR

**Claim**:
Moving a designated ticket to In Progress through TicketSource at dispatch, before its run starts. After a claim the ticket is no longer eligible, so a restart cannot pick it up twice.
_Avoid_: lock, reserve, take

**Brief**:
Intake's rendering of a ticket for agents: request, acceptance criteria and context, with every human-written passage wrapped as untrusted input.
_Avoid_: summary, context document

**Untrusted input**:
Text written by people outside the run, such as ticket bodies, comments and linked pages. A schema marks such a string with `untrusted()`. It is delimited by `<untrusted-input source="…">` and `</untrusted-input>` so an agent reads it as data about what to build, never as instructions. A lookalike delimiter inside the text is escaped.
_Avoid_: user content, external text, raw ticket text

### Workflow and stages

**Workflow**:
A TypeScript function in the repository that names its intake and composes stages into a route from input to result, routing on outcomes. Branches, loops and early exits are the language's own.
_Avoid_: pipeline, DAG, graph, flow, recipe

**Stage**:
The unit of contract and ownership. It declares what it consumes, what it produces, its output schema, its permissions and its budget. It lives in one folder, private to one workflow or shared, and the workflow calls it.
_Avoid_: phase, node, task, job, command

**Private stage**:
A stage in its workflow's own folder, `.sail/workflows/<workflow>/stages/<stage>/`. Only files in that folder may import it, so another workflow may have a private stage of the same name. The folder may carry a number prefix (`10-spec/`), which only orders a listing.
_Avoid_: local stage, internal stage, workflow stage

**Shared stage**:
A stage in `.sail/stages/<stage>/`, which any workflow may import. A private stage becomes shared by moving its folder there; its keys stay the same.
_Avoid_: global stage, common stage, public stage

**Step**:
One body inside a stage, run in order with its siblings. Every stage has at least one step, and most have exactly one and are written as that step.
_Avoid_: sub-stage, action, unit

**Kind**:
What a step is. v1 ships two kinds: `agent` and `script`. Kinds belong to steps; a stage has steps, not a kind. Kinds are an extension point: a new kind implements one interface.
_Avoid_: type, mode, flavour

**Agent step**:
A step a harness runs. It has a prompt, the workspace, permissions, a budget, and a schema the agent submits its output against.
_Avoid_: LLM step, AI step, prompt step, non-deterministic stage

**Script step**:
A step that runs a command: bindings in, files and an output out, exit code as outcome. No model is involved.
_Avoid_: shell step, deterministic stage, hook, tool step

**Contract**:
Everything a stage promises and demands: its bindings, the files it produces, its output schema, its permissions and its budget. The engine checks the contract before and after every call.
_Avoid_: interface (the TypeScript keyword), signature, spec (a document)

**Call**:
One invocation of a stage by the workflow, numbered per stage. A loop that runs the implement stage twice makes `implement#1` and `implement#2`.
_Avoid_: attempt, execution, stage run, invocation

**Try**:
One execution of a call's body, in a directory of its own. A call has a later try when a resume runs it again after an interruption, and one corrective try when the engine rejects what an agent step handed in: invalid output, a missing declared file or a failed validator. A corrective try's prompt ends with the problems of the try it corrects.
_Avoid_: attempt, retry (as a noun)

**Key**:
The identity of a call or step within a run: `stage#call` or `stage#call/step`. A bare "key" always means this.
_Avoid_: id, path, name

**Loop**:
A named, bounded repetition in a workflow, such as implement, test, implement again. Its iterations carry feedback forward.
_Avoid_: cycle, retry loop, while; and "loop" for a watched workflow

**Iteration**:
One pass through a loop. It carries what the previous pass failed with.
_Avoid_: attempt, round, cycle, retry

**Binding**:
One named thing a stage consumes, declared by the stage and supplied by the workflow. It can be a file another call produced, a typed value, a diff of the workspace, or a previous step's output.
_Avoid_: input, parameter, argument, dependency

**Outcome**:
How a call or step ended, from a fixed set per kind:
- script: `passed`, `failed` or `error`, a verdict the engine maps from the exit code
- agent: `done`, `blocked` or `error`, completion the agent declares; its judgments travel in the output

The workflow routes on the outcome. An `error` fails the run with stop reason `stage_error`, unless the call passes `{ onError: 'return' }` to receive it. A multi-step stage's outcome is its last step's.
_Avoid_: status (the run's word), result, state, verdict

**Blocked**:
The agent outcome for "I cannot complete this", submitted with a reason. It honours the contract, and the workflow decides what happens next.
_Avoid_: failed, stuck, gave up, incomplete

**Error**:
The outcome when a contract was not honoured: invalid output, a missing declared file, a timeout, a script that could not start, a budget exceeded, a model or harness failure, or an unmapped exit code. It is never a verdict on the work. A result lists each problem with its reason: `invalid_output`, `missing_file`, `timeout`, `not_started`, `budget_exceeded`, `harness` or `exit_code`.
_Avoid_: crash, exception, failed

**Output**:
The typed value a call or step returns, validated against its schema: a script's JSON or an agent's submission.
_Avoid_: result, response, return value, payload

**Derived**:
Facts the engine computes about produced documents, such as counts, sections and checklist lengths, recorded beside the output. Anything derivable is never asked of the model.
_Avoid_: metrics, stats, computed output

**File**:
A named thing a stage declares it produces. The engine records it with its hash, and later calls consume files by name, never by path.
_Avoid_: artifact, deliverable, asset

**Document**:
A file made from a template, completed in place by an agent and checked by validators.
_Avoid_: artifact, markdown, report

**Template**:
The skeleton of a document. The engine renders it before an agent step starts, leaving placeholders for the agent.
_Avoid_: skeleton, scaffold, boilerplate

**Variable**:
A `{{path}}` in a template or a prompt, which the renderer fills from the values it is given. An unknown one fails the render.
_Avoid_: placeholder (the agent fills that), parameter, token

**Placeholder**:
A marked slot in a template, written `{{name: hint}}`, that the agent must replace. Any tag with a colon is one. A document with one left is invalid.
_Avoid_: variable (what the renderer fills), TODO, slot

**Validator**:
A check the engine runs on a document after the step ends, such as required sections, no placeholders left, or checklist bounds. It is also the source of derived facts.
_Avoid_: linter, assertion, gate, check

**Prompt**:
An agent step's instructions, rendered with the step's bindings. The engine appends both shared fragments, about untrusted input and submitting, to every prompt, and then the repository's conventions.
_Avoid_: system prompt, instructions file

**Fragment**:
A piece of prompt text sail appends to every agent step's prompt: one about untrusted input, one about submitting. Each is a built-in that a repository may shadow.
_Avoid_: partial, include, snippet, footer

**Conventions**:
The repository's own instruction files for agents, such as `AGENTS.md`. The engine appends each one as it is, after the fragments, to every agent step's prompt. The config lists them, and an empty list appends none. With no list, they are `AGENTS.md` and `CLAUDE.md`, where those exist.
_Avoid_: rules, guidelines, context files, memory

**Submit**:
How an agent hands in its output, exactly once, validated against the step's schema. Each harness provides it its own way.
_Avoid_: finish, return, report, done tool

**Session**:
What the harness starts for one try of an agent step: the agent works in turns until it submits, is blocked or fails, and the session ends once, with its usage. The harness names it with a session id. A try that fails before the harness is called has no session.
_Avoid_: conversation, thread, chat, run (the workflow's word)

**Transcript**:
What was said in a session, as the harness returns it. The engine keeps it as `session.log` beside the try's result.
_Avoid_: log, history, conversation

### Definitions and extension

**Definition**:
Anything the engine resolves by name before a run: a workflow, intake, stage, prompt, step kind, validator, consumer or adapter.
_Avoid_: plugin, module, component

**Extension point**:
A place where a repository or a future version adds its own definition without changing the engine: ports (through adapters), step kinds, validators and consumers, as well as workflows, intakes and stages.
_Avoid_: hook, plugin slot, customisation

**Built-in**:
A definition that ships inside sail and is used unless the repository shadows it.
_Avoid_: default (that means "used when none is named"), bundled, stock, core

**Shadowing**:
How a repository customises sail. A definition with the same name as a built-in replaces it wholesale, and a new name adds one. There is no layering.
_Avoid_: override, extend, inherit, stacking

**Origin**:
Where a definition used by a run came from: built-in, or a path in the repository. It is recorded in the roster so a run is explainable after the repository changes.
_Avoid_: source, provenance, tier, layer

**Roster**:
The intake and stages a run resolved at start: the intake its workflow names and the stages its workflow's code imports, each with its origin, permissions and budget, frozen for the run.
_Avoid_: stage list, manifest, plan, registry

**Config**:
The repository's `.sail/project.yaml`: its `name`, which adapter fills each port, model aliases, budgets, the conventions, the designation label and the default workflow. It is validated against a JSON Schema before anything runs, and sail commands run only in a clone that has it (ADR-0020).
_Avoid_: settings, project file, manifest, config.ts

### Runs

**Run**:
One execution of a workflow on one input, identified by ticket key and a unique suffix. It owns a run directory, a workspace and a status.
_Avoid_: job, execution, session, pipeline run, build

**Status**:
Where a run is in its life: `running`, `suspended`, `completed` or `failed`. It is the run's word; calls and steps have outcomes.
_Avoid_: outcome, state, phase

**Stop reason**:
The named reason a run ended without completing, such as `workflow_failed`, `stage_error`, `budget_exceeded`, `determinism_violation`, `until`, `unwatched`, `stopped` or `interrupted`. Every failed or suspended run carries exactly one.
_Avoid_: error message, cause, exit reason

**Refusal**:
A command's end before a run starts, with exit code 3: an invalid config, missing credentials, type errors, no workflow, a source the intake doesn't accept, a source that isn't designated or is already claimed, or a leased branch. A refusal leaves no run directory.
_Avoid_: rejection, abort, error (an outcome)

**Suspended**:
The status of a run that has exited with nothing running and a resume expected, for example because the run budget was exceeded, its workflow was unwatched, or it was interrupted by Ctrl-C or SIGTERM. It keeps its workspace and its branch lease.
_Avoid_: paused, waiting, blocked, pending

**Resume**:
Continuing a suspended or interrupted run from its journal. Every journaled call is replayed, and the first one that is not journaled runs.
_Avoid_: restart, rerun, retry, continue

**Workspace**:
The checkout a run works in, on its own branch. How it is made (a branch in the current clone, a git worktree, a container) is up to the workspace adapter.
_Avoid_: worktree (one mechanism), checkout, sandbox, working copy

**Branch**:
Always the git branch, such as the one a run's workspace sits on. A workflow's routing decision is a route, never a branch.
_Avoid_: using "branch" for a route or a fork in the workflow

**Run directory**:
Everything a run wrote: the run header, the journal, the events, the summary, and one directory per call holding its result and files.
_Avoid_: run folder, output directory, artifacts

**Run header**:
What was asked, written once at start and never changed: the source, the workflow and its hash, the roster, the budgets, and the versions and adapters in use.
_Avoid_: manifest, metadata, config snapshot

**Journal**:
The append-only record of completed calls and steps (key, outcome, output, files). It is the only state a resume needs.
_Avoid_: log, history, state file, checkpoint

**Replay**:
Re-executing the workflow function after every completed call, so journaled calls return instantly and the first unjournaled one runs. Start, continue and resume share this one code path.
_Avoid_: rerun, recovery, fast-forward

**Determinism guard**:
The check that fails a run when the workflow asks for a key sequence that diverges from the journal. That is the sign of non-deterministic workflow code or a mid-run change.
_Avoid_: replay check, drift detection

**Result**:
What a call or step left behind, as the engine recorded it: outcome, output, derived facts, files and usage. "The run's result" is what the workflow returned, for example the pull request.
_Avoid_: output (the typed value alone), record, report

### Observability

**Event**:
One line in a run's event stream, numbered by `seq` without a gap: a call starting, a script exiting, a file produced, a loop's iteration, a route, an error. Call-level events carry the key they belong to.
_Avoid_: log line, trace, telemetry, message

**Event stream**:
The ordered events of one run, written to `events.ndjson` and handed to every consumer at the same time. Nothing observable happens outside it.
_Avoid_: log, feed, bus (the bus is the mechanism)

**Consumer**:
Something that receives the event stream and does one thing with it: write the events file, render the terminal view, keep the summary. A consumer that throws is reported as an `error:consumer` event and keeps receiving events. The dashboard reads the files consumers write; it isn't one.
_Avoid_: listener, sink, subscriber, reporter

**Terminal view**:
What the terminal consumer prints for a run: one line per event, its key first, at a verbosity, ending with the final block. It is the same text in a terminal, a pipe and a CI log; only a terminal adds colour and the live line.
_Avoid_: console output, logs, UI

**Verbosity**:
How much of the event stream the terminal view prints, chosen with `-q`, `-v` or `-vv`:
- quiet: the run's start, its errors and the final block
- normal: adds calls, script exits, validation results and loops
- verbose: adds contract details, routes and every script's output tail
- trace: every event

_Avoid_: log level, detail level

**Plain mode**:
The terminal view with no escape codes and no cursor movement. It is used when stdout isn't a terminal, `NO_COLOR` is set, or `TERM` is `dumb`.
_Avoid_: CI mode, no-TTY mode

**Live line**:
The one line an interactive terminal redraws below the terminal view, naming the running call and how long it has run. It is cleared before each printed line and never left behind.
_Avoid_: spinner, progress bar, status line (STATUS is the run's file)

**Final block**:
The terminal view's closing lines for each `run:end`: status and duration, stop reason, calls, loops, replays and the run directory.
_Avoid_: result box, summary (the Summary is `summary.json`)

**Route**:
The move a workflow made after a call: the outcome it received and what it did next, another call, its end or `run.fail()`. sail infers it from the calls the workflow asks for, since routing is the workflow's own code.
_Avoid_: branch, transition, edge

**Summary**:
The rolled-up view of a run derived from its events: calls, loops, totals, and cost against budget. It is rewritten after every call for people and dashboards and never read for resume.
_Avoid_: report, status file, digest

**Usage**:
The tokens and cost an agent step consumed, reported per turn by the harness. A harness that cannot report usage does not qualify.
_Avoid_: consumption, spend, billing, metering

### Guardrails

**Guardrail**:
Any limit the engine enforces on a run: permissions, budgets, untrusted-input wrapping, the designation label. Guardrails are enforced by code, never requested in a prompt.
_Avoid_: policy, safety prompt, rule

**Permissions**:
What a step may do, declared per step: paths it may read and write, commands it may run, tools and servers it may reach. Enforced for agents; declared and recorded for scripts.
_Avoid_: policy, allowlist, sandbox, scope

**Denial**:
A tool call refused for falling outside the step's permissions, recorded with the permissions that refused it. The agent carries on.
_Avoid_: block, violation, rejection

**Budget**:
The most a step may spend (turns, dollars, minutes) and the most a run may spend overall. A step over budget ends in `error`; a run over budget is suspended.
_Avoid_: limit, quota, cap, allowance

### Ports

**Port**:
The engine's contract with one kind of external system, stated in sail's language whatever the provider. Adapters fill it. Every port ships with a fake adapter for tests.
_Avoid_: interface (the TypeScript keyword), SPI, abstraction

**TicketSource**:
The port to the ticket system: fetch a ticket with its comments, links and attachments; update it; comment on it. It reports a ticket's state by type (unstarted, started, completed or canceled) and moves it to unstarted, in progress, in review or done (ADR-0015). v1 adapter: Linear.
_Avoid_: tracker, task manager, board, issue source

**CodeHost**:
The port to the repository host: push a branch; open a pull request and link it to the ticket; poll designated pull requests; read their checks; label, comment on and merge them. A merge counts only once the host reports it, never when it was merely requested. v1 adapter: GitHub.
_Avoid_: git provider, repo host, SCM, VCS

**Checks**:
The status checks the code host reports for a pull request's head sha: the repository's CI. A workflow reads them through CodeHost. They are distinct from any tests a workflow runs itself.
_Avoid_: CI (ambiguous), tests, status

**Harness**:
The port that runs an agent step: a session with tools, permissions enforced on every tool call, a way to submit output, and mandatory usage reporting. v1 adapter: Claude Code.
_Avoid_: agent provider, runner, executor, model

**Workspace port**:
The port that gives a run its workspace and takes it away again. v1 adapter: `git-worktree`, one worktree per run, so runs execute in parallel.
_Avoid_: worktree manager, checkout service

**Adapter**:
One implementation of a port for one provider, selected in the config: by name for a built-in, by module path for the repository's own.
_Avoid_: plugin, driver, connector, integration, backend

**Adapter registry**:
Resolves the adapter that fills each port from the config, a built-in by name or the repository's own by module path.
_Avoid_: plugin loader, factory, registry (alone)

**Adapter definition**:
What makes an adapter: the environment variables it requires, the versions it runs with, and how it is created from its options.
_Avoid_: factory, plugin, provider

**Preflight**:
The checks before a run starts that need no run directory: the config, the adapters and their credentials. A failed one is a refusal.
_Avoid_: startup check, validation, health check

**Port suite**:
The tests every adapter of a port must pass, shared by the fake and the real one. A real adapter runs them against its provider on demand.
_Avoid_: contract suite, contract tests (a stage has the contract)

**Capabilities**:
What an adapter declares it can do, such as the ticket moves it supports or the merge methods it offers. The engine refuses a workflow that needs one its adapter lacks.
_Avoid_: features, support flags

**Provider**:
The external system behind an adapter: Linear, GitHub, Anthropic, Jira.
_Avoid_: vendor, platform, service

### Watching

**Watched workflow**:
A workflow that declares `watch: { every, label? }` and `maxConcurrentRuns`, which makes it watchable. Once named to a watcher, the watcher polls for its sources, queues them and dispatches its runs. Several can run at once, each with its own queue and cap (ADR-0017, ADR-0019).
_Avoid_: loop, line, daemon, pipeline

**Watcher**:
The resident process that automates one repository's watch set: it polls and it dispatches. `sail watch <workflow…>` starts it in the clone where it is run, or adds to the live one. There is one per repository. It fetches before every dispatch, and runs start from `origin/<default>` in detached worktrees, using the `.sail/` committed there. It is sail's home in v1. Without one running, nothing starts on its own.
_Avoid_: daemon, monitor, poller, scheduler

**Watch set**:
The watched workflows a watcher is watching now: exactly those named with `sail watch`, minus those removed with `sail unwatch`. It is never remembered across restarts, and the watcher exits when it becomes empty. Unwatching a workflow suspends its runs; stopping the watcher does not (ADR-0019).
_Avoid_: enabled workflows, active loops, subscriptions

**Watcher registry**:
The machine-level record of watchers in `~/.sail/watchers/`: the repository's `name`, remote, clone path, pid and the labels each polls. A watcher refuses to start if a live one has the same `name` or holds one of its labels on the same TicketSource. The dashboard reads it to find every repository, including those whose watcher has stopped.
_Avoid_: registry (alone; the config also has an adapter registry), roster, manifest

**Branch lease**:
A run's exclusive hold on its git branch, from workspace creation to release, kept while the run is suspended. Leases are machine-wide in `~/.sail/leases/`, keyed by remote and branch, and are stale only once the run is neither running nor suspended. A lease whose run has no status yet is stale once its pid is dead, and the same run leasing again renews it (a resume). Dispatch skips a source whose branch is leased, and manual runs take leases too. Because worktrees are detached, leases are the only thing keeping runs apart (ADR-0018).
_Avoid_: lock, branch lock, reservation

**Adoption**:
A restarted watcher taking charge again of a run that is still alive, counting it against its cap. A run whose process died is resumed from its journal instead, once.
_Avoid_: reattach, recovery, takeover

**Poll**:
One timed sweep for eligible designated tickets and designated pull requests, appending each as a source to its workflow's queue.
_Avoid_: sweep, scan, sync

**Queue**:
The sources waiting for a run, kept per workflow and deduplicated. A queued item is always a source, never a resolved input.
_Avoid_: backlog, inbox, buffer

**Dispatch**:
The watcher taking the next queued source and starting an ordinary run, only while the workflow is under its maximum of concurrent runs and after re-checking the source is still eligible. For a ticket, dispatch begins with the claim.
_Avoid_: pickup, schedule, spawn

**Dashboard**:
The live, read-only view `sail dashboard` serves on localhost for the whole machine: every watcher in the registry, with its runs, stage cards from the roster, the inspector, what needs attention, and its queues. It reads the run directories and queue files in each registered clone. It controls nothing; the CLI does (`sail watch`, `sail unwatch`, `sail queue …`, `sail stop`).
_Avoid_: UI, console, monitor, board
