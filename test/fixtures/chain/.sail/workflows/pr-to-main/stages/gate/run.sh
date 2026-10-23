#!/usr/bin/env bash
# The gate stage: one `sail port codehost get-pull-request`. The base and the label are the host's strings, compared
# here and never passed on: the designation label is the one this workflow polls for, `sail`. Its last stdout line is
# `{ open, base, headSha, labelled }`.
set -euo pipefail

sail port codehost get-pull-request "$(cat "$INPUT_PR")" | "${SAIL_BUN:-bun}" -e '
  const pr = JSON.parse(await Bun.stdin.text());
  console.log(JSON.stringify({ open: pr.state === "open", base: pr.base, headSha: pr.headSha, labelled: pr.labels.includes("sail") }));
'
