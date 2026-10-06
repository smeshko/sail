// Run-level type cases: what run.stage(), run.loop() and workflow() refuse, and what must compile.
// test/types/expect-error.test.ts proves that each directive's line fails with the code it names. Cases import only
// from `sail` and `sail/intakes`, because the harness checks a copy of this file in a temp directory.
import { agent, file, fromStep, gitDiff, script, stage, type Untrusted, untrusted, value, workflow, z } from 'sail';
import { TicketInput, ticket } from 'sail/intakes';

/** Marks a value as read, so a case can be one expression. */
declare function read(...values: unknown[]): void;

const prompt = './prompt.md';
const permissions = { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] };
const budget = { maxTurns: 10, maxUsd: 1, maxMinutes: 5 };

const SpecOutput = z.object({ summary: z.string() });
const TestReport = z.object({ ok: z.boolean(), failed: z.number() });
const Findings = z.object({ findings: z.array(z.string()) });
const Feedback = z.union([TestReport, Findings]);
const PrInfo = z.object({ url: z.string() });
/** A schema whose input and output differ: it parses a string into its length. */
const Length = z.string().transform((text) => text.length);

const spec = agent('spec', {
  prompt,
  consumes: { brief: file('brief.md') },
  produces: { 'spec.md': 'file' },
  output: SpecOutput,
  permissions,
  budget,
});
const implement = agent('implement', {
  prompt,
  consumes: { spec: file('spec.md'), feedback: value(Feedback).optional() },
  produces: { 'diff.patch': 'file' },
  output: z.object({ notes: z.string() }),
  permissions,
  budget,
});
const tests = script('tests', { run: './run.sh', produces: { 'junit.xml': 'file' }, output: TestReport });
const review = agent('review', {
  prompt,
  consumes: { spec: file('spec.md'), diff: gitDiff('origin/main...HEAD') },
  output: Findings,
  permissions,
  budget,
});
const Quote = z.object({ text: untrusted() });
const quote = script('quote', { run: './quote.sh', consumes: { quote: value(Quote) }, output: TestReport });
const measure = script('measure', { run: './measure.sh', consumes: { text: value(Length) }, output: TestReport });
const publish = stage('publish', {
  consumes: { ticket: value(TicketInput), spec: file('spec.md') },
  output: PrInfo,
  steps: [
    agent('describe', { prompt, produces: { 'pr-body.md': 'file' }, output: SpecOutput, permissions, budget }),
    script('open', { run: './open.sh', consumes: { description: fromStep('describe').output() }, output: PrInfo }),
  ],
});

export const compiles = workflow('compiles', { intake: ticket }, async (run) => {
  const key: string = run.input.ticketKey;
  const s = await run.stage(spec, { brief: run.intake.files['brief.md'] });
  if (s.outcome === 'blocked') return run.fail(`spec blocked on ${key}: ${s.reason}`);
  read(s.output.summary, s.files['spec.md']);

  for (const iteration of run.loop('fix', { max: 3, feedback: Feedback })) {
    const impl = await run.stage(implement, { spec: s.files['spec.md'], feedback: iteration.previous });
    if (impl.outcome === 'blocked') return run.fail(impl.reason);
    read(impl.output.notes, impl.files['diff.patch']);
    const t = await run.stage(tests);
    if (t.outcome === 'failed') {
      iteration.fail(t.output);
      continue;
    }
    const r = await run.stage(review, { spec: s.files['spec.md'] });
    if (r.outcome === 'blocked') return run.fail(r.reason);
    if (r.output.findings.length === 0) break;
    iteration.fail({ findings: r.output.findings });
  }

  await run.stage(implement, { spec: s.files['spec.md'] });
  await run.stage(tests, {});
  for (const iteration of run.loop('settle', { max: 2 })) {
    const previous: undefined = iteration.previous;
    read(previous);
    iteration.fail();
  }

  // A value binding takes what its schema parses, and a loop's feedback goes in raw and comes back parsed.
  await run.stage(measure, { text: 'abc' });
  // An untrusted() field is still a string to read, and a workflow supplies a plain string for it.
  const shown: string = run.input.title;
  read(shown);
  await run.stage(quote, { quote: { text: 'plain text' } });
  // The ticket's labels, links and attachments reach the workflow, and each provider string is still a string to read.
  const label: string | undefined = run.input.labels[0];
  const link: { url: string; title?: string | undefined } | undefined = run.input.links[0];
  const attachment: { name: string; url: string; mimeType?: string | undefined } | undefined = run.input.attachments[0];
  read(label, link, attachment);
  for (const iteration of run.loop('measure', { max: 2, feedback: Length })) {
    const previous: number | undefined = iteration.previous;
    read(previous);
    iteration.fail('abc');
  }

  // { onError: 'return' } hands an error back to the workflow, which rules it out before reading the output.
  const checked = await run.stage(tests, {}, { onError: 'return' });
  if (checked.outcome === 'error') return run.fail(checked.reason);
  read(checked.output.failed);
  const redone = await run.stage(implement, { spec: s.files['spec.md'] }, { onError: 'return' });
  const ended: 'done' | 'blocked' | 'error' = redone.outcome;
  read(ended);

  const p = await run.stage(publish, { ticket: run.input, spec: s.files['spec.md'] });
  const settled: 'passed' | 'failed' = p.outcome;
  read(settled, p.files['pr-body.md']);
  return p.output.url;
});

