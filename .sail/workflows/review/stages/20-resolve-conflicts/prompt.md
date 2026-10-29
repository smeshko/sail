This pull request's base moved on while it was reviewed, and the two now conflict. A merge of the base, at
`{{synced.baseSha}}`, is in progress in this checkout: `$STAGE_IN/synced.json` names the paths it left conflicted.
What the pull request should do is at `{{requirements}}`.

## Finish the merge

1. Read each conflicted path, and `git log` for what the base changed in it. Keep both: what the pull request does,
   and what the base changed. Where they can't both stand, the base wins on what the pull request doesn't touch, and
   the pull request wins on what its requirements ask for.
2. Leave no conflict marker behind. Regenerate a generated file rather than merging it by hand: `bun run types` for
   `types/`, `bun run golden` for the golden fixtures.
3. Run the test files of each path you resolved by name, then `bun run typecheck` and `bun run lint`. Never run a
   folder, the whole suite or `bun run gate`: validation runs after you.
4. Stage the resolved paths by name, then finish the merge with `git commit --no-edit`. Never start another merge,
   rebase or reset.

Read files with the Read tool, or `sed -n` for a range. Change them only with Edit and Write: `sed -i`, `python3` and
a heredoc into a file are denied, and each denial costs a turn.

If a conflict can't be resolved without deciding what the pull request should become, leave the merge unfinished
and say why.

## Submit

Submit the merge commit's sha from `git rev-parse HEAD`, or null when you left the merge unfinished, and a note on how
you resolved each path.
