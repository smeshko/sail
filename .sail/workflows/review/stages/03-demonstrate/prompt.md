Show the change in this pull request working the way a user would see it, and report what you saw. Validation runs
the tests beside you: this checks the behaviour itself, through sail as a user runs it, not through the tests the
change added.

The pull request is described at `{{brief}}`, and what it should do at `{{requirements}}`. Read the change
(`git log {{base}}..HEAD`, `git diff {{base}}...HEAD`) to know what changed, never to decide what should be seen.

## What to show

- When the pull request's body has a **Demonstration** section, it names the surface and, for each acceptance
  criterion, the scenario to set up and what to observe. Run those scenarios.
- When it has none, take the acceptance criteria from the requirements, pick the surface below that is closest to the
  user, and set up for each criterion the smallest scenario that shows it, deciding what to observe before you run it.
- When nothing a user runs changes (a refactor, types, docs, tests alone), submit no criteria, and say why in
  `skipped`.

## The demo harness

Run sail only through `.sail/lib/demo.sh`. It runs this branch's `sail` in a scratch repository with every port on
`fake`, a HOME of its own and no variables from this run, so nothing you do costs money or touches the branch.

- `.sail/lib/demo.sh new $STAGE_OUT/demo` makes a demo repository at `$STAGE_OUT/demo/repo`, holding the fixture
  repository's `.sail/` (`test/fixtures/repo/.sail/`): the `ticket-to-pr` workflow on fake ports, with `FAKE-1` seeded.
  `--from <dir>` copies another `.sail/` instead, such as one you wrote under `$STAGE_OUT`. Every port must be `fake`.
- `.sail/lib/demo.sh run $STAGE_OUT/demo <command> [args…]` commits what changed in the demo repository, runs the
  command there, prints its output and its exit code, and appends both to `$STAGE_OUT/demo/transcript.txt`. It exits
  with the command's code. Run `sail` by name: `.sail/lib/demo.sh run $STAGE_OUT/demo sail FAKE-1`.
- Set a scenario up by writing files under `$STAGE_OUT/demo/repo/.sail/` before the run, with your file tools, not
  `sed -i`, which the step's permissions refuse: tickets in
  `fake/tickets.json`, agent answers in `fake/harness.json`, pull requests in `fake/prs.json`, and workflows and stages
  under `workflows/`. Read the fixture's own files for each format, and `src/adapters/fake/` for what the fakes accept.
  A run writes `.sail-runs/<run>/` in the demo repository: read its `events.ndjson`, `summary.json` and each call's
  `result.json` with `cat` and `grep`.
- Each scenario that needs a repository of its own gets one: `$STAGE_OUT/demo-2`, and so on.

## By surface

- `engine`: seed the scenario the criterion describes, run it, and check what it names: the exit code, the events
  in `events.ndjson` and their fields, `summary.json`, the call results.
- `cli`: run the command with the arguments the scenario names, and compare its output, line by line, with what it
  expects.
  Output is not a terminal, so a command that draws for one prints its plain form.
- `dashboard`: make runs for the view to show, as for `engine`, then capture the view:
  `.sail/lib/demo.sh dashboard $STAGE_OUT/demo <name> repo=<project.yaml's name> run=<run id> key=<call key> tab=<tab>`
  serves the demo repository's runs with this branch's `sail dashboard`, opens it in headless Chrome on the run, call
  (`implement#1`) and inspector tab (`overview`, `files`, `permissions` or `log`) you name, each optional, waits for
  the page to settle, and writes `$STAGE_OUT/demo/<name>.png` and the page's DOM to `$STAGE_OUT/demo/<name>.html`.
  Without a run it opens the newest. Read the PNG to see what a user sees, and `grep` the DOM for the elements and
  text the scenario names: the DOM is the evidence, the screenshot is what you looked at.

## Report what you saw

- A criterion is shown when what you observed matches what its scenario says to observe. Quote the observation as its
  evidence: the output line, the event and its field.
- A criterion that isn't shown gets what you saw instead, quoted, and where the difference starts. Never call it shown
  because the code looks right, because a test covers it, or because the difference looks small.
- Change nothing outside `$STAGE_OUT`, and fix nothing: the judge gets your report.
- A scenario written as a test command (`bun run test`, `bun test`) is not one you can run: the step's
  permissions refuse it. Don't try it. Report that criterion shown only if a sail run in a demo repository shows it;
  otherwise report it not shown, saying a test is the only way it was written to be observed.
- The harness runs `sail` commands one at a time, in the foreground, with no shell: no pipe, no redirect, no command in
  the background, no second command while the first runs. A scenario that needs one, such as `sail … | head -1`, or a
  `sail stop` while `sail watch` runs, can't be run here. Don't work around it: report the criterion not shown, naming
  what the scenario needs that the harness doesn't run, and the judge decides.
- End the step **blocked** only when the harness itself can't run: `demo.sh new` fails, or a tool it needs is missing.
  A scenario the harness doesn't run is a report, as is a change that runs and behaves wrong.

## Submit

Submit each acceptance criterion you ran a scenario for, in the requirements' or the Demonstration section's words,
with whether it was shown and its evidence, and `skipped` null. Leave out a criterion only a test can observe:
validation runs the tests. Submit too the transcript: the commands from `transcript.txt` that show the criteria, with
the output lines that matter, under 4000 characters.
