// `use: pi` through the CLI: preflight names the provider's key variable when it is unset, and refuses an option the
// adapter doesn't take, each with exit 3, before any session starts.
import { expect, test } from 'bun:test';
import { copyFixture, edit } from '../../helpers/fixture';
import { runCaptured } from '../../helpers/run-captured';
import { withTempRepo } from '../../helpers/temp-repo';

async function dryRun(harness: string, set: Record<string, string> = {}) {
  return withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    edit(sail, 'project.yaml', 'harness: { use: fake }', `harness: ${harness}`);
    edit(sail, 'project.yaml', 'default: claude-sonnet-5', 'default: groq/llama-3.3-70b-versatile');
    edit(sail, 'project.yaml', 'deep: claude-opus-5-5', 'deep: groq/llama-3.3-70b-versatile');
    const env = { ...repo.env };
    delete env.GROQ_API_KEY;
    Object.assign(env, set);
    const ran = await runCaptured(['FAKE-1', '--dry-run'], repo.dir, { env });
    return { code: ran.code, output: ran.stdout + ran.stderr };
  });
}

test('with provider groq and no GROQ_API_KEY, preflight exits 3 naming the variable', async () => {
  const ran = await dryRun('{ use: pi, provider: groq }');
  expect(ran.code).toBe(3);
  expect(ran.output).toContain('needs GROQ_API_KEY, which is not set');
});

test("with no provider option, preflight needs the key of the models' provider, not Anthropic's", async () => {
  const ran = await dryRun('{ use: pi }', { ANTHROPIC_API_KEY: 'sk-ant-test' });
  expect(ran.code).toBe(3);
  expect(ran.output).toContain('needs GROQ_API_KEY, which is not set');
});

test('an unknown option on the pi harness exits 3 naming it', async () => {
  const ran = await dryRun('{ use: pi, provider: ollama, bogus: true }', { GROQ_API_KEY: 'gsk-test' });
  expect(ran.code).toBe(3);
  expect(ran.output).toContain('pi harness: option bogus');
});
