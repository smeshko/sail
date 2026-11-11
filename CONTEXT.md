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
What a run was started from: a ticket key such as `ADW-23`, or a pull request, which the run header records as its number and head sha. It comes from the CLI or from the watcher's queue, and intake resolves it into the input. The run header records it, with the checks `--force` overrode.
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

**Priority**:
A ticket's urgency as its ticket system ranks it: urgent, high, medium, low or none. TicketSource reports it, and a ticket without one has none.
_Avoid_: importance, severity

**Designated ticket**:
A ticket its team has marked for sail with a label (`sail` by default, configurable). It is the only kind an intake accepts unless forced. A poll collects it only while it is also in a pick-up state, because a claim moves it to In Progress (ADR-0015).
_Avoid_: tagged ticket, eligible ticket, allowlisted ticket

**Pick-up state**:
A state a designated ticket is picked up from: by default every state the ticket source reads as unstarted (Triage, Backlog or Todo), or the ones its `pickUp` option names. The ticket source decides it with `canPickUp`; a poll, a dispatch, a claim and a start all apply that one rule, and `--force` overrides it.
_Avoid_: ready state, eligible state

**Prerequisite**:
A ticket the ticket system says blocks another, reported by TicketSource's `get` with the state it is in now. It is *open* while that state is not completed or canceled, and also when the source can't read it. A ticket with an open prerequisite waits: it is not dispatched and its start is refused, unless the workflow declares `ignorePrerequisites`, as one that only judges its ticket does.
_Avoid_: blocker, dependency, blocked (an outcome)

**Designated pull request**:
An open, non-draft pull request carrying the designation label, in any case, whose head branch is in the repository. A workflow that opens a pull request adds the label to hand it to a workflow that watches pull requests, and a human adds it to consent to the same. The watcher polls these, and the built-in `pr` intake accepts them.
_Avoid_: tagged PR, labelled PR, bot PR

**Ticket marker**:
The hidden `<!-- sail:ticket KEY -->` line in a pull request's body. It names the ticket only when the head branch is that ticket's branch; a mismatch is refused, and `--force` does not override it.
_Avoid_: ticket tag, PR link

**Claim**:
Moving a designated ticket to In Progress through TicketSource, and commenting on it with the run id. The intake makes it, not the start: the built-in `ticket` intake claims inside `intake#1` and records the claim in that call's `result.json`, and a repository intake claims only when a step runs `sail port ticket-source claim`. A later try of the built-in `ticket` intake's `intake#1` whose earlier try's claim took, as its `ticket:claimed` in the run's stream shows, completes that claim and posts the comment, rather than losing the ticket to itself. Opening a run moves nothing, so a workflow that only reads its ticket, such as a grooming one, leaves it where it is. After a claim the ticket is no longer in a pick-up state, so a restart cannot pick it up twice. A claim another start took first fails the run. A forced run of a ticket that is not in a pick-up state makes no claim: it moves the ticket to In Progress through `update`.
_Avoid_: lock, reserve, take

**Forced run**:
A run started with `--force` on a ticket that is not designated, not in a pick-up state, whose workflow's live and held runs fill its `maxConcurrentRuns`, or any of these. Its run header lists the checks `--force` overrode: `designation`, `state` and `cap`.
_Avoid_: bypass, skip, unsafe run

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
One body inside a stage, run in order with its siblings. Every stage has at least one step, and most have exactly one and are written as that step. The steps of a stage share its `$STAGE_OUT`, the `out/` of the call's directory, and each step of a multi-step stage is journaled under `stage#call/step` as it finishes, so a resume runs only the steps after it.
_Avoid_: sub-stage, action, unit

**Kind**:
What a step is. v1 ships two kinds: `agent` and `script`. Kinds belong to steps; a stage has steps, not a kind. Kinds are an extension point: a new kind implements one interface. A built-in intake's call records the kind `builtin`, though no step runs: the engine runs its body in process.
_Avoid_: type, mode, flavour

**Agent step**:
A step a harness runs. It has a prompt, the workspace, permissions, a budget, an optional `effort`, and a schema the agent submits its output against.
_Avoid_: LLM step, AI step, prompt step, non-deterministic stage

**Effort**:
How hard an agent step's model reasons: `low`, `medium`, `high`, `xhigh` or `max`, declared as the step's `effort`. The roster records it, and the harness runs the session at it; left out, the harness's default.
_Avoid_: thinking level, reasoning budget

**Script step**:
A step that runs a command: bindings in, files and an output out, exit code as outcome. No model is involved. Its script environment includes the variables its `env` names and the credentials of the ports its `ports` names.
_Avoid_: shell step, deterministic stage, hook, tool step

**Contract**:
Everything a stage promises and demands: its bindings, the files it produces, its output schema, its permissions and its budget. The engine checks the contract before and after every call.
_Avoid_: interface (the TypeScript keyword), signature, spec (a document)

**Call**:
One invocation of a stage by the workflow, numbered per stage. A loop that runs the implement stage twice makes `implement#1` and `implement#2`.
_Avoid_: attempt, execution, stage run, invocation

**Group**:
The calls one `run.all()` makes at once. Their keys are assigned in the order given, before any starts, and each call is journaled as it completes, with the group's keys, so a resume runs only the ones not yet journaled.
_Avoid_: batch, fan-out, parallel block

**Try**:
One execution of a call's body, in a directory of its own, whose `out/` is its `$STAGE_OUT` and holds only what the body produced: the engine's records of the try (its `result.json`, logs, prompt and session transcript) and a later try's `try-M/` sit beside `out/`, out of a session's reach. A call has a later try when a resume runs it again after an interruption, and one corrective try when the engine rejects what an agent step handed in: invalid output, a missing declared file or a failed validator. A corrective try's prompt ends with the problems of the try it corrects. A try belongs to a call's body, or to one step of a multi-step call: a step's later try sits in that step's own directory, and the call keeps one `out/`.
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

