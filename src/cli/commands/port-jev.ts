// `sail port jev`: the Jev port's one operation, as `sail port` runs it. Its answers are judgments about a state, so a
// script step reads them as typed JSON and branches on them.
//
//   ask [--model <id>] [--body-file <path>]
//
// The body, from the file or stdin, is a JSON object in the shape of a JevRequest:
//
//   { "state": <text, or any JSON>,
//     "questions": { "<name>": { "type": "choice", "instructions": <text>, "criteria": { "<option>": <text> } },
//                    "<name>": { "type": "score",  "instructions": <text>, "criteria": [<text>, …] },
//                    "<name>": { "type": "noul",   "instructions": <text>, "criteria": { "true": <text>, "false": <text> } } },
//     "model": <id, optional> }
//
// and the one line printed is the JevAnswered: `{ model, answers: { "<name>": { type, … } }, usage?, latencyMs }`, a
// choice answered by `choice`, a score by `score` and a noul by `noul`, each with Jev's confidence and probabilities
// where it gave them. `--model` overrides the body's. A body that is no JSON, or breaks the shape, is refused before
// Jev is asked, so a script pays for no call that could not be answered.
import type { Jev } from '../../ports/jev';
import { JevRequest } from '../../ports/types';
import type { PortTable } from './port';

export const JEV: PortTable<'jev'> = {
  port: 'jev',
  operations: {
    ask: {
      positionals: [],
      options: { model: { value: 'id', filled: true }, 'body-file': { value: 'path' } },
      body: true,
      async run(jev: Jev, { values, body }) {
        const text = await body();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch (error) {
          return { refused: `jev ask needs a JSON body: ${(error as Error).message}` };
        }
        const parsed = JevRequest.safeParse(data);
        if (!parsed.success) {
          const [issue] = parsed.error.issues;
          return { refused: `jev ask body breaks its shape at ${issue?.path.join('.') || '/'}: ${issue?.message}` };
        }
        const model = typeof values.model === 'string' ? values.model : parsed.data.model;
        return { value: await jev.ask({ ...parsed.data, ...(model === undefined ? {} : { model }) }) };
      },
    },
  },
};
