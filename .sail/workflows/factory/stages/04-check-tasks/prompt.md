Check that every task of the plan at `{{plan}}` is implemented on this branch. Validation has passed already: this is
a surface check that nothing was skipped, not a code review.

Read the plan's Tasks list and each task's details. Then read the branch's commits (`git log origin/staging..HEAD`) and,
for each task, the commit that carries it (`git show --stat <sha>`, and the diff where the stat leaves it unclear).

A task is implemented when a commit makes the change its details describe, in the files they name or the ones the code
moved them to, with the tests an `impl` task calls for. A task is not implemented when no commit touches what it
describes, or a commit covers only part of it. Don't judge how well it is done: correctness, style and design are the
review's.

You only read. Don't change any file.

## Submit

Submit every task of the plan, by its id, whether it is implemented, and its evidence: the commit's sha and the files
that implement it, or what is missing.
