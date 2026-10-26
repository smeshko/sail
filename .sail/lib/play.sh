# Sourced first by the validate stage. On the fake workspace it plays the stage's seeded report from
# .sail/fake/scripts/<stage>.json, by $CALL, instead of running: fake agents change no code, so a real check would give
# the same result on every pass, and the loops it routes would never be driven. Everywhere else it does nothing.
sail_dir=$(cd "$(dirname "${SAIL_CONFIG:?}")" && pwd)
if grep -Eq '^[[:space:]]*workspace:[[:space:]]*\{[[:space:]]*use:[[:space:]]*fake' "$SAIL_CONFIG" &&
  [ -f "$sail_dir/fake/scripts/$STAGE.json" ]; then
  exec "${SAIL_BUN:-bun}" "$sail_dir/lib/play.mjs" "$sail_dir/fake/scripts/$STAGE.json"
fi
