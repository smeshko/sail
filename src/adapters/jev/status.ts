// How a TypeSafe answer status becomes a port error code, shared by the real adapter and the fake so both fail alike.
import { PortError, type PortErrorCode } from '../../ports/errors';

const REASONS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const CODES: Readonly<Record<number, PortErrorCode>> = {
  400: 'invalid',
  422: 'invalid',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
};

/** The PortError for a TypeSafe answer of `status`: its message always carries the status and the provider's detail. */
export function jevError(status: number, detail: string, raw?: unknown): PortError {
  const reason = REASONS[status];
  const answered = reason === undefined ? `${status}` : `${status} ${reason}`;
  return new PortError('jev', 'ask', CODES[status] ?? 'unavailable', `TypeSafe answered ${answered}: ${detail}`, raw);
}
