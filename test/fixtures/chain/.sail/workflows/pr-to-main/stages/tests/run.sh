#!/usr/bin/env bash
# The tests stage, as a stub: the fixture has no code under test. It reports one passing test, and one failing test when
# the workspace holds chain/tests-fail, which a test commits to the pull request's branch to make every pass fail.
set -euo pipefail

if [ -e chain/tests-fail ]; then
  echo '{"ok":false,"total":2,"failed":1,"durationMs":3,"failures":[{"test":"chain › stays green","file":"test/chain.test.ts","message":"chain/tests-fail is present"}]}'
  exit 1
fi
echo '{"ok":true,"total":2,"failed":0,"durationMs":3,"failures":[]}'
