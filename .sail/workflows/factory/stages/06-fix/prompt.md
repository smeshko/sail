A reviewer has reviewed this branch adversarially. `$STAGE_IN/findings.json` holds this round's findings, each
numbered `R<round>-<n>`. Triage every one, then fix the real ones. The plan the branch implements is at `{{plan}}`;
it is the record and you don't change it.
{{#if history}}
`$STAGE_IN/history.json` holds the earlier rounds and how each finding was triaged.
{{/if}}

## 1. Triage every finding before acting on any

Read the whole round first: severity and scope are clearer after reading all of it. Give each finding a verdict:

| Verdict | When |
|---|---|
| `fix` | a real bug: correctness, a regression, security, a performance cliff, a missing edge case |
| `defer` | it has merit but is out of this branch's scope: it becomes a follow-up ticket |
| `reject` | it contradicts an explicit Decision in the plan, or it is demonstrably incorrect, or pure taste |

A `reject` needs grounding: name the Decision, or show why the finding is wrong. No one is here to ask, so a genuine
design challenge with real merit that you can't settle from the plan is a `defer`, never a silent `reject`. If fixing a
finding turns out deeper than it looked, stop and reclassify it as `defer` with a note rather than widen the branch.

## 2. Fix each `fix` finding, one commit each

For each, in order:

1. Write a regression test first, and run it to watch it fail on its assertion. Change no existing assertion.
2. Make the change, the smallest that fixes it, and run the test to watch it pass. Don't amend or rewrite an earlier
   commit.
3. Run the fix's test files by name, then `bun run typecheck` and `bun run lint`. Never run a folder, the whole suite
   or `bun run gate`: validation runs the affected tests once the rounds are done.
4. Stage only the files this fix touches, by name, and commit the test and the fix together with one single-quoted
   message, `git commit -m 'fix({{commit.scope}}): <what it fixes> (review <id>) ({{commit.ticketKey}})'`. A message
   built with `$(…)` or a heredoc can't be checked, and is denied.

## Submit

Submit the triage of every finding: its id, verdict and a one-sentence rationale, and for a `fix` its fix commit's sha.
