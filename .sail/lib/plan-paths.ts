// The plan check: every path a task's Files block names must lie inside the write globs implement runs with, so a plan
// that needs another path fails at plan rather than blocking implement. It reads the Files block as `jev-check.mjs`
// does (`test/sail/plan-paths.test.ts` runs both on one plan), but is TypeScript because `sail check` refuses a `.ts`
// import of an untyped `.mjs`. A copy in a field repository imports only `sail`, as this does.
import { matchesGlob, type Validator } from 'sail';

const KNOWN_EXTENSION = /\.(ts|tsx|js|mjs|json|md|yaml|yml|sh|css|html)$/;

/** The paths a Files block names: backticked tokens with a `/` or a known extension; others (`.python-version`) are not checked. */
function pathsOf(block: string): string[] {
  const paths: string[] = [];
  for (const [, token] of block.matchAll(/`([^`\s]+)`/g)) {
    const path = (token as string).replace(/:\d+(-\d+)?$/, '');
    if ((path.includes('/') || KNOWN_EXTENSION.test(path)) && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function filesBlock(lines: readonly string[]): string {
  const start = lines.findIndex((line) => /^Files:/.test(line));
  if (start === -1) return '';
  const block = [lines[start] as string];
  let i = start + 1;
  if ((lines[start] as string).replace(/^Files:/, '').trim() === '')
    while (i < lines.length && (lines[i] as string).trim() === '') i++;
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === '' || /^[A-Z][A-Za-z ]*:/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

/** Each `### TASK-nnn:` of the plan's Task details, with the paths its Files block names. */
export function taskPaths(text: string): { id: string; paths: string[] }[] {
  const start = text.search(/^## Task details\s*$/m);
  if (start === -1) return [];
  const rest = text.slice(start).replace(/^## Task details\s*\n/, '');
  const end = rest.search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const tasks: { id: string; paths: string[] }[] = [];
  for (const part of section.split(/^(?=### TASK-\d{3}\b)/m)) {
    const id = part.match(/^### (TASK-\d{3}): /m)?.[1];
    if (id !== undefined) tasks.push({ id, paths: pathsOf(filesBlock(part.split('\n'))) });
  }
  return tasks;
}

/** Fails a plan whose task names a path `globs` (implement's write globs) don't cover. */
export function implementWrites(globs: readonly string[]): Validator {
  return {
    check: 'implement-writes',
    derives: [],
    validate(document) {
      const problems = taskPaths(document.text).flatMap(({ id, paths }) =>
        paths
          .filter((path) => !matchesGlob(path, globs))
          .map(
            (path) =>
              `${id} names \`${path}\`, which implement's write globs don't cover: ask about it as an open question instead`,
          ),
      );
      return { problems };
    },
  };
}
