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
A run started with `--force` on a ticket that is not designated, not in a pick-up state, or both. Its run header lists the checks `--force` overrode, `designation` and `state`.
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
One body inside a stage, run in order with its siblings. Every stage has at least one step, and most have exactly one and are written as that step. The steps of a stage share its `$STAGE_OUT`, and each step of a multi-step stage is journaled under `stage#call/step` as it finishes, so a resume runs only the steps after it.
_Avoid_: sub-stage, action, unit

**Kind**:
What a step is. v1 ships two kinds: `agent` and `script`. Kinds belong to steps; a stage has steps, not a kind. Kinds are an extension point: a new kind implements one interface. A built-in intake's call records the kind `builtin`, though no step runs: the engine runs its body in process.
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

**Group**:
The calls one `run.all()` makes at once. Their keys are assigned in the order given, before any starts, and each call is journaled as it completes, with the group's keys, so a resume runs only the ones not yet journaled.
_Avoid_: batch, fan-out, parallel block

**Try**:
One execution of a call's body, in a directory of its own. A call has a later try when a resume runs it again after an interruption, and one corrective try when the engine rejects what an agent step handed in: invalid output, a missing declared file or a failed validator. A corrective try's prompt ends with the problems of the try it corrects. A try belongs to a call's body, or to one step of a multi-step call: a step's later try sits in that step's own directory, and the call keeps one `$STAGE_OUT`.
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

