// The fake Jev: answers from a committed seed, or with a default per question type, and fails with a seeded HTTP status.
// It changes nothing, so it keeps no state beside the seed.
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ProviderEmit } from '../../events/types';
import { PortError } from '../../ports/errors';
import type { Jev } from '../../ports/jev';
import {
  JevAnswer,
  type JevAnswered,
  type JevCapabilities,
  type JevQuestion,
  JevRequest,
  JevUsage,
} from '../../ports/types';
import { jevError } from '../jev/status';

export interface FakeJevOptions {
  /** The committed seed: answers by question name, a usage, a model, or an error status. A missing file is an empty seed. */
  readonly seed: string;
  /** The model that answers when neither the request nor the seed names one. `jev-latest` when left out. */
  readonly model?: string;
  readonly emit?: ProviderEmit;
  readonly now?: () => Date;
}

const Seed = z.object({
  model: z.string().min(1).optional(),
  usage: JevUsage.optional(),
  answers: z.record(z.string(), JevAnswer).optional(),
  error: z.object({ status: z.number().int(), detail: z.string() }).optional(),
});
type Seed = z.infer<typeof Seed>;

const invalid = (message: string) => new PortError('jev', 'ask', 'invalid', message);

function readSeed(path: string): Seed {
  if (!existsSync(path)) return {};
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw invalid(`the seed ${path} is no JSON: ${(error as Error).message}`);
  }
  const parsed = Seed.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(`the seed ${path} breaks its shape at ${issue?.path.join('.') || '/'}: ${issue?.message}`);
  }
  return parsed.data;
}

/** What the fake answers a question with when the seed holds nothing for it. */
function defaultAnswer(question: JevQuestion): JevAnswer {
  switch (question.type) {
    case 'choice': {
      const options = Object.keys(question.criteria);
      return {
        type: 'choice',
        choice: options[0] as string,
        confidence: 1,
        probabilities: Object.fromEntries(options.map((option, i) => [option, i === 0 ? 1 : 0])),
      };
    }
    case 'score':
      return { type: 'score', score: 0, confidence: 1 };
    case 'noul':
      return { type: 'noul', noul: 1 };
  }
}

/** The seeded answer when it fits the question, else the PortError that says how it doesn't. */
function checked(name: string, question: JevQuestion, answer: JevAnswer): JevAnswer {
  if (answer.type !== question.type) {
    throw invalid(`the seed answers '${name}' with a ${answer.type}, but the question is a ${question.type}`);
  }
  if (answer.type === 'choice' && question.type === 'choice' && !Object.hasOwn(question.criteria, answer.choice)) {
    throw invalid(`the seed answers '${name}' with '${answer.choice}', which is no option of the question`);
  }
  return answer;
}

export function createFakeJev(options: FakeJevOptions): Jev {
  const now = options.now ?? (() => new Date());
  return {
    name: 'fake',
    async ask(input: JevRequest): Promise<JevAnswered> {
      const started = now().getTime();
      const parsed = JevRequest.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw invalid(`the request breaks its shape at ${issue?.path.join('.') || '/'}: ${issue?.message}`);
      }
      const request = parsed.data;
      const seed = readSeed(options.seed);
      if (seed.error !== undefined) throw jevError(seed.error.status, seed.error.detail);
      const answers: Record<string, JevAnswer> = {};
      for (const [name, question] of Object.entries(request.questions)) {
        const seeded = seed.answers?.[name];
        answers[name] = seeded === undefined ? defaultAnswer(question) : checked(name, question, seeded);
      }
      const model = request.model ?? seed.model ?? options.model ?? 'jev-latest';
      const latencyMs = Math.max(0, now().getTime() - started);
      options.emit?.({
        type: 'jev:asked',
        model,
        questions: Object.keys(answers).length,
        latencyMs,
        ...(seed.usage === undefined ? {} : { usage: seed.usage }),
      });
      return { model, answers, ...(seed.usage === undefined ? {} : { usage: seed.usage }), latencyMs };
    },
    capabilities(): JevCapabilities {
      return { questionTypes: ['choice', 'score', 'noul'] };
    },
  };
}