export const refuses = workflow('refuses', { intake: ticket }, async (run) => {
  const s = await run.stage(spec, { brief: run.intake.files['brief.md'] });
  const t = await run.stage(tests);
  const i = await run.stage(implement, { spec: run.intake.files['brief.md'] });

  // @ts-expect-error TS2739: a typed value where a file() is declared
  await run.stage(spec, { brief: run.input });
  // @ts-expect-error TS2741: the required binding `brief` is left out
  await run.stage(spec, {});
  // @ts-expect-error TS2554: the required binding `brief` is left out, with the bindings
  await run.stage(spec);
  // @ts-expect-error TS2740: a produced file where a value() is declared
  await run.stage(publish, { ticket: t.files['junit.xml'], spec: run.intake.files['brief.md'] });
  // @ts-expect-error TS2353: the engine resolves gitDiff(), so the workflow can't pass it
  await run.stage(review, { spec: run.intake.files['brief.md'], diff: run.intake.files['brief.md'] });
  // @ts-expect-error TS2353: spec declares no binding named `ticket`
  await run.stage(spec, { brief: run.intake.files['brief.md'], ticket: run.intake.files['ticket.json'] });
  // @ts-expect-error TS2353: tests declares no bindings at all
  await run.stage(tests, { brief: run.intake.files['brief.md'] });

  // @ts-expect-error TS2367: a script ends passed or failed, never done
  read(t.outcome === 'done');
  // @ts-expect-error TS2367: an agent ends done or blocked, never passed
  read(s.outcome === 'passed');
  // @ts-expect-error TS7053: tests produces no review.md
  read(t.files['review.md']);
  // @ts-expect-error TS2339: an agent's output can't be read until blocked is ruled out
  read(i.output);
  // @ts-expect-error TS2339: a script result has no reason
  read(t.reason);
  // @ts-expect-error TS2367: without { onError: 'return' }, an error never reaches the workflow
  read(t.outcome === 'error');

  // @ts-expect-error TS2322: onError takes only 'return'
  await run.stage(tests, {}, { onError: 'ignore' });
  // @ts-expect-error TS2741: the required binding `brief` is left out, with the options
  await run.stage(spec, {}, { onError: 'return' });
  const e = await run.stage(tests, {}, { onError: 'return' });
  // @ts-expect-error TS2339: the output can't be read until error is ruled out
  read(e.output);

  if (s.outcome === 'blocked') return run.fail(s.reason);
  // @ts-expect-error TS2339: SpecOutput has no title
  read(s.output.title);

  for (const iteration of run.loop('fix', { max: 3, feedback: Feedback })) {
    // @ts-expect-error TS2353: the feedback is a test report or findings
    iteration.fail({ reason: 'flaky' });
  }

  // @ts-expect-error TS2322: a plain string is not Untrusted until its schema parses it
  const forged: Untrusted = 'plain text';
  read(forged);
  // @ts-expect-error TS2339: the ticket has no id: its key is what every port operation takes
  read(run.input.id);
  // @ts-expect-error TS2345: an intake is no stage: the engine runs it before any workflow code
  await run.stage(ticket);
  // @ts-expect-error TS2322: Length parses a string, so a number is what it parses to, not what it takes
  await run.stage(measure, { text: 3 });
  for (const iteration of run.loop('measure', { max: 2, feedback: Length })) {
    // @ts-expect-error TS2345: the feedback goes in as Length's input, a string
    iteration.fail(3);
  }
  return undefined;
});

// @ts-expect-error TS2345: a watched workflow must bound its concurrent runs
workflow('unbounded', { intake: ticket, watch: { every: '5m' } }, async () => undefined);
// @ts-expect-error TS2322: a watch interval is a number and s, m or h
workflow('vague', { intake: ticket, watch: { every: '5 min' }, maxConcurrentRuns: 1 }, async () => undefined);
// @ts-expect-error TS2322: a misspelt option is an error, not an unwatched workflow
workflow('misspelt', { intake: ticket, wacth: { every: '5m' } }, async () => undefined);
