// banned-words: Jev judges whether added lines and commit messages use CONTEXT.md's avoided words in the forbidden sense.
// Each hit reaches the review's judge as a finding; without candidates it asks Jev nothing.
import { file, script, value, z } from 'sail';

export const Banned = z.object({
  hits: z.array(
    z.object({ file: z.string(), line: z.number().int(), word: z.string(), term: z.string(), yes: z.number() }),
  ),
  glossary: z.object({ entries: z.number(), words: z.number() }),
  jev: z.object({ asked: z.boolean(), note: z.string(), threshold: z.number(), candidates: z.number() }),
});

export const bannedWords = script('banned-words', {
  run: './run.sh',
  ports: ['jev'],
  consumes: { diff: file('diff.patch'), base: value(z.string()) },
  output: Banned,
  exitCodes: { passed: [0], failed: [] },
});
