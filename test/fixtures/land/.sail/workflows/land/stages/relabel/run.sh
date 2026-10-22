#!/usr/bin/env bash
# The relabel stage: removes the label sail, then adds sail-landed, through `sail port codehost`. Its last stdout line
# is the labels after the second.
set -euo pipefail

pr=$(cat "$INPUT_PR")
sail port codehost remove-label "$pr" sail >/dev/null
sail port codehost add-label "$pr" sail-landed
