# Sourced first by the validate stage. On the fake workspace it plays the stage's seeded report from
# .sail/fake/scripts/<stage>.json, by $CALL, instead of running: fake agents change no code, so a real check would give
# the same result on every pass, and the loops it routes would never be driven. Everywhere else it does nothing.
sail_dir=$(cd "$(dirname "${SAIL_CONFIG:?}")" && pwd)
# The workspace is on fake written either way: `workspace: { use: fake }`, or `use: fake` on the line under `workspace:`,
# as `demo.sh new --own` writes it.
on_fake() {
  awk '/^[[:space:]]*workspace:[[:space:]]*\{[[:space:]]*use:[[:space:]]*fake/ { found = 1 }
    under && /^[[:space:]]*use:[[:space:]]*fake/ { found = 1 }
    { under = /^[[:space:]]*workspace:[[:space:]]*$/ }
    END { exit !found }' "$SAIL_CONFIG"
}
if on_fake &&
  [ -f "$sail_dir/fake/scripts/$STAGE.json" ]; then
  exec "${SAIL_BUN:-bun}" "$sail_dir/lib/play.mjs" "$sail_dir/fake/scripts/$STAGE.json"
fi
