A reviewer has reviewed this branch adversarially. `$STAGE_IN/findings.json` holds this round's findings, each
numbered `R<round>-<n>`. Triage every one, then fix the real ones. The plan the branch implements is at `{{plan}}`; it is the
record and you don't change it.
{{#if history}}
`$STAGE_IN/history.json` holds the earlier rounds and how each finding was triaged.
{{/if}}

## 1. Triage every finding before acting on any

Read the whole round first: severity and scope are clearer after reading all of it. Give each finding a verdict:

| Verdict | When |
|---|---|
| `fix` | a real bug: correctness, a regression, security, a performance cliff, a missing edge case |
| `defer` | it has merit but is out of this branch's scope: it becomes a follow-up in the pull request |
| `reject` | it contradicts an explicit Decision in the plan, or it is demonstrably incorrect, or pure taste |

A `reject` needs grounding: name the Decision, or show why the finding is wrong. No one is here to ask, so a genuine
design challenge with real merit that you can't settle from the plan is a `defer`, never a silent `reject`. If fixing a
finding turns out deeper than it looked, stop and reclassify it as `defer` with a note rather than widen the branch.

## 2. Fix each `fix` finding, one commit each

For each, in order:

1. Make the change, the smallest that fixes it. Don't amend or rewrite an earlier commit.
2. Stage only the files this fix touches, by name, and commit:
   `fix({{commit.scope}}): <what it fixes> (review <id>) ({{commit.ticketKey}})`.
3. A test proves the fix: a regression case that fails before the fix and passes after it. The tests are locked, so it
   lands in a commit of its own, `test({{commit.scope}}): amend: a regression case for <what> (review <id>)
   ({{commit.ticketKey}})`, and changes no existing assertion.
4. Run `bun run gate`. The full suite runs once the rounds are done.

## Submit

Submit the triage of every finding: its id, verdict and a one-sentence rationale, and for a `fix` its fix commit's sha.
