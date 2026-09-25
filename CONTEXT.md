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
Text written by people outside the run, such as ticket bodies, comments and linked pages. It is delimited so an agent reads it as data about what to build, never as instructions.
_Avoid_: user content, external text, raw ticket text

### Workflow and stages

**Workflow**:
A TypeScript function in the repository that names its intake and composes stages into a route from input to result, routing on outcomes. Branches, loops and early exits are the language's own.
_Avoid_: pipeline, DAG, graph, flow, recipe

**Stage**:
The unit of contract and ownership. It declares what it consumes, what it produces, its output schema, its permissions and its budget. It lives in one folder and the workflow calls it.
_Avoid_: phase, node, task, job, command

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
One execution of a call's body. A call has a second try only when the engine retries it after invalid output or a failed validator.
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

The workflow routes on the outcome. A multi-step stage's outcome is its last step's.
_Avoid_: status (the run's word), result, state, verdict

**Blocked**:
The agent outcome for "I cannot complete this", submitted with a reason. It honours the contract, and the workflow decides what happens next.
_Avoid_: failed, stuck, gave up, incomplete

**Error**:
The outcome when a contract was not honoured: invalid output, a missing declared file, a timeout, a budget exceeded, a model or harness failure, or an unmapped exit code. It is never a verdict on the work.
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

**Placeholder**:
A marked slot in a template that the agent must replace. A document with one left is invalid.
_Avoid_: variable (what the renderer fills), TODO, slot

**Validator**:
A check the engine runs on a document after the step ends, such as required sections, no placeholders left, or checklist bounds. It is also the source of derived facts.
_Avoid_: linter, assertion, gate, check

**Prompt**:
An agent step's instructions, rendered with the step's bindings. The engine appends the shared fragments about untrusted input and submitting.
_Avoid_: system prompt, instructions file

**Submit**:
How an agent hands in its output, exactly once, validated against the step's schema. Each harness provides it its own way.
_Avoid_: finish, return, report, done tool

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
The intake and stages a run resolved at start, each with its origin, permissions and budget, frozen for the run.
_Avoid_: stage list, manifest, plan, registry

**Config**:
The repository's `.sail/project.yaml`: its `name`, which adapter fills each port, model aliases, budgets, the designation label and the default workflow. It is validated against a JSON Schema before anything runs, and sail commands run only in a clone that has it (ADR-0020).
_Avoid_: settings, project file, manifest, config.ts

### Runs

**Run**:
One execution of a workflow on one input, identified by ticket key and a unique suffix. It owns a run directory, a workspace and a status.
_Avoid_: job, execution, session, pipeline run, build

**Status**:
Where a run is in its life: `running`, `suspended`, `completed` or `failed`. It is the run's word; calls and steps have outcomes.
_Avoid_: outcome, state, phase

**Stop reason**:
The named reason a run ended without completing, such as `workflow_failed`, `stage_error`, `budget_exceeded`, `determinism_violation`, `until`, `unwatched` or `stopped`. Every failed or suspended run carries exactly one.
_Avoid_: error message, cause, exit reason

**Suspended**:
The status of a run that has exited with nothing running and a resume expected, for example because the run budget was exceeded or its workflow was unwatched. It keeps its workspace and its branch lease.
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
One line in a run's event stream: a stage starting, an agent message, a tool call, a denial, a usage update, a file produced, an error. Each carries the key it belongs to.
_Avoid_: log line, trace, telemetry, message

**Event stream**:
The ordered events of one run, written to `events.ndjson` and handed to every consumer at the same time. Nothing observable happens outside it.
_Avoid_: log, feed, bus (the bus is the mechanism)

**Consumer**:
Something that receives the event stream and does one thing with it: write the events file, render the terminal view, keep the summary, and feed the dashboard. Consumers are an extension point.
_Avoid_: listener, sink, subscriber, reporter

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
The port to the ticket system: fetch a ticket with its comments, links and attachments; update it; comment on it. v1 adapter: Linear.
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
One implementation of a port for one provider, selected by name in the config.
_Avoid_: plugin, driver, connector, integration, backend

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
A run's exclusive hold on its git branch, from workspace creation to release, kept while the run is suspended. Leases are machine-wide in `~/.sail/leases/`, keyed by remote and branch, and are stale only once the run is neither running nor suspended. Dispatch skips a source whose branch is leased, and manual runs take leases too. Because worktrees are detached, leases are the only thing keeping runs apart (ADR-0018).
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
