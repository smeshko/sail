// banned-words: Jev judges whether the diff's added lines (never commit messages) use CONTEXT.md's avoided words in the forbidden sense.
// The `base` binding is kept for the workflow's call but the script no longer reads it.
// Each hit reaches the review's judge as a finding; without candidates it asks Jev nothing.
// It skips a JS keyword on a code line outside its string literals and comments and a repeat of a word in one file, and counts both in `jev.skipped`.
import { file, script, value, z } from 'sail';

export const Banned = z.object({
  hits: z.array(
    z.object({ file: z.string(), line: z.number().int(), word: z.string(), term: z.string(), yes: z.number() }),
  ),
  glossary: z.object({ entries: z.number(), words: z.number() }),
  jev: z.object({
    asked: z.boolean(),
    failed: z.boolean(),
    note: z.string(),
    threshold: z.number(),
    candidates: z.number(),
    requests: z.number().int(),
    skipped: z.object({ keyword: z.number().int(), repeat: z.number().int(), oversized: z.number().int() }),
  }),
});

export const bannedWords = script('banned-words', {
  run: './run.sh',
  ports: ['jev'],
  consumes: { diff: file('diff.patch'), base: value(z.string()) },
  output: Banned,
  exitCodes: { passed: [0], failed: [] },
});
