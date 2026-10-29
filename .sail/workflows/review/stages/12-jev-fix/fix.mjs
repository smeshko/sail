// Asks Jev one noul per finding in $INPUT_FINDINGS, about the fixes in $INPUT_FIXED and the diff since $INPUT_SINCE, and
// prints the FixAsked. Jev unreachable, or an answer missing, is not an error: `checked` is null with a note, and
// check-fix runs as it would without Jev.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = await import(pathToFileURL(join(dirname(process.env.SAIL_CONFIG), 'lib', 'jev-check.mjs')).href);

const { findings } = JSON.parse(readFileSync(process.env.INPUT_FINDINGS, 'utf8'));
const fixed = JSON.parse(readFileSync(process.env.INPUT_FIXED, 'utf8'));
const since = readFileSync(process.env.INPUT_SINCE, 'utf8').trim();
const asked = { asked: false, note: '', threshold: lib.CLEAR_YES, answers: [], checked: null };

if (findings.length === 0) {
  asked.note = 'no finding is targeted';
} else {
  const result = lib.askNouls(lib.fixQuestions(findings), lib.fixState(findings, fixed, since), process.env.STAGE_OUT);
  if (!result.asked) {
    asked.note = result.note;
  } else {
    const ids = findings.map((finding) => finding.id);
    asked.asked = true;
    asked.answers = lib.yesses(result.answers, ids);
    if (asked.answers.length < ids.length) asked.note = 'Jev left a finding unanswered';
    else if (lib.clearYes(result.answers, ids)) {
      asked.checked = {
        items: asked.answers.map((each) => ({
          finding: each.id,
          resolved: true,
          detail: `Jev answers yes at ${each.yes} (clear from ${lib.CLEAR_YES}).`,
        })),
        findings: [],
      };
    } else asked.note = `not every finding is a clear yes (from ${lib.CLEAR_YES})`;
  }
}
console.log(JSON.stringify(asked));