The workflow routes on the outcome. An `error` fails the run with stop reason `stage_error`, unless the call passes `{ onError: 'return' }` to receive it. A multi-step stage's outcome is its last step's, or the outcome of the step that stopped it: a step that ends `blocked`, `failed` or `error` ends its stage, and the steps after it don't run.
_Avoid_: status (the run's word), result, state, verdict

**Blocked**:
The agent outcome for "I cannot complete this", submitted with a reason. It honours the contract, and the workflow decides what happens next.
_Avoid_: failed, stuck, gave up, incomplete

**Error**:
The outcome when a contract was not honoured: invalid output, a missing declared file, a timeout, a script that could not start, a budget exceeded, a model or harness failure, a port call that failed, or an unmapped exit code. It is never a verdict on the work. A result lists each problem with its reason: `invalid_output`, `missing_file`, `timeout`, `not_started`, `budget_exceeded`, `harness`, `usage_limit`, `port` or `exit_code`. The `port` reason covers a port call that failed and a port events file that holds something that is no provider event. A `port` error carries the code `unavailable` when the provider could not be reached: a step that doesn't pass on it is an error, whatever its exit code, and suspends the run, unless its call passed `{ onError: 'return' }`, whose workflow takes the error.
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
The named reason a run ended without completing, such as `workflow_failed`, `stage_error`, `budget_exceeded`, `determinism_violation`, `until`, `unwatched`, `stopped`, `interrupted`, `usage_limit` or `port_unavailable`. Every failed or suspended run carries exactly one.
_Avoid_: error message, cause, exit reason

**Refusal**:
A command's end before a run starts, with exit code 3: an invalid config, missing credentials, type errors, no workflow, a source the intake doesn't accept, a source that isn't designated or is already claimed, a leased branch, or a workspace that can't be made. A refusal leaves no run directory.
_Avoid_: rejection, abort, error (an outcome)

**Dry run**:
`sail <ticket> --dry-run`: the start's whole preflight (the config, credentials, the type check, the ticket and its designation, the branch lease) and the roster the run would freeze, printed. It writes nothing: no run directory, workspace, lease or comment, and no claim. It exits 0, or 3 with the start's own refusal.
_Avoid_: preview, simulation, plan

**Keep-awake**:
The hold a run's process takes against the machine's sleep, from its start or resume until it ends. It is released at the end, or by the OS when the process dies: `caffeinate` on macOS, none elsewhere or with `SAIL_KEEP_AWAKE=off`, and recorded as `run:keep_awake`. It doesn't stop a laptop on battery sleeping when its lid is closed.
_Avoid_: wake lock, caffeinate, sleep assertion

**Suspended**:
The status of a run that has exited with nothing running and a resume expected, for example because the run budget was exceeded, its workflow was unwatched, it hit the provider's usage limit, a step of it ended on a provider that was unavailable, or it was interrupted by Ctrl-C or SIGTERM. It keeps its workspace and its branch lease.
_Avoid_: paused, waiting, blocked, pending

**Control file**:
A run's `CONTROL` file in its run directory, a request to stop at its next call boundary: `unwatched`, which the watcher writes when the run's workflow is unwatched and which suspends the run, or `stopped`, which `sail stop` writes and which fails it. `sail stop --now` writes `stopped now`, ending the running call through its abort signal rather than waiting for the boundary. The run takes the request before its intake and before each call.
_Avoid_: signal file, kill file, flag

**Resume**:
Continuing a suspended or interrupted run from its journal. Every journaled call is replayed, and the first one that is not journaled runs.
_Avoid_: restart, rerun, retry, continue

**Raise**:
What is added to a suspended run's budget, in dollars or minutes, given to `sail resume` and recorded as a `budget:raised` event. `run.json` keeps the budget the run started with.
_Avoid_: top-up, extension, bump

**Seeded run**:
A new run whose journal starts with another run's calls, those before a named stage, so they aren't paid for again. `sail run --from-run <run> --stage <stage>` starts one. It runs that stage and stops, suspended with `until`, unless `--continue`. Its run header records the run it came from as `fromRun`. It claims nothing, and works on a branch of its own.
_Avoid_: rerun, fork, clone, replay

**Reused call**:
A call a seeded run took from its `fromRun` run: its call directory copied, its journal line seeded, and `fromRun` on its `journal:append` event and its summary entry. It costs the seeded run nothing.
_Avoid_: cached call, skipped call

**Workspace**:
The checkout a run works in, on its own branch. How it is made (a branch in the current clone, a git worktree, a container) is up to the workspace adapter.
_Avoid_: worktree (one mechanism), checkout, sandbox, working copy

**Workspace setup**:
The shell command the `git-worktree` adapter runs in each workspace it makes, before any stage runs: its `setup` option, such as `bun install --frozen-lockfile`. Every run gets it, a seeded run included, whose reused calls left nothing in its new workspace. A setup that fails refuses the run.
_Avoid_: bootstrap, install step, setup stage

**Base**:
The commit a run's workspace starts from: the default branch's tip on the remote after a fetch, or, when the run's branch is already on the remote, that branch's tip, recorded as `baseSha`. For a pull-request source it is the pull request's head.
_Avoid_: start point, fork point

**Run ref**:
`refs/sail/runs/<runId>` in the repository: where a run's commits are kept when its workspace is removed with its `HEAD` past its base and on no remote-tracking ref, recorded as `ref` on `workspace:released`. A failed run never pushed its branch, so this is where its work survives. `git branch` doesn't list it and gc keeps what it reaches; `git branch <name> refs/sail/runs/<runId>` recovers the work.
_Avoid_: backup branch, rescue ref

**Branch**:
Always the git branch, such as the one a run's workspace sits on. A workflow's routing decision is a route, never a branch.
_Avoid_: using "branch" for a route or a fork in the workflow

**Run directory**:
Everything a run wrote: the run header, the journal, the events, the summary, `definition/`, a copy of each roster stage's folder as the run started, which its calls read their prompts, templates and scripts from (for a run started from the `.sail/` committed at the default branch, as a dispatched one is, the whole of that `.sail/` and its conventions), and one directory per call holding its result and files.
_Avoid_: run folder, output directory, artifacts

**Run header**:
What was asked, written once at start and never changed: the source, the workflow and its hash, the roster, the budgets, and the versions and adapters in use. A run started from committed definitions also records `definitionsSha`, the commit its `.sail/` was read from.
_Avoid_: manifest, metadata, config snapshot

**Journal**:
The append-only record of completed calls and steps (key, outcome, output, files). A resume replays completed calls from it. To recover an unjournaled claim before its comment was posted, a later try of the built-in `ticket` intake also reads `ticket:claimed` from the run's event stream; without that event, a missing comment cannot establish ownership.
_Avoid_: log, history, state file, checkpoint

**Replay**:
Re-executing the workflow function after every completed call, so journaled calls return instantly and the first unjournaled one runs. Start, continue and resume share this one code path.
_Avoid_: rerun, recovery, fast-forward

**Determinism guard**:
The check that fails a run when the workflow asks for a key sequence that diverges from the journal, and, for a group, its whole key sequence. That is the sign of non-deterministic workflow code or a mid-run change.
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
The tokens and cost an agent step consumed, reported per turn by the harness. A harness that cannot report usage does not qualify. A Jev call reports its tokens too, on its `jev:asked`, when its adapter has them.
_Avoid_: consumption, spend, billing, metering

### Guardrails

**Gate file**:
A file `bun run verify` reads: the toolchain configs, the test launcher and preload, the coverage census, the lint config and `.github/`. A pull request could change one to loosen its own `verify` check; sail's review workflow hands a pull request that changes one to a human rather than merging it.
_Avoid_: protected file, CI file

**Redaction**:
Masking credential-named values of at least eight characters from the run's environment, their parts and URL userinfo, raw, URL-encoded and in base64, as `[redacted]` in the run header, events, summary, journal, results, completed script logs, port events and transcripts, and the terminal view. Produced files, prompts and bindings are not masked, nor are live script logs before the process ends.
_Avoid_: scrubbing, censoring, sanitising

**Guardrail**:
Any limit the engine enforces on a run: permissions, budgets, untrusted-input wrapping, the designation label. Guardrails are enforced by code, never requested in a prompt.
_Avoid_: policy, safety prompt, rule

**Permissions**:
What a step may do, declared per step: paths it may read and write, commands it may run and those it never may though its commands match them (`deny`), tools and servers it may reach. Enforced for agents; declared and recorded for scripts. Tools and MCP servers are listed by name (`WebFetch`, `server:tool`, or `server:*` for every tool of a server), and anything not listed is denied. Reads and writes are confined to the run's workspace and the step's `$STAGE_OUT`.
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
A running agent step that has emitted no event for its idle limit. It is marked, never ended by the idle limit: the dashboard marks its run in the run list and lists it in needs attention until the step speaks again.
_Avoid_: hung, stuck, frozen

**Budget**:
An agent step's budget also names its idle limit, which warns rather than ends it. The most a step may spend (turns, dollars, minutes) and the most a run may spend overall. A step over budget ends in `error`; a run over budget is suspended, and a raise lets it resume.
_Avoid_: limit, quota, cap, allowance

**Usage limit**:
The provider refusing more sessions until a reset time. A harness reports it as the error reason `usage_limit`, with `resetsAt` when the provider says when. It is a limit on the account, not a budget of the run.
_Avoid_: rate limit, quota, session limit

### Ports

**Port**:
The engine's contract with one kind of external system, stated in sail's language whatever the provider. Adapters fill it. Every port ships with a fake adapter for tests.
_Avoid_: interface (the TypeScript keyword), SPI, abstraction

**TicketSource**:
The port to the ticket system: fetch a ticket with its comments, links and attachments; list its tickets by state and label, add and remove its labels, relate it to another ticket, closing a duplicate; edit its title and description; update it; comment on it; file a new one with its labels; attach a file to it. It reports a ticket's state by type (unstarted, started, completed or canceled) and moves it to unstarted, in progress, in review or done (ADR-0015). v1 adapter: Linear. It may name its scope, the part of the provider it reads, such as a Linear team.
_Avoid_: tracker, task manager, board, issue source

**CodeHost**:
The port to the repository host: push a branch; open a pull request and link it to the ticket; poll designated pull requests; read their checks, rerun the failed ones and read a check's log; label, comment on and merge them. A merge counts only once the host reports it, never when it was merely requested. v1 adapter: GitHub.
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
The optional port to Jev: `ask` a state's typed questions and get their answers keyed by name. A script step reaches it with `sail port jev ask`, and each answered call leaves a `jev:asked` event. Unlike the other four ports, no run resolves it: only `sail port jev` does, and the config may leave `adapters.jev` out. v1 adapter: `typesafe`.
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
`sail port <port> <operation>`: how a script step reaches the configured adapter of a port (`ticket-source`, `codehost` or `jev`), with arguments in and one line of JSON out. Under a script step it leaves its provider events in the step's port events file, `port-events.ndjson` in the call directory, and they join the run's event stream when the step ends, with the step's key. A call that fails leaves an `error:port` event there, with the port's message.
_Avoid_: port helper, port CLI, bridge

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
A workflow that declares `watch: { every, label? }` and `maxConcurrentRuns`, which makes it watchable. Once named to a watcher, the watcher polls for its sources, queues them and dispatches its runs. Several can run at once, each with its own queue and cap (ADR-0017, ADR-0019).
_Avoid_: loop, line, daemon, pipeline

**Watcher**:
The resident process that automates one repository's watch set: it polls and it dispatches. `sail watch <workflow…>` starts it in the clone where it is run, or adds to the live one; `sail watch` with no names does so for every workflow that declares a watch. There is one per repository. Each run it dispatches fetches before it makes its worktree, and runs start from `origin/<default>` in detached worktrees. A dispatched run, and every resume of it, reads its `.sail/` and conventions from the commit it fetched, never the clone's working tree, and records that commit as `definitionsSha`; a workflow missing or broken there is refused, naming the commit. It is sail's home in v1. Without one running, nothing starts on its own.
_Avoid_: daemon, monitor, poller, scheduler

**Watch set**:
The watched workflows a watcher is watching now: exactly those named with `sail watch` (every workflow that declares a watch, when it names none), minus those removed with `sail unwatch` (the whole set, when it names none). It is never remembered across restarts, and the watcher exits when it becomes empty. Each change is a `watch:added` or `watch:removed` event in that workflow's queue event stream, naming the watcher's pid. Unwatching a workflow suspends its runs; stopping the watcher does not (ADR-0019).
_Avoid_: enabled workflows, active loops, subscriptions

**Watcher registry**:
The machine-level record of repositories in `~/.sail/watchers/` (`$SAIL_HOME/watchers/` when set), one `<name>.json` per repository: its `name`, remote, clone path and `.sail/` path, and later the watcher's pid and the labels it polls. Every `sail <ticket>` and `sail resume` writes its repository's entry before the run opens, so an entry exists before any watcher does. A watcher refuses to start if a live one has the same `name` or holds one of its labels on the same TicketSource and scope, such as the same Linear team. The dashboard reads it to find every repository, including those whose watcher has stopped.
_Avoid_: registry (alone; the config also has an adapter registry), roster, manifest

**Branch lease**:
A run's exclusive hold on its git branch, from workspace creation to release, kept while the run is suspended. Leases are shared within the selected machine directory, in `~/.sail/leases/` (`$SAIL_HOME/leases/` when set); different machine directories have independent leases. They are keyed by the remote's host, lower-cased, and its path, lower-cased, without `.git` or a trailing `/`, and by the branch. Scheme, user and port are ignored, so an ssh and an https clone of one repository share them. A remote with no host is used as it is. Leases are stale only once the run is neither running nor suspended. A lease whose run has no status yet is stale once its pid is dead, and the same run leasing again renews it (a resume). A run marks its lease as held by no process as the last act of a suspend, so a resume takes it whatever its pid. Dispatch skips a source whose branch is leased, and manual runs take leases too. Because worktrees are detached, leases are the only thing keeping runs apart (ADR-0018).
_Avoid_: lock, branch lock, reservation

**Adoption**:
A restarted watcher taking charge again of a run that is still alive, counting it against its cap. A run whose process died is resumed from its journal instead, once, as a detached `sail resume` of its own; a resume that leaves the run unended parks its item with the reason. A run suspended on the usage limit is the exception: it is held until the limit resets, then resumed, and again each time a resume hits the limit anew; only a resume that leaves it on the same limit parks its item. A stopped run's item is parked too.
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
A watched workflow's own event stream, `.sail-runs/queue/<workflow>/events.ndjson`: polls, queue items, dispatches, skips, parking and errors, in the run's envelope without `runId`, and append-only across restarts.
_Avoid_: queue log, daemon log

**Dedup key**:
The key a queue item is known by, minted from its source: `ticket:<ticket key>`, and `pr:<number>@<sha7>` so a new push is a new item. A key already queued, dispatched, waiting to retry or parked is not queued again.
_Avoid_: item id, queue key

**Held dispatch**:
A watched workflow's dispatch stopped until a time, because one of its runs hit the usage limit. It is kept in `queue.json`, and the queue is not changed: nothing starts or resumes until the reset, or a back-off when the provider gave none, and no item's attempt is counted.
_Avoid_: paused (the poll's word), throttled, frozen

**Parked**:
A queue item's state once it has failed its last attempt: kept with the reason, never retried, until a person requeues or drops it.
_Avoid_: dead-lettered, stuck, quarantined

**Command file**:
A request to the live watcher, a JSON file dropped in `.sail-runs/watcher/commands/`. The watcher applies it and deletes it, so it stays the only writer of its own state (ADR-0019). Its operations are poll, watch, unwatch, add, requeue, drop and move. Every command is safe to apply twice.
_Avoid_: message, signal, IPC

**Dispatch**:
The watcher taking the next queued source and starting an ordinary run, only while the workflow is under its maximum of concurrent runs and after re-checking the source is still eligible. A source whose branch a live run's lease holds waits, using no slot. For a ticket, the dispatched run's intake claims the ticket, as a run started by hand does. A ticket claimed by the workflow's own run that then failed or was stopped stays eligible, so its retry and its requeue run again, and that run starts with `--force`.
_Avoid_: pickup, schedule, spawn

**Dashboard**:
The live view `sail dashboard` serves on localhost for the whole machine: every watcher in the registry, with its runs, stage cards from the roster, the inspector, what needs attention, and its queues. It reads the run directories and queue files in each registered clone. Its one control is the ▲ and ▼ on a waiting queue item, which posts a move to the local server; the server only drops a command file for the watcher and changes no queue itself, and a refusal is shown beside the queue's header. Everything else is the CLI's (`sail watch`, `sail unwatch`, `sail queue …`, `sail stop`).
_Avoid_: UI, console, monitor, board

**Stage card**:
One call's card in the dashboard's run view, with its outcome, tries, duration, cost and denials, or a pending card for a roster stage the run hasn't called yet. Cards come from the run's events and its roster alone, so a new stage shows with no dashboard change.
_Avoid_: tile, step card, job

**Timeline**:
One call's events in order, drawn where the run view's cards were when a stage card is opened, and followed live while the call runs. It shows thinking, messages, steps, tries, script commands, a step queued for its exclusive slot with the run holding it, and each tool call: its input, and once it ends, its status, duration, the start of its result and any denial. It comes from the run's events alone, so a running call shows one before its transcript is written.
_Avoid_: feed, activity, live log, stream (the event stream's word)

**Inspector**:
The dashboard's panel for one call, with its overview, files, permissions and log tabs. It explains a denial from the run's files alone: the command, the rule, and the step's permissions under it.
_Avoid_: details pane, drawer

**Needs attention**:
The dashboard's one list, across every repository, of what a person should look at: failed and suspended runs, running runs with a stalled step, calls whose outcome is `error`, denials, parked items and problems. Each item opens its run and call. It opens as a pane from a button in the top bar, which counts its items.
_Avoid_: alerts, signals, triage
