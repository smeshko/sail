// Proves the pending tests in $INPUT_WRITTEN, in the workspace:
//   1. with their stickers, typecheck and lint pass, and each test runs as skipped;
//   2. with every sticker of their files stripped, each test fails on an assertion, never a crash.
// The stripped files are restored however the run ends. Writes red.txt, grouped by task, and prints the Proof.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filesWithStickers, strip, tail } from '../../../../lib/stickers.mjs';

const root = process.cwd();
const bun = process.env.SAIL_BUN ?? 'bun';
const out = process.env.STAGE_OUT;
const { cases } = JSON.parse(readFileSync(process.env.INPUT_WRITTEN, 'utf8'));
const files = [...new Set(cases.map((each) => each.file))];
const problems = [];
const red = [];

const run = (args) => {
  const result = spawnSync(bun, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const log = `${result.stdout}${result.stderr}`;
  process.stderr.write(`$ bun ${args.join(' ')}\n${log}\n`);
  return { code: result.status, log };
};

const decode = (text) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');
const attribute = (tag, name) => {
  const found = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return found === null ? undefined : decode(found[1]);
};

/** Each test case of a junit report: its file, its name, and how it ended. */
const testcases = (path) =>
  [...readFileSync(path, 'utf8').matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)].map((each) => {
    const body = each[3] ?? '';
    const failure = body.match(/<failure\b[^>]*>/)?.[0];
    return {
      file: attribute(each[1], 'file') ?? '',
      name: attribute(each[1], 'name') ?? '',
      skipped: /<skipped\b/.test(body),
      failure:
        failure === undefined
          ? undefined
          : { type: attribute(failure, 'type'), message: attribute(failure, 'message') },
    };
  });

/**
 * The runs of a case: the tests of its file named exactly as written, or else those its `.each` title matches, `%s` and
 * `$field` matching anything. A title never claims a test that another case names exactly.
 */
const matcher = (name) =>
  new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%[sdifjop#%]|\\\$[\w.]+/g, '.*')}$`);
const runsOf = (each, report) => {
  const inFile = report.filter((run) => run.file === each.file);
  const exact = inFile.filter((run) => run.name === each.name);
  if (exact.length > 0) return exact;
  const named = new Set(cases.filter((other) => other.file === each.file).map((other) => other.name));
  return inFile.filter((run) => !named.has(run.name) && matcher(each.name).test(run.name));
};

const testRun = (report) => run(['run', 'test', ...files, '--reporter=junit', `--reporter-outfile=${report}`]);

if (cases.length === 0) problems.push('no pending test was submitted');
for (const path of filesWithStickers(root)) {
  if (!files.includes(path)) problems.push(`${path} holds stickers but no submitted case names it`);
}

// 1. With the stickers: everything builds, and every case is skipped.
for (const check of ['typecheck', 'lint']) {
  const { code, log } = run(['run', check]);
  if (code !== 0) problems.push(`bun run ${check} fails with the stickers in place:\n${tail(log, 40)}`);
}
const pendingReport = join(out, 'pending.xml');
const pending = testRun(pendingReport);
if (pending.code !== 0) problems.push(`the tests fail with the stickers in place:\n${tail(pending.log, 40)}`);
else {
  const report = testcases(pendingReport);
  for (const each of cases) {
    const runs = runsOf(each, report);
    if (runs.length === 0) problems.push(`${each.file}: no test runs as '${each.name}'`);
    else if (runs.some((run) => !run.skipped)) problems.push(`${each.file}: '${each.name}' runs despite its sticker`);
  }
}

// 2. Without them: every case fails on an assertion. The files are restored whatever happens.
if (problems.length === 0) {
  const saved = new Map(files.map((path) => [path, readFileSync(join(root, path), 'utf8')]));
  try {
    strip(root, files);
    const redReport = join(out, 'red.xml');
    testRun(redReport);
    const report = testcases(redReport);
    for (const each of cases) {
      const runs = runsOf(each, report);
      if (runs.length === 0) problems.push(`${each.file}: '${each.name}' doesn't run once its sticker is stripped`);
      for (const run of runs) {
        if (run.failure === undefined) problems.push(`${each.file}: '${run.name}' passes against the stubs`);
        else if (run.failure.type !== 'AssertionError') {
          problems.push(`${each.file}: '${run.name}' crashes (${run.failure.type}: ${run.failure.message}), not red`);
        } else red.push({ task: each.task, file: each.file, name: run.name, message: run.failure.message ?? '' });
      }
    }
  } finally {
    for (const [path, text] of saved) writeFileSync(join(root, path), text);
  }
}

const byTask = Map.groupBy(red, (each) => each.task);
const lines = [...byTask]
  .sort(([a], [b]) => a.localeCompare(b))
  .flatMap(([task, failures]) => [
    task,
    ...failures.map((each) => `  ${each.file} › ${each.name}\n    ${each.message.trim().replace(/\n+/g, '\n    ')}`),
    '',
  ]);
writeFileSync(join(out, 'red.txt'), lines.join('\n'));
console.log(JSON.stringify({ ok: problems.length === 0, problems, red }));
process.exit(problems.length === 0 ? 0 : 1);
