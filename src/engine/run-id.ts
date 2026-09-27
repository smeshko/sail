// Run ids: `<key>-<ulid>`. The ULID's time comes first, so run directories sort by when they started.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TIME = 2 ** 48 - 1;

/** 26 characters of Crockford base32: 10 for the millisecond time, then 16 for 80 random bits. */
export function ulid(
  now: number = Date.now(),
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) throw new Error(`ULID time out of range: ${now}`);
  let time = '';
  for (let rest = now, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32] + time;
  let bits = 0n;
  for (const byte of random(new Uint8Array(10))) bits = (bits << 8n) | BigInt(byte);
  let randomPart = '';
  for (let i = 0; i < 16; i++, bits >>= 5n) randomPart = CROCKFORD[Number(bits & 31n)] + randomPart;
  return time + randomPart;
}

/** `<key>-<ulid>`. The key is a ticket key such as `FAKE-1`, or a stage name for an isolated stage run. */
export function newRunId(key: string, now?: number): string {
  if (!/^[A-Za-z0-9-]+$/.test(key)) throw new Error(`a run id key is letters, digits and dashes: '${key}'`);
  return `${key}-${ulid(now)}`;
}