The workflow routes on the outcome. An `error` fails the run with stop reason `stage_error`, unless the call passes `{ onError: 'return' }` to receive it. A multi-step stage's outcome is its last step's, or the outcome of the step that stopped it: a step that ends `blocked`, `failed` or `error` ends its stage, and the steps after it don't run. A multi-step stage whose end finds a file one of its steps produced gone, or no longer a regular file, ends `error` whatever its steps' outcomes.
_Avoid_: status (the run's word), result, state, verdict

**Blocked**:
The agent outcome for "I cannot complete this", submitted with a reason. It honours the contract, and the workflow decides what happens next.
_Avoid_: failed, stuck, gave up, incomplete

**Error**:
The outcome when a contract was not honoured: invalid output, a missing declared file (one a later step of its stage removed included), a timeout, a script that could not start, a budget exceeded, a model or harness failure, a port call that failed, or an unmapped exit code. It is never a verdict on the work. A result lists each problem with its reason: `invalid_output`, `missing_file`, `timeout`, `not_started`, `budget_exceeded`, `harness`, `usage_limit`, `port` or `exit_code`. The `port` reason covers a port call that failed and a port events file that holds something that is no provider event. An `exit_code` error carries the code `signalled` when a signal sail didn't send (SIGTERM, SIGKILL, SIGHUP or SIGINT) ended the script, and such a step suspends the run as `interrupted`, unless its call passed `{ onError: 'return' }`, whose workflow takes the error. A `port` error carries the code `unavailable` when the provider could not be reached: a step that doesn't pass on it is an error, whatever its exit code, and suspends the run, unless its call passed `{ onError: 'return' }`, whose workflow takes the error. A dispatched run so suspended (`port_unavailable`) has its item held and the run resumed by its watcher on a growing back-off of 1, 2, 5, 10 and 30 minutes, and parked with the last port error once it is suspended past that schedule; a resume that gets past the call resets the count.
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
A marked slot in a template, written `{{name: hint}}`, that the agent must replace. Any tag with a colon is one in a template. A document with one of its template's placeholders left is invalid; text the template never held is not a placeholder. One inside untrusted input, fenced code or inline code is not counted as left.
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
The repository's own instruction files for agents, such as `AGENTS.md`. The engine appends each one as it is, after the fragments, to every agent step's prompt. The config lists them, and an empty list appends none. With no list, they are `AGENTS.md` and `CLAUDE.md`, where those exist. An agent step may name its own list, which replaces the config's for that step.
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

**Recording**:
One agent session's tries as `--record` wrote them, one file per call key: the harness's events, its result, the files it produced in `$STAGE_OUT`, and the provider's own messages, with secrets and machine paths masked. The fake harness plays a recording back in place of a session.
_Avoid_: cassette, snapshot, fixture (alone), replay (the journal's word)

**Playback**:
The fake harness answering a session from its recording: the recorded events in order, the recorded files written into `$STAGE_OUT`, and the recorded result, offline and at $0. A prompt that differs from the recorded one fails the session, or only warns where the config says so.
_Avoid_: replay, rerun, mock run

### Definitions and extension

**Definition**:
Anything the engine resolves by name before a run: a workflow, intake, stage, prompt, step kind, validator, consumer or adapter.
_Avoid_: plugin, module, component

**Extension point**:
A place where a repository or a future version adds its own definition without changing the engine: ports (through adapters), step kinds, validators and consumers, as well as workflows, intakes and stages.
_Avoid_: hook, plugin slot, customisation

**Built-in**:
A definition that ships inside sail and is used unless the repository shadows it. A built-in intake's call is recorded under the kind `builtin`.
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
The repository's `.sail/project.yaml`: its `name`, which adapter fills each port, its named harnesses, model aliases, budgets, the conventions, the designation label and the default workflow. It is validated against a JSON Schema before anything runs, and every sail command but `sail init` runs only in a clone that has it (ADR-0020).
_Avoid_: settings, project file, manifest, config.ts

**Model alias**:
A name in the config's `models` that an agent step picks with its `model` (`default` when it names none). It is a model id on the default harness, or `{ harness, model }`: a model id on the named harness it names. A `models` entry that names a harness `adapters.harnesses` doesn't define is refused wherever the config is read. `sail check`, and `sail watch` before it starts and whenever `project.yaml` changes, ask each alias's harness whether it can run the alias's model, and refuse, or pause the dispatch, on one it can't.
_Avoid_: model name, model preset, model profile

**Named harness**:
A harness the config declares under `adapters.harnesses`, beside the default `adapters.harness`, for a model alias to name. A run resolves and preflights it only when it reaches an alias that names it, and the run header records the ones it reached; its models are checked before any run, as the model alias says. A call on one records its name; a call on the default harness records none.
_Avoid_: extra harness, secondary harness, provider (the external system behind an adapter)

**Editor declarations**:
The two generated files in `.sail/`, `sail.d.ts` and `sail-intakes.d.ts`, through which an editor resolves `sail` and `sail/intakes` to this machine's sail. `sail init` writes them, `sail check` rewrites them when they are missing or stale, and git ignores them. `sail check` itself type-checks against sail's own declarations and never reads a repository's `tsconfig.json`.
_Avoid_: stubs, typings, shims

### Runs

**Run**:
One execution of a workflow on one input, identified by ticket key and a unique suffix. It owns a run directory, a workspace and a status.
_Avoid_: job, execution, session, pipeline run, build

**Status**:
Where a run is in its life: `running`, `suspended`, `completed` or `failed`. It is the run's word; calls and steps have outcomes.
_Avoid_: outcome, state, phase

**Stop reason**:
The named reason a run ended without completing, such as `workflow_failed`, `stage_error`, `budget_exceeded`, `determinism_violation`, `until`, `stopped`, `interrupted`, `usage_limit`, `port_unavailable` or `crashed`. Every failed or suspended run carries exactly one. `unwatched` is no longer given: the schemas keep it so a run an older sail suspended when its workflow was unwatched still reads, and a person resumes or stops such a run, as the watcher no longer does.
_Avoid_: error message, cause, exit reason

**Refusal**:
A command's end before a run starts, with exit code 3: an invalid config, missing credentials, type errors, no workflow, a source the intake doesn't accept, a source that isn't designated or is already claimed, a leased branch, or a workspace that can't be made. A refusal leaves no run directory. A ticket that waits on an open prerequisite is refused with exit code 5 instead, a distinct code so a script can tell waiting from a refusal; `--ignore-prerequisites` starts it, and `--force` doesn't.
_Avoid_: rejection, abort, error (an outcome)

**Dry run**:
`sail <ticket> --dry-run`: the start's whole preflight (the config, credentials, the type check, the ticket and its designation, the branch lease) and the roster the run would freeze, printed. It writes nothing: no run directory, workspace, lease or comment, and no claim. It exits 0, or 3 (5 for a ticket that waits on an open prerequisite) with the start's own refusal.
_Avoid_: preview, simulation, plan

**Keep-awake**:
The hold a run's process takes against the machine's sleep, from its start or resume until it ends. It is released at the end, or by the OS when the process dies: `caffeinate` on macOS, none elsewhere or with `SAIL_KEEP_AWAKE=off`, and recorded as `run:keep_awake`. It doesn't stop a laptop on battery sleeping when its lid is closed.
_Avoid_: wake lock, caffeinate, sleep assertion

**Suspended**:
The status of a run that has exited with nothing running and a resume expected, for example because the run budget was exceeded, it hit the provider's usage limit, a step of it ended on a provider that was unavailable, a script step of it was ended by a signal sail didn't send (SIGTERM, SIGKILL, SIGHUP or SIGINT), it crashed on an exception inside sail, it was interrupted by Ctrl-C or SIGTERM, or a person suspended it with `sail stop --suspend` or the dashboard's Suspend and hold. It keeps its workspace and its branch lease, and takes no slot of its workflow's cap unless it is a held run.
_Avoid_: paused, waiting, blocked, pending

**Control file**:
A run's `CONTROL` file in its run directory, a request to stop at its next call boundary: `stopped`, which `sail stop` writes and which fails it. `sail stop --now` writes `stopped now`, ending the running call through its abort signal rather than waiting for the boundary. `sail stop --suspend`, or the dashboard's Suspend and hold, writes `suspended`, which ends the running call the same way and suspends the run `interrupted`, keeping its workspace and lease, along with the run's hold. The run takes the request before its intake and before each call. A dispatched run with no run directory yet gets its request as a hand-off file, which it moves in as `CONTROL` once its run directory exists.
_Avoid_: signal file, kill file, flag

**Hand-off file**:
`.sail-runs/<run id>.control`, a control file's request for a dispatched run that has no run directory yet. The run moves it in as `CONTROL` once its run directory exists, and the watcher deletes one the run never took when it settles the item.
_Avoid_: pending control, mailbox

**Held run**:
A run a person marked with `sail stop --suspend`, or the dashboard's Suspend and hold: a `HOLD` file in its run directory. The watcher never resumes it, whatever made it resumable (`interrupted`, `crashed`, a dead process, `usage_limit`, `port_unavailable`), though it still adopts one a live process holds. A live run is suspended `interrupted` as well, and a run nothing runs keeps its status. `sail resume`, and the dashboard's Resume, remove the hold once they take the run. A held run fills a slot of its workflow's `maxConcurrentRuns`, whoever started it, until it is resumed, stopped or cleaned, so the watcher dispatches nothing in its place and a start by hand is refused unless forced; `sail queue ls` names it.
_Avoid_: paused run, frozen run

**Resume**:
Continuing a suspended or interrupted run from its journal. Every journaled call is replayed, and the first one that is not journaled runs. A resume runs the run's own copy of `.sail/` in its `definition/`, never the checkout's, so a workflow edited since the run started changes nothing for it.
_Avoid_: restart, rerun, retry, continue

**Raise**:
What is added to a suspended run's budget, in dollars or minutes, given to `sail resume` and recorded as a `budget:raised` event. `run.json` keeps the budget the run started with.
_Avoid_: top-up, extension, bump

**Seeded run**:
A new run whose journal starts with another run's calls, those before a named stage, so they aren't paid for again. `sail run --from-run <run> --stage <stage>` starts one. It runs that stage and stops, suspended with `until`, unless `--continue`. Its run header records the run it came from as `fromRun` and how many journal lines it reused as `reused`, and a resume restores the reports of reused calls its events lost. It claims nothing, and works on a branch of its own. Its workspace starts from the commits the source made, its workspace's `HEAD` while that exists, else its run ref, recorded as `repository.startSha`; with `--from-base`, or when the source made none, it starts at the source's base. Its copy of `.sail/` is the clone's as it reads at its start.
_Avoid_: rerun, fork, clone, replay

**Reused call**:
A call a seeded run took from its `fromRun` run: its call directory copied, its journal line seeded, and `fromRun` on its `journal:append` event and its summary entry. It costs the seeded run nothing.
_Avoid_: cached call, skipped call

**Workspace**:
The checkout a run works in, on its own branch. How it is made (a branch in the current clone, a git worktree, a container) is up to the workspace adapter.
_Avoid_: worktree (one mechanism), checkout, sandbox, working copy

**Workspace setup**:
The shell command the `git-worktree` adapter runs in each workspace it makes, before any stage runs: its `setup` option, such as `bun install --frozen-lockfile`. Every run gets it, a seeded run included, whose new workspace holds the commits it carried but none of what the setup installed. A setup that fails refuses the run.
_Avoid_: bootstrap, install step, setup stage

**Base**:
The commit a run's workspace starts from: the default branch's tip on the remote after a fetch, or, when the run's branch is already on the remote, that branch's tip, recorded as `baseSha`. For a pull-request source it is the pull request's head. A seeded run keeps its source's base, so the commits it carries count as its own work.
_Avoid_: start point, fork point

**Run ref**:
`refs/sail/runs/<runId>` in the repository: where a run's commits are kept when its workspace is removed with its `HEAD` past its base, whether or not its branch was pushed, recorded as `ref` on `workspace:released`. A failed run that never pushed its branch has its work nowhere else, and a seeded run carries from the ref, which pins the commit the run ended on though the remote branch is deleted or moved. `git branch` doesn't list it and gc keeps what it reaches; `git branch <name> refs/sail/runs/<runId>` recovers the work.
_Avoid_: backup branch, rescue ref

**Clean**:
Removing what a failed run left behind (its worktree, its local and remote branch, its run ref) and moving its run directory to `failed-runs/<YYYY-MM-DD>/<run id>/` in sail's machine directory. `sail clean` does it. A run still used (leased by another run, named by a queue item, or whose branch has an open pull request) is refused. `sail clean` also moves the run's ticket back from started to unstarted, and settles a queue item that names the run when told to: `--requeue` or `--drop` reach the repository's live watcher as a command file, as `sail queue` does. `--failed --all-repos` cleans the failed runs of every registered repository, from any directory. The dashboard's Clean does the same: it resets the ticket and requeues or drops the queue item that names the run, as the person asks, so it too is refused for such a run while no live watcher of this clone watches the item's workflow.
_Avoid_: delete, purge, prune

**Branch**:
Always the git branch, such as the one a run's workspace sits on. A workflow's routing decision is a route, never a branch.
_Avoid_: using "branch" for a route or a fork in the workflow

**Run directory**:
Everything a run wrote: the run header, the journal, the events, the summary, `definition/`, a copy of the whole `.sail/` and its conventions as the run started (a dispatched run's from the default branch's commit, any other's from the checkout), which its calls and every resume read from, and one directory per call holding the engine's records of it (result, logs, prompt, transcript, later tries) beside an `out/` with the files it produced.
_Avoid_: run folder, output directory, artifacts

**Run header**:
What was asked, written once at start and never changed: the source, the workflow and its hash, the roster, the budgets, and the versions and adapters in use. A run started from committed definitions also records `definitionsSha`, the commit its `.sail/` was read from.
_Avoid_: manifest, metadata, config snapshot

**Journal**:
The append-only record of completed calls and steps (key, outcome, output, files, and on a call its binding fingerprints). A step's line also records its usage, times and, when it ended `error`, its errors, so a resume rebuilds the step from its line alone. A resume replays completed calls from it. To recover an unjournaled claim before its comment was posted, a later try of the built-in `ticket` intake also reads `ticket:claimed` from the run's event stream; without that event, a missing comment cannot establish ownership.
_Avoid_: log, history, state file, checkpoint

**Replay**:
Re-executing the workflow function after every completed call, so journaled calls return instantly and the first unjournaled one runs. Start, continue and resume share this one code path.
_Avoid_: rerun, recovery, fast-forward

**Determinism guard**:
The check that fails a run when the workflow asks for a key sequence that diverges from the journal, and, for a group, its whole key sequence. It also compares each journaled call's binding fingerprints with the bindings the workflow asks with now, naming each that changed, appeared or went; a journal line without them keeps the key check alone. That is the sign of non-deterministic workflow code or a mid-run change.
_Avoid_: replay check, drift detection

**Binding fingerprint**:
A short hash of one value or file binding a workflow supplied to a call, journaled on the call's line by binding name. A value is hashed by its canonical JSON, a file by the run-relative path it names. A `gitDiff` or `fromStep` binding has none, since the engine supplies it.
_Avoid_: bindings hash, checksum

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

**Provider event**:
An event an adapter emits about a call to its provider, in the families `ticket:*`, `codehost:*`, `jev:*` and `workspace:*`.
_Avoid_: adapter event, port event (the file's name is the one exception), side effect

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
The terminal view's closing lines for each `run:end`: status and duration, stop reason, calls (the reused ones of a seeded run counted apart), loops, replays and the run directory.
_Avoid_: result box, summary (the Summary is `summary.json`)

**Route**:
The move a workflow made after a call: the outcome it received and what it did next, another call, its end or `run.fail()`. sail infers it from the calls the workflow asks for, since routing is the workflow's own code.
_Avoid_: branch, transition, edge

**Summary**:
The rolled-up view of a run derived from its events: calls, loops, totals, and cost against budget. It is rewritten after every call for people and dashboards and never read for resume.
_Avoid_: report, status file, digest

**Usage**:
The tokens and cost an agent step consumed, reported per turn by the harness. A harness that prices turns itself reports that estimate as the running cost, until the provider's own total replaces it. A harness that cannot report usage does not qualify. A Jev call reports its tokens too, on its `jev:asked`, when its adapter has them.
_Avoid_: consumption, spend, billing, metering

### Guardrails

**Gate file**:
A file `bun run verify` reads: the toolchain configs, the test launcher and preload, the coverage census, the lint config and `.github/`. So is the config, `.sail/project.yaml`, whose adapters and workspace setup load code into a run, and the setup's script, `scripts/workspace-docs.ts`. So is each code file of the review workflow's own guard and merge path, and each module or script they reach: every file in the review's folder, the shared `validate` and `file-follow-ups` stages but a `.md` prompt or template, every file of its merge, hand-over and gate-files stages, and the `.sail/lib/` files they load, `gate-files.mjs` among them. A pull request could change one to loosen its own `verify` check, or to merge without the guard; sail's review workflow hands a pull request that changes one to a human rather than merging it.
_Avoid_: protected file, CI file

**Redaction**:
Masking credential-named values of at least eight characters from the run's environment and those sail filled from a credential source, their parts and URL userinfo, raw, URL-encoded and in base64, as `[redacted]` in the run header, events, summary, journal, results, completed script logs, port events and transcripts, and the terminal view. Produced files, prompts and bindings are not masked, nor are live script logs before the process ends.
_Avoid_: scrubbing, censoring, sanitising

**Script environment**:
The environment a script step runs with: the allowlist's names that are no credential, `SSH_AUTH_SOCK`, sail's own `SAIL_*` settings, git's identity and the preamble, plus the variables its `env` names and those the adapters of the ports its `ports` names require. Its `script:exec` lists the names it was given, never their values. A step in the clone keeps git's repository variables too.
_Avoid_: inherited environment, env passthrough

**Guardrail**:
Any limit the engine enforces on a run: permissions, budgets, untrusted-input wrapping, the designation label. Guardrails are enforced by code, never requested in a prompt.
_Avoid_: policy, safety prompt, rule

**Permissions**:
What a step may do, declared per step: paths it may read and write, commands it may run and those it never may though its commands match them (`deny`), tools and servers it may reach. Enforced for agents; declared and recorded for scripts. Tools and MCP servers are listed by name (`WebFetch`, `server:tool`, or `server:*` for every tool of a server), and anything not listed is denied. Reads and writes are confined to the run's workspace and the step's `$STAGE_OUT`. A path glob starting with `!` excludes the paths it matches, after the globs without one, in `read` and `write` alike, as in `['**', '!secret/**']`.
_Avoid_: policy, allowlist, sandbox, scope

**Deny set**:
The commands no step's permissions can allow: `rm -rf`, a forced push, `git reset --hard`, `git clean -f`, `git branch -D`, `git checkout`, `git switch`, `sudo`, `curl` piped into a shell, git options that name a program for git to run, and git configuration overrides. Checked before the step's own commands.
_Avoid_: blocklist, denylist, banned commands, safe commands

**Tool call**:
One action an agent asks its harness for (read, write, edit, execute a command, call an MCP server's tool, or another tool) in sail's harness-neutral form: the tool, its kind, the paths it touches, its command or server. Every tool call is decided against its step's permissions before it runs, and its `tool:end` carries the start of what it returned.
_Avoid_: tool use, action, request, invocation

**Denial**:
A tool call refused for falling outside the step's permissions, recorded with the permissions that refused it. The agent carries on.
_Avoid_: block, violation, rejection

**Pid-held file**:
A record file created whole by an exclusive link and removed only under its drop token, `<file>.drop`, after checking the record is unchanged. The drop token is itself a pid-held file; a dead holder's token is broken under the next drop token, with bounded depth.
_Avoid_: lock, mutex

**Exclusive slot**:
A script step's hold on a named slot within the selected machine directory, declared as `exclusive: '<name>'`, kept in `~/.sail/slots/` (`$SAIL_HOME/slots/` when set). One step sharing that directory holds a name at a time; different machine directories have independent slots. A step that finds it held waits and emits `step:queued` naming the holder. The slot is stale only once its holder's pid is dead.
_Avoid_: lock, mutex, semaphore

**Idle limit**:
An agent step's `budget.maxIdleMinutes`, by default a quarter of `maxMinutes`: how long it may emit no event before it is marked stalled. Agent steps only.
_Avoid_: inactivity timeout, heartbeat

**Stalled**:
A running agent step that has emitted no event for its idle limit. It is marked, never ended by the idle limit: the dashboard marks its run in the list until the step speaks again.
_Avoid_: hung, stuck, frozen

**Budget**:
An agent step's budget also names its idle limit, which warns rather than ends it. The most a step may spend (turns, dollars, minutes) and the most a run may spend overall. A step over budget ends in `error`; a run over budget is suspended, and a raise lets it resume.
_Avoid_: limit, quota, cap, allowance

**Usage limit**:
The provider refusing more sessions until a reset time. A harness reports it as the error reason `usage_limit`, with `resetsAt` when the provider says when. It is a limit on the account, not a budget of the run. A watcher that finds one holds every watched workflow on the machine that reaches the same harness key, in `holds/` in the machine directory, not only the workflow whose run hit it.
_Avoid_: rate limit, quota, session limit

**Harness key**:
The account a usage limit counts against, named by the adapter a call's harness ran on, and for pi by its provider too: `claude-code`, `pi:openai-codex`. A suspended call's key comes from its run header and roster, and a workflow reaches the keys of its agent steps' model aliases. A call the roster can't place has the default harness's key.
_Avoid_: harness name, account id

### Ports

**Port**:
The engine's contract with one kind of external system, stated in sail's language whatever the provider. Adapters fill it. Every port ships with a fake adapter for tests.
_Avoid_: interface (the TypeScript keyword), SPI, abstraction

**TicketSource**:
The port to the ticket system: fetch a ticket with its comments, links, attachments and prerequisites; list its tickets by state and label, add and remove its labels, relate it to another ticket, closing a duplicate; edit its title and description; update it; comment on it; file a new one with its labels; attach a file to it; download a file it hosts, never one a link points to. It reports a ticket's state by type (unstarted, started, completed or canceled) and moves it to unstarted, in progress, in review or done (ADR-0015). v1 adapter: Linear. It may name its scope, the part of the provider it reads, such as a Linear team.
_Avoid_: tracker, task manager, board, issue source

**CodeHost**:
The port to the repository host: push a branch; open a pull request and link it to the ticket; poll designated pull requests; read their checks, rerun the failed ones and read a check's log; edit their title and description, keeping the ticket marker; label, comment on and merge them. A merge counts only once the host reports it, never when it was merely requested. v1 adapter: GitHub.
_Avoid_: git provider, repo host, SCM, VCS

**Checks**:
The status checks the code host reports for a pull request's head sha: the repository's CI. A workflow reads them through CodeHost. They are distinct from any tests a workflow runs itself.
_Avoid_: CI (ambiguous), tests, status

**Expected head**:
The head sha a merge names: the one the workflow checked. The host merges the pull request only while it is still at that head, and refuses it, with nothing sent, once it has moved.
_Avoid_: base sha, review sha

**Harness**:
The port that runs an agent step: a session with tools, permissions enforced on every tool call, a way to submit output, and mandatory usage reporting. A step runs on the config's default harness, or on the named harness its model alias names. v1 adapters: Claude Code, and pi, whose providers include non-Anthropic and local models.
_Avoid_: agent provider, runner, executor, model

**Jev port**:
The optional port to Jev: `ask` a state's typed questions and get their answers keyed by name. A script step reaches it with `sail port jev ask`, and each answered call leaves a `jev:asked` event. Unlike the other four ports, no run resolves it: only `sail port jev` does, and the config may leave `adapters.jev` out. v1 adapter: `typesafe`, which reads its endpoint from `SAIL_TYPESAFE_API_URL`, never the config, and sends `TYPESAFE_API_KEY` only to `https://api.typesafe.ai` or a loopback host.
_Avoid_: judge port, oracle port, LLM port

**Codex login**:
The ChatGPT subscription the pi harness runs `openai-codex` models on. `sail login codex` keeps its OAuth tokens in sail's own macOS keychain item, and pi refreshes the access token there when it has under five minutes left, under a lock every sail process shares, as each refresh token is good for one refresh.
_Avoid_: Codex key, Codex API key

**Workspace port**:
The port that gives a run its workspace and takes it away again. v1 adapter: `git-worktree`, one worktree per run, so runs execute in parallel.
_Avoid_: worktree manager, checkout service

**Adapter**:
One implementation of a port for one provider, selected in the config: by name for a built-in, by module path for the repository's own.
_Avoid_: plugin, driver, connector, integration, backend

**Port command**:
`sail port <port> <operation>`: how a script step reaches the configured adapter of a port (`ticket-source`, `codehost` or `jev`), with arguments in and one line of JSON out. A script step names the ports it calls in `ports`. Under a script step it leaves its provider events in the step's port events file, `port-events.ndjson` in the call directory, and they join the run's event stream when the step ends, with the step's key. A call that fails leaves an `error:port` event there, with the port's message.
_Avoid_: port helper, port CLI, bridge

**Adapter registry**:
Resolves the adapter that fills each port from the config, a built-in by name or the repository's own by module path.
_Avoid_: plugin loader, factory, registry (alone)

**Adapter definition**:
What makes an adapter: the environment variables it requires, the versions it runs with, and how it is created from its options.
_Avoid_: factory, plugin, provider

**Preflight**:
The checks before a run starts that need no run directory: the config, the adapters and their credentials, a credential filled from its credential source counting as set. A failed one is a refusal.
_Avoid_: startup check, validation, health check

**Credential source**:
Where sail reads a credential variable an adapter requires when the environment leaves it unset or empty: the keychain items `linear-api-key` (`LINEAR_API_KEY`), `claude-oauth-token` (`CLAUDE_CODE_OAUTH_TOKEN`) and `typesafe-api-key` (`TYPESAFE_API_KEY`), or `gh auth token` (`GITHUB_TOKEN`). The sources are fixed, a variable that is set is never looked up, and `SAIL_CREDENTIAL_LOOKUP=off` turns the lookup off. A value so filled is masked like any credential.
_Avoid_: credential provider, secret store

**Port suite**:
The tests every adapter of a port must pass, shared by the fake and the real one. A real adapter runs them against its provider on demand.
_Avoid_: contract suite, contract tests (a stage has the contract)

**Capabilities**:
What an adapter declares it can do, such as the ticket moves it supports or the merge methods it offers. The engine refuses a workflow that needs one its adapter lacks.
_Avoid_: features, support flags

**Provider**:
The external system behind an adapter: Linear, GitHub, Anthropic, TypeSafe, Jira.
_Avoid_: vendor, platform, service

### Judgments

**Jev**:
TypeSafe's System One model, asked typed questions about a state. It answers in calibrated probabilities, fast enough to ask in the middle of a step.
_Avoid_: oracle, classifier, LLM call

**System One**:
TypeSafe's API for Jev's fast, typed, calibrated answers. It names the provider's product, never a sail thing.
_Avoid_: using it for the Jev port or its adapter

**Question**:
A named, typed question about a state: its question type, its instructions and its criteria. The question types are `choice` (one of the named options), `score` (one of the ordered levels) and `noul` (a probability that the answer is yes).
_Avoid_: prompt, query, question kind (Kind is a step's word)

**Answer**:
Jev's typed reply to one question, with its confidence and probabilities where Jev reports them. A call's answers are keyed by their questions' names.
_Avoid_: output, result, verdict

### Watching

**Watched workflow**:
A workflow that declares `watch: { every, label? }` and `maxConcurrentRuns`, which makes it watchable. Once named to a watcher, the watcher polls for its sources, queues them and dispatches its runs. Before each poll the watcher re-reads that `watch` and `maxConcurrentRuns` from the `.sail/` committed at the fetched default branch's tip, and applies a change to the cap, label or interval with no restart; a label another watched workflow or watcher polls is refused, and a re-read that fails keeps the last declaration. Several can run at once, each with its own queue and cap (ADR-0017, ADR-0019).
_Avoid_: loop, line, daemon, pipeline

**Watcher**:
The resident process that automates one repository's watch set: it polls and it dispatches. `sail watch <workflow…>` starts it in the clone where it is run, or adds to the live one; `sail watch` with no names does so for every workflow that declares a watch. There is one per repository. Each run it dispatches fetches before it makes its worktree, and runs start from `origin/<default>` in detached worktrees. A dispatched run, and every resume of it, reads its `.sail/` and conventions from the commit it fetched, never the clone's working tree, and records that commit as `definitionsSha`; a workflow missing or broken there is refused, naming the commit; one whose definitions need a newer sail holds the dispatch rather than failing or parking its item. Before it dispatches it fast-forwards a clean clone of the default branch that has no local commits, and never touches one in any other state, saying why it didn't. It re-reads each watched workflow's `watch` and `maxConcurrentRuns` from the committed `.sail/` before every poll and applies a change without a restart, a clashing label refused. It is sail's home in v1. Without one running, nothing starts on its own.
_Avoid_: daemon, monitor, poller, scheduler

**Watch set**:
The watched workflows a watcher is watching now: exactly those named with `sail watch` (every workflow that declares a watch, when it names none), minus those removed with `sail unwatch` (the whole set, when it names none). It is never remembered across restarts, and the watcher exits when it becomes empty. Each change is a `watch:added` or `watch:removed` event in that workflow's queue event stream, naming the watcher's pid. Neither unwatching a workflow nor stopping the watcher touches its runs, which go on running; `sail stop` stops one (ADR-0019).
_Avoid_: enabled workflows, active loops, subscriptions

**Watch state**:
Whether a watched workflow is being watched now, said from the repository's live watcher alone, never from its queue's `watch:added` and `watch:removed` events: `watched` while the live watcher in this clone has it in its watch set, `not watched` while that watcher runs without it, and `watcher not running` while no watcher runs, or one runs in another clone. Each state but `watched` carries the reason the dashboard's server refuses a queue change with, and the dashboard shows that one state, in the same words, on its row in the Queues view and in the queue view.
_Avoid_: watch status, watch mode

**Watcher registry**:
The machine-level record of repositories in `~/.sail/watchers/` (`$SAIL_HOME/watchers/` when set), one `<name>.json` per repository: its `name`, remote, clone path and `.sail/` path, and later the watcher's pid and the labels it polls. Every `sail <ticket>` and `sail resume` writes its repository's entry before the run opens, so an entry exists before any watcher does. A watcher refuses to start if a live one has the same `name` or holds one of its labels on the same TicketSource and scope, such as the same Linear team. The dashboard reads it to find every repository, including those whose watcher has stopped.
_Avoid_: registry (alone; the config also has an adapter registry), roster, manifest

**Branch lease**:
A run's exclusive hold on its git branch, from workspace creation to release, kept while the run is suspended. Leases are shared within the selected machine directory, in `~/.sail/leases/` (`$SAIL_HOME/leases/` when set); different machine directories have independent leases. They are keyed by the remote's host, lower-cased, and its path, lower-cased, without `.git` or a trailing `/`, and by the branch. Scheme, user and port are ignored, so an ssh and an https clone of one repository share them. A remote with no host is used as it is. Leases are stale only once the run is neither running nor suspended. A lease whose run has no status yet is stale once its pid is dead, and the same run leasing again renews it (a resume). A run marks its lease as held by no process as the last act of a suspend, so a resume takes it whatever its pid. Dispatch skips a source whose branch is leased, and manual runs take leases too. Because worktrees are detached, leases are the only thing keeping runs apart (ADR-0018).
_Avoid_: lock, branch lock, reservation

**Adoption**:
A restarted watcher taking charge again of a run that is still alive, counting it against its cap. A run whose process died is resumed from its journal instead, once, as a detached `sail resume` of its own; a resume that leaves the run unended parks its item with the reason. A run suspended on the usage limit is the exception: it is held until the limit resets, which holds the dispatch of every watched workflow on the machine that reaches its harness key, then resumed, and again each time a resume hits the limit anew; only a resume that leaves it on the same limit parks its item. So is a run suspended on an unavailable port: its item is held for a growing back-off, then resumed, and parked only after a bounded run of resumes that all hit an unavailable port again. A stopped run's item is parked too. A held run is neither adopted past a live holder nor resumed: the watcher leaves it to a person.
_Avoid_: reattach, recovery, takeover

**Poll**:
One timed sweep for eligible designated tickets and designated pull requests, appending each as a source to its workflow's queue.
_Avoid_: sweep, scan, sync

**Queue**:
The sources waiting for a run, kept per workflow and deduplicated. A queued item is always a source, never a resolved input. Its order is the queue order.
_Avoid_: backlog, inbox, buffer

**Queue order**:
The order a queue dispatches its items in, and the order `queue.json` keeps them: by priority (urgent, high, medium, low, none), oldest first within one. A pull request counts as none. A poll that finds a queued ticket at another priority moves it to its new place. A person can move a queued item next to another by hand (`sail queue move`, or the dashboard's arrows): it keeps that place, whatever its priority, until it is dispatched or dropped.
_Avoid_: ranking, sort, schedule

**Queue event stream**:
A watched workflow's own event stream, `.sail-runs/queue/<workflow>/events.ndjson`: polls, queue items, dispatches, skips, a ticket waiting on its prerequisites, parking and errors, in the run's envelope without `runId`, and append-only across restarts.
_Avoid_: queue log, daemon log

**Dedup key**:
The key a queue item is known by, minted from its source: `ticket:<ticket key>`, and `pr:<number>@<sha7>` so a new push is a new item. A key already queued, dispatched, waiting to retry or parked is not queued again.
_Avoid_: item id, queue key

**Held dispatch**:
A watched workflow's dispatch stopped until a time, because one of its runs, or a run of any watched workflow on the machine that reaches the same harness key, hit the usage limit, or because two or more of its items are held on an unavailable port at the same time, which is an outage of the provider. It is kept in `queue.json`, and the queue is not changed: nothing starts or resumes until the reset, or a back-off when the provider gave none, or, for an outage, the later of the items' holds, and no item's attempt is counted. A start refused because the `.sail/` committed at the default branch needs a newer sail holds it too, with no time: until the running sail's SDK changes, which the watcher's next tick finds. A usage-limit hold ends at its reset, at `sail watch --release-hold <harness key>` or at the dashboard's Release on the queue's banner; after a release every watcher resumes its held runs on its next tick, and the hold is not put back unless the limit is hit again.
_Avoid_: paused (the poll's word), throttled, frozen

**Held item**:
A queue item whose run is suspended on an unavailable port, held for its back-off (1, 2, 5, 10 or 30 minutes by its place in the run of such suspensions) while the rest of the workflow dispatches. It is kept as `held` on the item in `queue.json`, and its `queue:held` and `queue:released` events carry its dedup key. The hold ends and the run is resumed once the back-off has passed; a second held item turns it into a held dispatch.
_Avoid_: paused item, snoozed item, delayed item

**Parked**:
A queue item's state once it has failed its last attempt: kept with the reason, never retried, until a person requeues or drops it.
_Avoid_: dead-lettered, stuck, quarantined

**Command file**:
A request to the live watcher, a JSON file dropped in `.sail-runs/watcher/commands/`. The watcher applies it and deletes it, so it stays the only writer of its own state (ADR-0019). Its operations are poll, watch, unwatch, add, requeue, drop and move. Every command is safe to apply twice.
_Avoid_: message, signal, IPC

**Dispatch**:
The watcher taking the next queued source and starting an ordinary run, only while the workflow's live runs in the clone, those started by hand included, and its held runs are under its maximum of concurrent runs and after re-checking the source is still eligible. A source whose branch a live run's lease holds waits, using no slot. A ticket with an open prerequisite waits too, using no slot and counting no attempt, and the next tick re-checks it fresh; the queue names what it waits on and says so once per change. An item a failed ticket read left failed is queued again, and says so again, once its ticket reads with a prerequisite still open. For a ticket, the dispatched run's intake claims the ticket, as a run started by hand does. A ticket claimed by the workflow's own run that then failed or was stopped stays eligible, so its retry and its requeue run again, and that run starts with `--force`.
_Avoid_: pickup, schedule, spawn

**Dashboard**:
The live view `sail dashboard` serves on localhost for the whole machine: every watcher in the registry, with its runs, stage cards from the roster, the inspector, what needs attention, its queues and a command menu on Cmd+K. It reads the run directories and queue files in each registered clone. It controls what its offers allow, and each posts to the local server, which answers in `sail`'s own words. Watch, poll, add a ticket, requeue and move run at once (watch, unwatch and poll are also on a queue's row in the Queues view): the Queues view's repository row watches the repository's workflows, all at once, and a queue view's header one workflow; a watch runs `sail watch` in the clone and starts a watcher, detached, when none is live, which outlives the dashboard, and the queue's commands are checked as `sail queue` checks them, dropped as a command file for the watcher, and wait for the watcher to take it, changing no queue themselves. While the workflow is not watched, or its watcher is not running, the queue's controls are disabled with the server's reason beside them, and the Queues view and the queue view name that one watch state. Rebuild runs at once too, for a run whose `summary.json` can't be parsed or is not a `sail.summary.v1`: the server calls the code `sail show --rebuild` calls, rewrites the file from the events and answers with its line (`rebuilt <path>`) or its refusal. Unwatch, Unwatch all, dismiss and All clear run at once too and can be undone for 8 s. On the banner of a queue held on a usage limit, Release opens the confirmation dialog and releases that hold on its harness key as `sail watch --release-hold` does: the server writes the release to `holds/` in the machine directory itself, drops no command file and needs no watcher. A run's Resume, Restart, Stop, Stop now, Suspend and hold and Clean are in its run view's view header, a button for each its status has (Stop while it runs, Resume while suspended, Restart and Clean once failed) and the rest behind a ⋯ (Suspend and hold is offered while the run runs), among them Resume of a run that reads `running` though no live process holds its branch lease, as after a kill, Restart of a completed run and Rebuild, and in its list row's ⋯ menu, drawn over the list; a queue view's view header carries poll and its workflow's watch or unwatch, an unavailable one shown disabled with its reason. A list row's ⋯ opens the run's actions. Stop, Stop now, Suspend and hold, Resume, Restart, drop, Clean and the add that skips its ticket's checks open the confirmation dialog: Resume and Restart start `sail resume` or `sail run --from-run … --continue` themselves (Restart's dialog also ticks `this stage only`, which drops `--continue`, and `from the base`, which adds `--from-base`), detached in the clone, and answer once the run has started, and the page then opens it; Stop (`sail stop`), Stop now (`sail stop --now`), Suspend and hold (`sail stop --suspend`) and Clean (`sail clean`) call the same engine code in the server, and a Clean says first what it removes and where the run directory goes, and asks requeue or drop when a queue item names the run, then goes back to the index. A clean of every failed run is in History's head, `clean all failed`: the sidebar's repository's while it filters on one, else every repository's. It confirms once in a dialog that gives the count and lists each run, and, when a listed run has a queue item, asks skip, requeue or drop for those items (skip first, so a run it names is left as `sail clean` leaves it); the server then cleans the listed runs one at a time and answers one line per run in `sail clean`'s words, a run it refused not stopping the others. A Clean of the History Selection confirms once, in one dialog that lists each run that goes and each it skips with the server's reason, a queue item's run among them, then cleans run by run through the same route, one toast each. Every answer, a refusal in `sail`'s own words included, is a toast, and while a request is open its subject's row reads the action under way. A run is started from a ticket or a pull request, of any workflow of the repository, through the command menu: the server runs `sail <source> --workflow <name> --dry-run` in the clone and the confirmation dialog shows the roster it printed; confirming runs `sail <source> … --run-id <id>` detached in the clone, so it needs no watcher and the page opens the run. A check or a start `sail` refuses is a toast in its words, and when `--force` or `--ignore-prerequisites` would override it, a "start anyway" command names the check, and confirms in a dialog that does. Everything else is the CLI's. A view opens with its first row selected, on the page's first load and on every change of view, except where the URL names a run or queue, which wins, and under 800px, where the list and the centre are two screens. Esc closes the open run or queue and leaves an empty state in the centre, a headline, the view's counts and the keys, with no row selected until one is opened or the view changes; the list keeps its width. Its URL names what the centre shows (a run or a queue), the selected call, inspector tab and open file, and the list's view; Back and forward move through a person's selections, and a Copy link button in the top bar copies it. A URL naming a run or queue that is not listed opens none and says so in a toast. Under 1100px the inspector lies over the centre, and under 800px the list and the open run or queue are two screens.
_Avoid_: UI, console, monitor, board

**Sidebar**:
The dashboard's navigation column, 180px wide and never growing with activity: Inbox, Active, Queues and History, each with a count, then every repository as a filter, with a dot for its watcher (watching, not watching or broken). It holds no run row, run menu or watch button. Under 800px it folds behind a button in the top bar.
_Avoid_: rail, nav, menu

**List**:
The one component every dashboard view draws its rows on: a column of fixed width (340px from 800px up) beside the centre, whether or not a row is open, so opening or closing one moves nothing. Folding groups, one line per row in one narrow form, a keyboard cursor and a filter field. A clicked row opens its run or queue in the centre, and so does the view's first row (the first that opens something, in a group not folded) when the view is chosen or the page loads. History's head carries two more controls, a status and a workflow, and the count of the Selection.
_Avoid_: table, grid, feed

**Keyed pane**:
The pane `j`, `k`, the arrows and `Enter` drive while the list and an open run or queue both show, from 800px up: the list, whose cursor walks its rows, or the centre, whose cursor walks the stage cards. `w` gives the keys to the other pane, each cursor keeping its place; a click in a pane gives them to it, and opening a row, by `Enter` or a click, gives them to the centre. A view opened with its first row starts with them in the list, so moving the list's cursor leaves the open run as it is until `Enter`. The keyed pane is topped by a line in the focus colour, and only its cursor is drawn. Under 800px, or with nothing open, the keys drive what shows. Tab stays the browser's.
_Avoid_: focus (the focused subject's word), active pane

**Selection**:
The History rows a person marked with `x`, counted in the list's head, for the one action that takes several, Clean. A row a filter hides is not in it, and a change of view or `Escape` empties it.
_Avoid_: multi-select, checked rows

**Active view**:
The list of live runs: those that wait on a person, suspended or unreadable, first under `waiting on you`, then the running ones under `running`.
_Avoid_: running block, live runs

**Inbox**:
The list of what needs attention: a row for each run that failed or has a call in error, each parked item and each problem, under `runs`, `parked` and `problems`. It is the sidebar's first entry, whose count is its rows under the repository filter. A row opens its run, at its last call in error, or its queue beside the list, which stays on the Inbox.
_Avoid_: alerts, notifications

**History view**:
The list of ended runs, failed and completed together: one newest-first list grouped by the day a run started (`Today`, `Yesterday`, then the date), with the runs that have no start time last.
_Avoid_: archive, past runs

**View header**:
The top line of the dashboard's run view or queue view, naming what it shows and carrying its actions: a run's buttons for its status and a ⋯ for the rest, or a queue's poll and its workflow's watch or unwatch. It is drawn on the page and is not the run header, the `run.json` a run writes at start.
_Avoid_: run header (the `run.json` one), title bar, toolbar

**Queues view**:
The list of every workflow's queue: one group per repository, its header carrying the repository's watch buttons, and one row per queue under it. A queue's row names its watch state, what waits, runs, failed and is parked (a zero count left out), when it was last polled, a paused poll and a held dispatch, and carries poll, watch and unwatch beside its open button, which opens its queue view beside the list.
_Avoid_: queue list, watchers view

**Offer**:
What the dashboard's server says a subject (a run, a queue item, a workflow, a repository) can have done to it now: each action it gives is `enabled`, or carries a `why` it is not, and an action it leaves out is not offered. The index and the queues answer carry the offers of queues, items, workflows and repositories, and a run's actions route those of a run.
_Avoid_: permission (a step's word), capability (an adapter's word)

**Dashboard action**:
One thing the dashboard's page can have done: stop, stop now, suspend and hold, resume, restart, clean, clean every failed run, rebuild, drop, requeue, move, poll, release a usage-limit hold, add, add skipping its checks, watch, unwatch, start a run, start anyway with `--force`, start anyway with `--ignore-prerequisites`, dismiss or all clear. Each is defined once in the page's registry: its id and label, the subject it applies to, its availability from the offers, its parameters, its tier (`instant`, `undoable` or `confirmed`), its key, its request and what its answer means. The page's view actions, which change what is shown and ask the server nothing, are not Dashboard actions.
_Avoid_: command (the CLI's and the watcher's word), control, operation

**Subject**:
What a Dashboard action is done to: a run, a queue item, a workflow, a repository or nothing. The focused subject is the one last hovered, put under the cursor or opened, whichever changed last; it is the command menu's first line and frozen while the menu is open.
_Avoid_: target, selection, context

**Command menu**:
The menu Cmd+K or Ctrl+K opens, or a right-click on a row opens at the pointer: the focused subject's actions, "go to" (the four views, each with its key, then queues, repositories, runs and queue items, ranked by match: exact, prefix, whole title words, then fuzzy; a kind's own word, such as `queue`, lists the kind, and a run that ended comes last and never on a fuzzy match), and the actions that need no subject. An action's parameters are its steps, asked in the menu; a confirmed action then opens the confirmation dialog. A disabled action is drawn with its reason. Escape goes back one step, then lets go of the subject, whose chip and actions go, then closes the menu. Backspace in the empty field lets go of the subject too.
_Avoid_: palette, launcher, omnibar

**Shortcut sheet**:
The overlay `?` opens over the dashboard, in the command menu's place and style: every key the page handles, grouped Global, List, Run, Queue item and Inbox. It is generated from the one table of navigation keys the key handler reads and from the Dashboard actions' keys, so it lists only keys that do something. A Dashboard action's key does it to the focused subject as its button does, opening its confirmation dialog when it has one, and a key whose action can't be done says why in a toast. `Escape`, `?` or a click outside closes it.
_Avoid_: cheat sheet, help, keymap (the table's module)

**Stage card**:
One call's card in the dashboard's run view, with its outcome, tries, duration, cost and denials, or a pending card for a roster stage the run hasn't called yet. Cards come from the run's events and its roster alone, so a new stage shows with no dashboard change.
_Avoid_: tile, step card, job

**Timeline**:
One call's events in order, drawn where the run view's cards were when a stage card is opened, and followed live while the call runs. It shows thinking, messages, steps, tries, script commands, a step queued for its exclusive slot with the run holding it, and each tool call: its input, and once it ends, its status, duration, the start of its result and any denial. It comes from the run's events alone, so a running call shows one before its transcript is written.
_Avoid_: feed, activity, live log, stream (the event stream's word)

**Inspector**:
The dashboard's panel for one call, with its overview, files, permissions and log tabs. It explains a denial from the run's files alone: the command, the rule, and the step's permissions under it. It opens when a stage card is selected and closes with it; `i` pins it open.
_Avoid_: details pane, drawer

**Needs attention**:
The dashboard's one list, across every repository, of what a person should look at because it failed: one row per run that failed or has a call whose outcome is `error`, carrying the run's stop reason, its calls in error and its denial count and opening its last call in error, plus parked items and problems. It is what the Inbox lists, beside the open run. A row is dismissed with `e` or its ✕, and an All clear button in the Inbox's head, shown while it lists any, or Shift+E empties the rows it shows in that browser, with no request and no change to any run: the rows shown at the click stay hidden across reloads until their run, call, workflow, title or detail changes, and a new failure is listed as usual. Each toast offers Undo, which lists them again.
_Avoid_: alerts, signals, triage

**Toast**:
The dashboard's answer to an action, drawn at the bottom right and naming the action and its subject. A success leaves after 4 s; a refusal is red, quotes `sail`'s own words and stays until it is dismissed.
_Avoid_: notice, snackbar, chip

**Confirmation dialog**:
The one dialog a stop, stop now, suspend and hold, resume, restart, drop, clean, release of a usage-limit hold, an add that skips its ticket's checks or a start of a run opens before it is done: a title naming the action and its subject, a field for each parameter the action asks there (Resume's raise, Restart's stage and its two ticks, this stage only and from the base, a Clean's requeue or drop of the queue item that names the run, and skip, requeue or drop for the queue items of a clean of every failed run), one line per consequence (a Clean of the Selection or of every failed run: a line per run that goes and a `skips` line per run that can't), a start's roster as a preformatted text under them, which a change of a field draws again, and one button with the verb. A value it can't send keeps it open with the reason beside the field. Enter confirms and Esc cancels.
_Avoid_: modal, popup, prompt, armed button
