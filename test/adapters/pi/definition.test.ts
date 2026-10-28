// The pi adapter's definition: what preflight asks of the environment per provider, the one option it takes, the
// version it reports, and its place among the built-ins.
import { expect, test } from 'bun:test';
import { BUILTINS } from '../../../src/adapters';
import { PI_VERSION, piAdapters, requires } from '../../../src/adapters/pi/index';
import { caught } from '../../helpers/ports';

test('requires() names the provider’s key variable, one of two for anthropic, and nothing for a keyless provider', () => {
  expect({
    default: requires({}, {}),
    groq: requires({ provider: 'groq' }, {}),
    anthropic: requires({ provider: 'anthropic' }, {}),
    ollama: requires({ provider: 'ollama' }, {}),
    ollamaWithBogus: requires({ provider: 'ollama', bogus: true }, {}),
  }).toEqual({
    default: [['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN']],
    groq: ['GROQ_API_KEY'],
    anthropic: [['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN']],
    ollama: [],
    ollamaWithBogus: [],
  });
});

test('an unknown option is refused naming it, and a provider that is not a string is refused', () => {
  const create = (options: Record<string, unknown>) => () => piAdapters.harness.create(options, { env: {} } as never);
  expect(String(caught(create({ bogus: true })))).toContain('pi harness: option bogus');
  expect(String(caught(create({ provider: 3 })))).toContain('pi harness: option provider');
});

test('a provider option makes a harness named pi', async () => {
  const harness = await piAdapters.harness.create({ provider: 'groq' }, { env: {} } as never);
  expect(harness.name).toBe('pi');
});

test('versions() is the exact version package.json pins', async () => {
  const pinned = (await Bun.file('package.json').json()).dependencies['@mariozechner/pi-coding-agent'];
  expect({ pinned, versions: piAdapters.harness.versions?.() }).toEqual({
    pinned: PI_VERSION,
    versions: { '@mariozechner/pi-coding-agent': PI_VERSION },
  });
});

test('the built-ins hold pi’s harness', () => {
  expect(BUILTINS.pi?.harness).toBe(piAdapters.harness);
});
