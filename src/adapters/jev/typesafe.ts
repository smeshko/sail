// The typesafe Jev: TypeSafe's System One API over plain `fetch`. One POST per ask carries the state and the questions;
// the answer holds one typed answer per question. Every failure becomes a PortError that keeps TypeSafe's own detail,
// and the API key, which goes in the request's header alone, is masked wherever a message or a `raw` could hold it. The
// key is sent only to https://api.typesafe.ai or a loopback host, whatever SAIL_TYPESAFE_API_URL says.
import { z } from 'zod';
import { redactor } from '../../engine/redact';
import type { ProviderEmit } from '../../events/types';
import type { AdapterDefinition } from '../../ports/adapter';
import { PortError } from '../../ports/errors';
import type { Jev } from '../../ports/jev';
import { JevAnswer, type JevAnswered, type JevCapabilities, JevRequest, type JevUsage } from '../../ports/types';
import { jevError } from './status';

export const TYPESAFE_API_URL = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-latest';

/** The part of `fetch` the adapter calls: a test injects its own. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface TypesafeJevOptions {
  readonly apiKey: string;
  readonly apiUrl?: string;
  /** The model that answers when a request names none. `jev-latest` when left out. */
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetch?: Fetch;
  readonly emit?: ProviderEmit;
  readonly now?: () => Date;
}

const Reply = z.object({
  model: z.string(),
  answers: z.record(z.string(), JevAnswer),
  usage: z
    .object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() })
    .optional(),
});

/** TypeSafe's own words for a failure: a 400's `detail`, a 422's messages with where they apply, or the body as it came. */
function detailOf(body: unknown, text: string): string {
  const detail = typeof body === 'object' && body !== null ? (body as { detail?: unknown }).detail : undefined;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const lines = detail.map((entry) => {
      const { loc, msg } = (entry ?? {}) as { loc?: unknown; msg?: unknown };
      const where = Array.isArray(loc) ? loc.join('.') : '';
      const what = typeof msg === 'string' ? msg : JSON.stringify(entry);
      return where === '' ? what : `${where}: ${what}`;
    });
    if (lines.length > 0) return lines.join('; ');
  }
  return text === '' ? 'no detail' : text;
}

/** Whether a WHATWG hostname is `localhost`, an address in 127.0.0.0/8 or `[::1]`. */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * The base URL for `value`, without a trailing `/`, once it is `https://api.typesafe.ai` or an http(s) URL on a loopback
 * host: the only places the TypeSafe key may go. Anything else throws, naming SAIL_TYPESAFE_API_URL.
 */
