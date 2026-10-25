Show the change on this branch working the way a user would see it, and report what you saw. The tests passed
already: this checks the behaviour itself, through sail as a user runs it, not through the tests the branch added.

Read the plan at `{{plan}}`: its Acceptance Criteria, and its Demonstration section, which names for each criterion the
scenario to set up and what to observe. The change's surface is `{{surface}}`. Read the branch's commits
(`git log origin/staging..HEAD`, `git diff origin/staging...HEAD`) to know what changed, never to decide what should
be seen: the plan says that.

## The demo harness

Run sail only through `.sail/lib/demo.sh`. It runs this branch's `sail` in a scratch repository with every port on
`fake`, a HOME of its own and no variables from this run, so nothing you do costs money or touches the branch.

- `.sail/lib/demo.sh new $STAGE_OUT/demo` makes a demo repository at `$STAGE_OUT/demo/repo`, holding the fixture
  repository's `.sail/` (`test/fixtures/repo/.sail/`): the `ticket-to-pr` workflow on fake ports, with `FAKE-1` seeded.
  `--from <dir>` copies another `.sail/` instead, such as one you wrote under `$STAGE_OUT`. Every port must be `fake`.
- `.sail/lib/demo.sh run $STAGE_OUT/demo <command> [args…]` commits what changed in the demo repository, runs the
  command there, prints its output and its exit code, and appends both to `$STAGE_OUT/demo/transcript.txt`. It exits
  with the command's code. Run `sail` by name: `.sail/lib/demo.sh run $STAGE_OUT/demo sail FAKE-1`.
- Set a scenario up by writing files under `$STAGE_OUT/demo/repo/.sail/` before the run: tickets in
  `fake/tickets.json`, agent answers in `fake/harness.json`, pull requests in `fake/prs.json`, and workflows and stages
  under `workflows/`. Read the fixture's own files for each format, and `src/adapters/fake/` for what the fakes accept.
  A run writes `.sail-runs/<run>/` in the demo repository: read its `events.ndjson`, `summary.json` and each call's
  `result.json` with `cat` and `grep`.
- Each scenario that needs a repository of its own gets one: `$STAGE_OUT/demo-2`, and so on.

## By surface

- `engine`: seed the scenario the ticket describes, run it, and check what the plan names: the exit code, the events
  in `events.ndjson` and their fields, `summary.json`, the call results.
- `cli`: run the command with the arguments the plan names, and compare its output, line by line, with the plan's.
  Output is not a terminal, so a command that draws for one prints its plain form.
- `dashboard`: make runs for the view to show, as for `engine`, then capture the view:
  `.sail/lib/demo.sh dashboard $STAGE_OUT/demo <name> repo=<project.yaml's name> run=<run id> key=<call key> tab=<tab>`
  serves the demo repository's runs with this branch's `sail dashboard`, opens it in headless Chrome on the run, call
  (`implement#1`) and inspector tab (`overview`, `files`, `permissions` or `log`) you name, each optional, waits for
  the page to settle, and writes `$STAGE_OUT/demo/<name>.png` and the page's DOM to `$STAGE_OUT/demo/<name>.html`.
  Without a run it opens the newest. Read the PNG to see what a user sees, and `grep` the DOM for the elements and
  text the plan names: the DOM is the evidence, the screenshot is what you looked at.

## Report what you saw

- A criterion is shown when what you observed matches what the plan says to observe. Quote the observation as its
  evidence: the output line, the event and its field.
- A criterion that isn't shown gets what you saw instead, quoted, and where the difference starts. Never call it shown
  because the code looks right, because a test covers it, or because the difference looks small.
- Change nothing outside `$STAGE_OUT`, and fix nothing: implement gets your report.
- End the step **blocked** only when you can't run the scenario at all: the harness refuses, or a tool it needs is
  missing. A change that runs and behaves wrong is a report, not a block.

## Submit

Submit each of the plan's acceptance criteria, in the plan's words, with whether it was shown and its evidence, and the
transcript: the commands from `transcript.txt` that show the criteria, with the output lines that matter, under 4000
characters.
