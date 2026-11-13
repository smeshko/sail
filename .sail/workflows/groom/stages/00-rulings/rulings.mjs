// Reads the ticket in $INPUT_TICKET and prints the Ruled. With a `## Rulings` section and earlier open questions on
// record, asks Jev one noul per question; skip is true only when every answer is at or over RULED_YES. Jev
// unreachable, or an answer missing, is not an error: `asked` is false with a note, and the full path runs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const libDir = join(dirname(process.env.SAIL_CONFIG), 'lib');
const lib = await import(pathToFileURL(join(libDir, 'rulings.mjs')).href);
const jev = await import(pathToFileURL(join(libDir, 'jev-check.mjs')).href);

const ticket = JSON.parse(readFileSync(process.env.INPUT_TICKET, 'utf8'));
const ruled = { skip: false, asked: false, note: '', threshold: lib.RULED_YES, questions: 0, answers: [] };

const rulings = lib.rulingsOf(ticket.description);
if (rulings === '') {
  ruled.note = 'the description has no ## Rulings section';
} else {
  const questions = lib.earlierQuestions(ticket.comments);
  ruled.questions = questions.length;
  if (questions.length === 0) {
    ruled.note = 'no earlier open questions on record';
  } else {
    let failure = '';
    for (const [index, question] of questions.entries()) {
      const request = lib.guardRequest(rulings, question, index);
      const result = jev.askNouls(
        request.questions,
        request.state,
        process.env.STAGE_OUT,
        `jev-request-${index + 1}.json`,
      );
      if (!result.asked) {
        failure = result.note;
        break;
      }
      const [answer] = jev.yesses(result.answers, [request.id]);
      if (!answer) {
        failure = `Jev left ${request.id} unanswered`;
        break;
      }
      ruled.answers.push(answer);
    }
    if (failure) {
      ruled.note = failure;
    } else {
      ruled.asked = true;
      const short = ruled.answers.filter((each) => each.yes < lib.RULED_YES).map((each) => each.id);
      ruled.skip = short.length === 0;
      if (!ruled.skip) ruled.note = `${short.join(', ')} not answered by the rulings (under ${lib.RULED_YES})`;
    }
  }
}
console.log(JSON.stringify(ruled));
