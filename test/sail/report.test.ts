// The review workflow's report stage, run as a script on the bindings the engine lays out, with a stub `sail` that
// records each port call it is asked for. The comment it posts must fit a host's limit whatever the record holds.
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempRepo } from '../helpers/temp-repo';

interface Finding {
  id: string;
  source: string;
  severity: string;
  file: string;
  title: string;
  detail: string;
}
interface Record {
  findings: Finding[];
  judgement: { summary: string; thin: { lens: string; why: string }[]; decisions: object[] } | null;
  rounds: object[];
  resolved: boolean;
  thin: { lens: string; why: string }[];
  open: { finding: string; detail: string }[];
  nits: string[];
}

const LIMIT = 60_000;
const SUMMARY = 'The pull request holds; one leak prefix is a fixture.';
const leak = (n: number): Finding => ({
  id: `L${n}`,
  source: 'leak-check',
  severity: 'high',
  file: `keys.ts:${n}`,
  title: `A tracker key other than ADW: prefix CIR, ${n} occurrences in 1 file`,
  detail: 'x',
});
const bug = (n: number, text = 'A bug'): Finding => ({
  id: `R${n}`,
  source: 'bugs',
  severity: 'medium',
  file: `src/a.ts:${n}`,
  title: `${text} ${n}`,
  detail: 'x',
});

/** A record of `findings`, each decided as `verdict(finding)` says, with the `open` ones still open. */
function record(
  findings: Finding[],
  verdict: (finding: Finding) => string,
  open: string[] = [],
  summary = SUMMARY,
  nits: string[] = [],
): Record {
  return {
    findings,
    judgement: {
      summary,
      thin: [],
      decisions: findings.map((finding) => ({
        finding: finding.id,
        verdict: verdict(finding),
        rationale: 'Because.',
        ticket: null,
      })),
    },
    rounds: [
      {
        round: 1,
        fixed: { fixes: [], body: null },
        checked: { items: [{ finding: 'R1', resolved: true, detail: 'ok' }], findings: [] },
        validated: true,
      },
    ],
    resolved: open.length === 0,
    thin: [],
    open: open.map((finding) => ({ finding, detail: `${finding} is not fixed` })),
    nits,
  };
}

/** Runs the stage on `value`: its exit code, stdout, the files it left in `$STAGE_OUT` and the port calls it made. */
async function report(value: Record) {
  return await withTempRepo((repo) => {
    const out = join(repo.home, 'out');
    const stageIn = join(repo.home, 'in');
    mkdirSync(out);
    mkdirSync(stageIn);
    const files = {
      INPUT_RECORD: join(stageIn, 'record.json'),
      INPUT_PR: join(stageIn, 'pr.json'),
      INPUT_LABEL: join(stageIn, 'label.txt'),
    };
    writeFileSync(files.INPUT_RECORD, JSON.stringify(value));
    writeFileSync(files.INPUT_PR, JSON.stringify({ number: 7, url: 'fake://codehost/sail/pull/7' }));
    writeFileSync(files.INPUT_LABEL, 'factory\n');
    const bin = join(repo.home, 'bin');
    mkdirSync(bin);
    const calls = join(repo.home, 'calls.txt');
    writeFileSync(join(bin, 'sail'), `#!/bin/sh\necho "$*" >> '${calls}'\n`);
    chmodSync(join(bin, 'sail'), 0o755);
    const child = Bun.spawnSync([join(import.meta.dir, '../../.sail/workflows/review/stages/17-report/run.sh')], {
      cwd: repo.dir,
      env: {
        ...repo.env,
        ...files,
        PATH: `${bin}:${repo.env.PATH}`,
        SAIL_BUN: process.execPath,
        STAGE_OUT: out,
        RUN_ID: 'ADW-9-RUN',
      },
    });
    const read = (name: string) => readFileSync(join(out, name), 'utf8');
    return {
      code: child.exitCode,
      stdout: child.stdout.toString().trim(),
      stderr: child.stderr.toString(),
      full: read('REVIEW.md'),
      comment: read('COMMENT.md'),
      calls: readFileSync(calls, 'utf8').trim().split('\n'),
      out,
    };
  });
}
const size = (text: string) => Buffer.byteLength(text);

test('a report that fits is posted unchanged', async () => {
  const findings = Array.from({ length: 10 }, (_, i) => bug(i + 1));
  const result = await report(record(findings, () => 'drop'));
  expect(result.code).toBe(0);
  expect(result.comment).toBe(result.full);
  expect(result.comment).not.toContain('This report was shortened');
  expect(result.calls[0]).toBe(`port codehost comment 7 --body-file ${join(result.out, 'COMMENT.md')}`);
});

