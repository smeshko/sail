// Reads Bun's test output, a gate's or a CI job's, for review's validate and merge stages: the tests that failed with
// their files, the errors printed above them, and the Bun version. A CI job log has an Actions timestamp and may have
// colour on every line, which `lines` strips, so a gate's own output reads the same as before.

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** `text`'s lines without a leading Actions timestamp or ANSI colour. */
function lines(text) {
  return text.split('\n').map((line) => line.replace(ANSI, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ''));
}

/** The Bun version `bun test v<version>` printed in `text`, or undefined. */
export function bunVersion(text) {
  return /bun test v(\S+)/.exec(text)?.[1];
}

/**
 * Each test that failed in the gate's log, once, with the file whose header Bun printed last above it: Bun prints a
 * file's name before each run of its results, and every failure again, without it, in its closing summary. A failure
 * before any header is left out, unless `unfiled`, which keeps it with no file.
 */
export function failingTests(text, { unfiled = false } = {}) {
  const found = new Map();
  let file;
  for (const line of lines(text)) {
    const header = /^(test\/\S+\.test\.ts):$/.exec(line);
    if (header) file = header[1];
    if (!line.startsWith('(fail) ') || (file === undefined && !unfiled)) continue;
    const test = line.slice('(fail) '.length).replace(/ \[[\d.]+m?s\]$/, '');
    if (!found.has(test)) found.set(test, { test, file });
  }
  return [...found.values()];
}

/**
 * Each failing test with the error lines Bun printed above it, then the counts: what the implementer needs, which the
 * plain tail leaves out. Undefined when no test failed, as when typecheck or lint stopped the gate.
 */
export function failures(text) {
  const all = lines(text);
  const blocks = new Map();
  let from = 0;
  all.forEach((line, at) => {
    if (/^\((pass|skip)\)/.test(line)) from = at + 1;
    if (!line.startsWith('(fail)')) return;
    // Bun prints each failure again in its closing summary, without the error above it.
    const name = line.replace(/ \[[\d.]+m?s\]$/, '');
    if (!blocks.has(name)) blocks.set(name, all.slice(Math.max(from, at - 20), at).join('\n'));
    from = at + 1;
  });
  if (blocks.size === 0) return undefined;
  let errors = '';
  for (const [name, block] of blocks) {
    if (errors.length + block.length > 5000) break;
    errors += `${block}\n${name}\n\n`;
  }
  const counts = all.filter((line) => /^ \d+ (pass|skip|fail)$|^Ran \d+ tests/.test(line)).join('\n');
  return [
    `${blocks.size} failing test${blocks.size === 1 ? '' : 's'}:`,
    [...blocks.keys()].join('\n'),
    'The first ones, with their errors:',
    errors.trimEnd(),
    counts,
  ].join('\n\n');
}
