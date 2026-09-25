#!/usr/bin/env bash
# The tests stage, as a stub: the fixture repository has no code under test yet. It reports a passing run of no tests.
set -euo pipefail

cat >"${STAGE_OUT:?}/junit.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="0" failures="0"/>
XML
echo '{"ok":true,"total":0,"failed":0,"durationMs":0,"failures":[]}'