export function typesafeEndpoint(value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  const shown = url === undefined ? value : `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  const refuse = () =>
    new Error(
      `SAIL_TYPESAFE_API_URL is ${shown}: the TypeSafe key goes only to ${TYPESAFE_API_URL} or to http on a loopback host (localhost, 127.0.0.0/8, ::1)`,
    );
  if (url === undefined || url.username !== '' || url.password !== '') throw refuse();
  if (url.origin === TYPESAFE_API_URL) {
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') throw refuse();
    return TYPESAFE_API_URL;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLoopback(url.hostname)) throw refuse();
  return value.replace(/\/+$/, '');
}

export function createTypesafeJev(options: TypesafeJevOptions): Jev {
  const base = typesafeEndpoint(options.apiUrl ?? TYPESAFE_API_URL);
  const host = new URL(base).host;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? (() => new Date());
  const mask = redactor([options.apiKey]);

  /** The PortError for a failure of the transport, before the answer or while its body is read. */
  const transport = (error: unknown, failed: string): PortError => {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    const message = timedOut
      ? `TypeSafe at ${host} did not answer within ${timeoutMs} ms`
      : `${failed}: ${error instanceof Error ? error.message : String(error)}`;
    return new PortError('jev', 'ask', 'unavailable', message);
  };
  const invalid = (message: string, raw?: unknown) => new PortError('jev', 'ask', 'invalid', message, raw);

  async function send(input: JevRequest): Promise<JevAnswered> {
    const parsed = JevRequest.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw invalid(`the request breaks its shape at ${issue?.path.join('.') || '/'}: ${issue?.message}`);
    }
    const request = parsed.data;
    const model = request.model ?? options.model ?? DEFAULT_MODEL;
    const started = now().getTime();
    let response: Response;
    let text: string;
    try {
      response = await (options.fetch ?? fetch)(`${base}/v1/systemone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, state: request.state, questions: request.questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw transport(error, `TypeSafe is unreachable at ${host}`);
    }
    try {
      text = await response.text();
    } catch (error) {
      throw transport(error, `the answer from TypeSafe at ${host} broke off`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!response.ok) throw jevError(response.status, detailOf(body, text), body);
    const reply = Reply.safeParse(body);
    if (!reply.success) {
      const issue = reply.error.issues[0];
      throw typeof body === 'object' && body !== null
        ? invalid(`TypeSafe's answer breaks its shape at ${issue?.path.join('.') || '/'}: ${issue?.message}`, body)
        : invalid(`TypeSafe answered ${response.status} with no JSON answer: ${text}`);
    }
    for (const [name, question] of Object.entries(request.questions)) {
      const answer = reply.data.answers[name];
      if (answer === undefined) throw invalid(`TypeSafe's answer has nothing for the question '${name}'`, body);
      if (answer.type !== question.type) {
        throw invalid(`TypeSafe answered the ${question.type} question '${name}' with a ${answer.type}`, body);
      }
    }
    const usage: JevUsage | undefined =
      reply.data.usage === undefined
        ? undefined
        : { inputTokens: reply.data.usage.input_tokens, outputTokens: reply.data.usage.output_tokens };
    const latencyMs = Math.max(0, now().getTime() - started);
    const answered: JevAnswered = {
      // An empty model names none, and the event needs one: the model asked answered.
      model: reply.data.model === '' ? model : reply.data.model,
      answers: reply.data.answers,
      ...(usage === undefined ? {} : { usage }),
      latencyMs,
    };
    options.emit?.({
      type: 'jev:asked',
      model: answered.model,
      questions: Object.keys(request.questions).length,
      latencyMs,
      ...(usage === undefined ? {} : { usage }),
    });
    return answered;
  }

  return {
    name: 'typesafe',
    async ask(request) {
      try {
        return await send(request);
      } catch (error) {
        throw mask.error(error);
      }
    },
    capabilities(): JevCapabilities {
      return { questionTypes: ['choice', 'score', 'noul'] };
    },
  };
}

const TypesafeOptions = z
  .object({
    model: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

/**
 * The `typesafe` adapter for the jev port. Its API key is read from the operator's `TYPESAFE_API_KEY`, its endpoint from
 * `SAIL_TYPESAFE_API_URL` (never the config), which may name only https://api.typesafe.ai or a loopback host.
 */
export const typesafeJev: AdapterDefinition<Jev> = {
  requires: () => ['TYPESAFE_API_KEY'],
  create(options, context) {
    const parsed = TypesafeOptions.safeParse(options);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const option = issue?.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue?.path.join('.');
      const hint =
        issue?.code === 'unrecognized_keys' && issue.keys.includes('apiUrl')
          ? ': the endpoint comes from SAIL_TYPESAFE_API_URL'
          : '';
      throw new Error(`typesafe jev: option ${option}: ${issue?.message}${hint}`);
    }
    return createTypesafeJev({
      apiKey: context.env.TYPESAFE_API_KEY ?? '',
      ...(parsed.data.model === undefined ? {} : { model: parsed.data.model }),
      apiUrl: context.env.SAIL_TYPESAFE_API_URL || TYPESAFE_API_URL,
      ...(parsed.data.timeoutMs === undefined ? {} : { timeoutMs: parsed.data.timeoutMs }),
      ...(context.emit === undefined ? {} : { emit: context.emit }),
      ...(context.now === undefined ? {} : { now: context.now }),
    });
  },
};
