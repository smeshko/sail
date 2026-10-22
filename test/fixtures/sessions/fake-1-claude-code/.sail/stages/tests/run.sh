#!/usr/bin/env bash
# The tests stage, as a stub: the fixture repository has no code under test, and no fake can change any. It plays the
# two reports of a fix loop by $CALL: the first call fails with one failing test, and every later call passes.
set -euo pipefail

if [ "$CALL" = 1 ]; then
  cat >"${STAGE_OUT:?}/junit.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="6" failures="1" time="0.009">
  <testsuite name="fixture" tests="6" failures="1" time="0.009">
    <testcase name="greet › greets by name" classname="test/greet.test.ts" time="0.001"/>
    <testcase name="greet › defaults to world" classname="test/greet.test.ts" time="0.001"/>
    <testcase name="greet › trims whitespace" classname="test/greet.test.ts" time="0.001"/>
    <testcase name="cli › prints help" classname="test/cli.test.ts" time="0.001"/>
    <testcase name="greet --shout › uppercases the name" classname="test/greet.test.ts" time="0.002">
      <failure message="Expected &quot;HELLO, ADA!&quot; but received &quot;HELLO, Ada!&quot;"/>
    </testcase>
    <testcase name="greet --shout › keeps the exclamation mark" classname="test/greet.test.ts" time="0.001"/>
  </testsuite>
</testsuites>
XML
  cat <<'OUT'
bun test v1.3.14
5 pass
1 fail
(fail) greet --shout › uppercases the name
{"ok":false,"total":6,"failed":1,"durationMs":2300,"failures":[{"test":"greet --shout › uppercases the name","file":"test/greet.test.ts","message":"Expected \"HELLO, ADA!\" but received \"HELLO, Ada!\""}]}
OUT
  exit 1
fi

cat >"${STAGE_OUT:?}/junit.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="7" failures="0" time="0.010">
  <testsuite name="fixture" tests="7" failures="0" time="0.010">
    <testcase name="greet › greets by name" classname="test/greet.test.ts" time="0.001"/>
    <testcase name="greet › defaults to world" classname="test/greet.test.ts" time="0.001"/>
    <testcase name="greet › trims whitespace" classname="test/greet.test.ts" time="0.001"/>
    <testcase name="cli › prints help" classname="test/cli.test.ts" time="0.001"/>
    <testcase name="greet --shout › uppercases the name" classname="test/greet.test.ts" time="0.001"/>
    <testcase name="greet --shout › keeps the exclamation mark" classname="test/greet.test.ts" time="0.001"/>
    <testcase name="cli › lists --shout in help" classname="test/cli.test.ts" time="0.001"/>
  </testsuite>
</testsuites>
XML
cat <<'OUT'
bun test v1.3.14
7 pass
0 fail
{"ok":true,"total":7,"failed":0,"durationMs":2450,"failures":[]}
OUT
