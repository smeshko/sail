# Sourced by Claude Code's shell before each Bash command (the session's CLAUDE_ENV_FILE). That shell is a login shell,
# whose profile may reorder PATH (macOS's path_helper puts /usr/bin ahead of what sail put first), so the folder of
# sail's shims, which SAIL_SHIMS names, is put first again. Sourcing it twice changes nothing. It prints nothing.
if [ -n "${SAIL_SHIMS:-}" ]; then
  case "$PATH" in
    "$SAIL_SHIMS":*) ;;
    *) PATH="$SAIL_SHIMS:$PATH" ;;
  esac
  export PATH
fi
