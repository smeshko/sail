// runDirDiff(): the readable difference between a run directory a test generated and the one committed (11.3 D9).
// `''` means they are the same run. Otherwise it names each file one has and the other lacks, and for each file whose
// bytes differ, its first three changed hunks: the line numbers, two lines of context, and the lines of the committed
// file (`-`) and of the generated one (`+`). `run.json`'s `sail.runtime`, the Bun that generated, is compared apart.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const HUNKS = 3;
const CONTEXT = 2;
const CUT = 200;
/** The most line pairs the diff compares one by one: past it, the lines between the common ends are one change. */
const LIMIT = 4_000_000;
const RUNTIME = /"runtime": "bun \d+\.\d+\.\d+[^"]*"/;
export const GOLDEN_HINT = 'run bun run golden to regenerate it';

/** Every file under `dir`, relative to it, sorted: none when the directory isn't there. */
function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * A file's text, with the one field that names the machine's Bun put aside. `latin1` reads one character per byte, so
 * two files compare equal only when their bytes are; `utf8` is the text a diff shows.
 */
const comparable = (dir: string, file: string, encoding: 'utf8' | 'latin1' = 'utf8'): string =>
  readFileSync(join(dir, file), encoding).replace(RUNTIME, '"runtime": "bun <version>"');

type Op = { kind: ' ' | '-' | '+'; line: string; stored: number; generated: number };

/** The lines of `stored` and `generated` as a sequence of kept, removed and added lines. */
function diffLines(stored: string[], generated: string[]): Op[] {
  let head = 0;
  while (head < stored.length && head < generated.length && stored[head] === generated[head]) head++;
  let tail = 0;
  while (
    tail < stored.length - head &&
    tail < generated.length - head &&
    stored[stored.length - 1 - tail] === generated[generated.length - 1 - tail]
  ) {
    tail++;
  }
  const a = stored.slice(head, stored.length - tail);
  const b = generated.slice(head, generated.length - tail);
  const ops: Op[] = [];
  const keep = (line: string, s: number, g: number) => ops.push({ kind: ' ', line, stored: s, generated: g });
  for (let i = 0; i < head; i++) keep(stored[i] ?? '', i + 1, i + 1);

  const middle: Op[] = [];
  if (a.length * b.length > LIMIT) {
    for (const [i, line] of a.entries()) middle.push({ kind: '-', line, stored: head + i + 1, generated: head + 1 });
    for (const [j, line] of b.entries()) middle.push({ kind: '+', line, stored: head + 1, generated: head + j + 1 });
  } else {
    // The longest common subsequence of the lines between the common ends.
    const width = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i * width + j] =
          a[i] === b[j]
            ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      const same = i < a.length && j < b.length && a[i] === b[j];
      if (same) {
        middle.push({ kind: ' ', line: a[i] ?? '', stored: head + i + 1, generated: head + j + 1 });
        i++;
        j++;
      } else if (j >= b.length || (i < a.length && (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))) {
        middle.push({ kind: '-', line: a[i] ?? '', stored: head + i + 1, generated: head + j + 1 });
        i++;
      } else {
        middle.push({ kind: '+', line: b[j] ?? '', stored: head + i + 1, generated: head + j + 1 });
        j++;
      }
    }
  }
  ops.push(...middle);
  for (let k = 0; k < tail; k++) {
    const s = stored.length - tail + k;
    keep(stored[s] ?? '', s + 1, generated.length - tail + k + 1);
  }
  return ops;
}

const cut = (line: string): string => (line.length > CUT ? `${line.slice(0, CUT)}…` : line);

/** The changed hunks of `ops`, each with its context, neighbours that touch merged. */
function hunksOf(ops: Op[]): Op[][] {
  const changed = ops.flatMap((op, index) => (op.kind === ' ' ? [] : [index]));
  const hunks: [number, number][] = [];
  for (const index of changed) {
    const last = hunks.at(-1);
    if (last !== undefined && index - last[1] <= 2 * CONTEXT + 1) last[1] = index;
    else hunks.push([index, index]);
  }
  return hunks.map(([from, to]) => ops.slice(Math.max(0, from - CONTEXT), to + CONTEXT + 1));
}

/** How the generated text of `file` differs from the stored one: its first hunks, then how many more there are. */
function fileDiff(file: string, stored: string, generated: string): string[] {
  const hunks = hunksOf(diffLines(stored.split('\n'), generated.split('\n')));
  const out = [`${file} differs from the stored run (- stored, + generated):`];
  for (const hunk of hunks.slice(0, HUNKS)) {
    const first = hunk.find((op) => op.kind !== ' ') ?? (hunk[0] as Op);
    out.push(`  @@ ${file} line ${first.kind === '+' ? first.generated : first.stored} @@`);
    for (const op of hunk) out.push(`  ${op.kind} ${cut(op.line)}`);
  }
  if (hunks.length > HUNKS)
    out.push(`  (${hunks.length - HUNKS} more ${hunks.length - HUNKS === 1 ? 'hunk' : 'hunks'} not shown)`);
  return out;
}

/**
 * Every way the stored run directory differs from the generated one, as text to read in a failing test; empty when
 * there is none.
 */
export function runDirDiff(generated: string, stored: string): string {
  const [made, kept] = [filesIn(generated), filesIn(stored)];
  const lines = [
    ...kept.filter((file) => !made.includes(file)).map((file) => `${file} is missing from the generated run`),
    ...made.filter((file) => !kept.includes(file)).map((file) => `${file} is not in the stored run`),
  ];
  for (const file of made.filter((name) => kept.includes(name))) {
    if (comparable(generated, file, 'latin1') === comparable(stored, file, 'latin1')) continue;
    const [after, before] = [comparable(generated, file), comparable(stored, file)];
    if (after !== before) lines.push(...fileDiff(file, before, after));
    else lines.push(`${file} differs from the stored run in bytes that are not UTF-8 text`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n${GOLDEN_HINT}`;
}
