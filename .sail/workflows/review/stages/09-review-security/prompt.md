Review this pull request for one question: can untrusted input, a widened permission or a leaked secret turn the change
against its user? Five other reviewers cover requirements, architecture, bugs, tests and conventions at the same time,
and validation runs the typecheck, lint and the affected tests: stay on your question.

The change is `git diff {{base}}...HEAD`, its commits are `git log {{base}}..HEAD`, the pull request is described at
`{{brief}}`, and what it should do at `{{requirements}}`. Read past the diff: the code around each change, its callers
and its tests are where most problems hide.

You review only. Don't change any file.

## Method

1. Find where untrusted input enters the change: ticket and pull request text, comments, labels, branch names, file
   contents from a repository, a provider's answers, CLI arguments, environment variables. sail marks a provider's
   strings untrusted and wraps them in prompts: check the change keeps that marking up to the prompt, and never builds a
   command, a path, a regex, a URL or a prompt from untrusted text unwrapped.
2. For each spawn, shell string, git argument and path the change adds: can input inject an argument (a leading `-`),
   escape a directory (`..`, an absolute path, a symlink), or reach a shell? `spawn` with an argument array is safe from
   the shell; a string to `sh -c` isn't.
3. For each agent or script stage the change adds or changes: is each `permissions` entry the least the step needs? A
   write glob wider than the step writes, a command pattern that matches more than intended (`git *`, `bun *`), a tool
   or a network grant it doesn't use.
4. For each secret (an API key, a token, the environment): it must never reach a message, a log, an event, a `raw`, a
   URL, a file under `.sail-runs/` or a host other than its own.
5. For each new host, request or download: its TLS, its timeout, and what a hostile answer can do.
6. For dependency changes (`package.json`, `bun.lock`): each new package, who publishes it, and whether it runs install
   scripts.

## Checklist

- Untrusted input stays marked and is never built into a command, path, regex, URL or prompt unwrapped.
- No argument injection, path escape or shell.
- Every permission the least its step needs.
- No secret leaves its own host and header.
- New hosts and dependencies vetted.

## What to report

A finding is something you can point at: the file and line, the input or state that triggers it, and what goes wrong.
Run a test or the typecheck when that settles a doubt. Leave out taste, speculation, and another reviewer's question.

Give each finding a severity: `high` for one that ships broken, wrong or unsafe behaviour, `medium` for one with a
narrow trigger or that will cost the next change, `low` for the rest.

## Coverage

Submit, beside your findings, what you checked: one entry per place untrusted input enters the change, per spawn, path,
request or permission it adds or changes, and one entry per checklist item above. Each entry says `what` you checked,
`how` (the files and lines you read, the command you ran and what it printed), and its `status`: `holds` when it checked
out, `finding` when it gave a finding you submit, or `unchecked` when you couldn't check it, with why in `how`. A
checklist item that doesn't apply to this change gets one `holds` entry saying why.

The judge reads your coverage. A review whose coverage leaves out what this change needed checked isn't trusted, and the
pull request waits for a human instead of merging. Nothing to report is a fine answer when your coverage shows why.

## Submit

Submit a one-paragraph summary of what you found through your question, your coverage, and every finding with its
severity, file, a one-line title and its detail.