test('a report of several thousand findings is posted within the comment limit, the full one kept beside it', async () => {
  const findings = [
    ...Array.from({ length: 3990 }, (_, i) => leak(i + 1)),
    ...Array.from({ length: 10 }, (_, i) => bug(i + 1)),
  ];
  const result = await report(
    record(findings, (finding) => (finding.source === 'leak-check' ? 'drop' : 'fix'), ['R1', 'R2', 'R3']),
  );
  expect(result.code).toBe(0);
  expect(size(result.full)).toBeGreaterThan(65_536);
  for (const finding of findings) expect(result.full).toContain(`| ${finding.id} `);
  expect(size(result.comment)).toBeLessThanOrEqual(LIMIT);
  expect(result.comment).toContain('3 findings still open after 1 fix round');
  expect(result.comment).toContain(SUMMARY);
  expect(result.comment).toContain('- Round 1: 0 commits, 1/1 resolved, 0 new problems, validation passed');
  for (let n = 1; n <= 10; n++) expect(result.comment).toContain(`| R${n} A bug ${n} | bugs | medium | fix |`);
  expect(result.comment).not.toContain('| L1 ');
  for (const id of ['R1', 'R2', 'R3']) expect(result.comment).toContain(`- ${id}: ${id} is not fixed`);
  expect(result.comment).toContain('| leak-check | A tracker key other than ADW | drop | 3990 |');
  expect(result.comment).toContain(
    'This report was shortened to fit a comment: 3990 findings are collapsed to counts. The full report is `REVIEW.md` in the output of the report call of run ADW-9-RUN.',
  );
  expect(result.calls[0]).toContain(`--body-file ${join(result.out, 'COMMENT.md')}`);
});

test('a report whose kept findings alone exceed the limit is still posted within it', async () => {
  const findings = Array.from({ length: 4000 }, (_, i) => bug(i + 1, 'A bug that is described at some length'));
  const result = await report(
    record(
      findings,
      () => 'fix',
      findings.map((finding) => finding.id),
    ),
  );
  expect(result.code).toBe(0);
  expect(size(result.comment)).toBeLessThanOrEqual(LIMIT);
  expect(result.comment).toContain('4000 findings still open after 1 fix round');
  expect(result.comment).toContain('| bugs |  | fix | 4000 |');
  expect(result.comment).toContain('4000 findings open');
});

test('a judge summary of 200,000 characters is cut to fit, without splitting a character', async () => {
  const summary = '𝒮'.repeat(200_000);
  const result = await report(record([bug(1)], () => 'drop', [], summary));
  expect(result.code).toBe(0);
  const bytes = Buffer.from(result.comment);
  expect(bytes.length).toBeLessThanOrEqual(LIMIT);
  expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(result.comment);
  expect(result.comment).toContain('This report was shortened to fit a comment');
});

test('a record that is non-ASCII throughout is posted within the limit', async () => {
  const findings = Array.from({ length: 3000 }, (_, i) => bug(i + 1, '漢字のバグ'));
  const result = await report(record(findings, () => 'drop', [], '要約'.repeat(50)));
  expect(result.code).toBe(0);
  const bytes = Buffer.from(result.comment);
  expect(bytes.length).toBeLessThanOrEqual(LIMIT);
  expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(result.comment);
  expect(result.comment).toContain('| bugs |  | drop | 3000 |');
});

test('a record that is not resolved still takes the label off after the comment', async () => {
  const result = await report(record([bug(1)], () => 'fix', ['R1']));
  expect(result.code).toBe(0);
  expect(result.calls.slice(1)).toEqual([
    'port codehost remove-label 7 factory',
    'port codehost add-label 7 needs-human',
  ]);
  expect(result.stdout).toBe('{"unlabelled":true}');
});

const low = (n: number): Finding => ({ ...bug(n), severity: 'low' });

test('a mergeable record with nits says they were not fixed, and shows each with the verdict nit', async () => {
  const value = record([low(1), bug(2)], (finding) => (finding.id === 'R1' ? 'fix' : 'drop'), [], SUMMARY, ['R1']);
  value.rounds = [];
  const result = await report(value);
  expect(result.code).toBe(0);
  expect(result.comment).toBe(result.full);
  expect(result.full).toContain(
    'No finding at medium or above is left to fix, and validation passes. 1 low finding is listed as a nit, not fixed: a fix pass starts only for a finding at medium or above.',
  );
  expect(result.full).toContain('| R1 A bug 1 | bugs | low | nit | Because. |');
  expect(result.full).toContain('| R2 A bug 2 | bugs | medium | drop | Because. |');
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0]).toContain('codehost comment');
});

test('a record with no nits keeps its headline', async () => {
  const result = await report(record([bug(1)], () => 'drop'));
  expect(result.full).toContain('Every finding to fix is fixed, and validation passes.');
  expect(result.full).not.toContain('| nit |');
});

test('a shortened report counts nits under the verdict nit', async () => {
  const findings = Array.from({ length: 4000 }, (_, i) => low(i + 1));
  const result = await report(
    record(
      findings,
      () => 'fix',
      [],
      SUMMARY,
      findings.map((finding) => finding.id),
    ),
  );
  expect(result.code).toBe(0);
  expect(size(result.comment)).toBeLessThanOrEqual(LIMIT);
  expect(result.comment).toContain('| bugs |  | nit | 4000 |');
  expect(result.comment).toContain('4000 low findings are listed as nits, not fixed');
  for (const finding of findings)
    expect(result.full).toContain(`| ${finding.id} A bug ${finding.id.slice(1)} | bugs | low | nit |`);
});
