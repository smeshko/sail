// One Jev request for all findings with cited hunks; the judge owns everything unclear.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const { askNouls, triageState, triageQuestions, triageAnswers, triageVerdict, TRIAGE_YES, TRIAGE_NO, TRIAGE_CHOICE } =
  await import(join(dirname(process.env.SAIL_CONFIG), 'lib/jev-check.mjs'));
const { findings } = JSON.parse(readFileSync(process.env.INPUT_FINDINGS, 'utf8'));
const { state, asked } = triageState(findings, readFileSync(process.env.INPUT_DIFF, 'utf8'));
const reply = asked.length
  ? askNouls(triageQuestions(asked), state, process.env.STAGE_OUT)
  : { asked: false, note: 'No finding cites a hunk in the diff.' };
const answers = reply.asked ? triageAnswers(reply.answers, asked) : [];
const decided = [];
const judge = [];
for (const finding of findings) {
  const answer = answers.find((a) => a.id === finding.id);
  const verdict = triageVerdict(finding, answer);
  if (verdict)
    decided.push({
      finding: finding.id,
      verdict,
      rationale: `Jev: supported at ${answer.supported} (${answer.supported <= TRIAGE_NO ? `unsupported through ${TRIAGE_NO}` : `clear from ${TRIAGE_YES}`}), ${verdict} at ${answer.confidence} (clear from ${TRIAGE_CHOICE}).`,
    });
  else judge.push(finding.id);
}
console.log(
  JSON.stringify({
    asked: reply.asked,
    note: reply.note ?? 'Jev triaged the cited findings.',
    thresholds: { supported: TRIAGE_YES, unsupported: TRIAGE_NO, verdict: TRIAGE_CHOICE },
    answers,
    decided,
    judge,
  }),
);
