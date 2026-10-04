import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FRAGMENTS, readFragment, renderPrompt } from '../../src/engine/prompt';
import { RenderError } from '../../src/engine/render';
import { markUntrusted } from '../../src/engine/untrusted';
import { TicketInput } from '../../src/sdk/intakes';
import { withTempRepo } from '../helpers/temp-repo';

const root = join(import.meta.dir, '..', '..');
const fixtures = join(root, 'test', 'fixtures');
/** The fixture repository's `.sail/`, which shadows no fragment. */
const fixtureSailDir = join(fixtures, 'repo', '.sail');
const UNTRUSTED_HEADING = '## About untrusted input';
const FINISH_HEADING = '## Finishing';

/** Writes `text` at `path`, creating its directories. */
function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** Calls `fn`, which must throw a RenderError, and hands the error back. */
function renderError(fn: () => unknown): RenderError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RenderError);
  return caught as RenderError;
}

test('with no shadowing file readFragment gives each built-in, with no variable in it', () => {
  const [about, finish] = FRAGMENTS.map((name) => readFragment(fixtureSailDir, name));
  expect(FRAGMENTS).toEqual(['untrusted-input', 'finish']);
  expect(about?.origin).toBe('builtin');
  expect(about?.text).toStartWith(UNTRUSTED_HEADING);
  expect(finish?.origin).toBe('builtin');
  expect(finish?.text).toStartWith(FINISH_HEADING);
  expect(`${about?.text}${finish?.text}`).not.toContain('{{');
});

test('a repository file shadows one fragment, and the other stays the built-in', async () => {
  await withTempRepo((repo) => {
    const sailDir = join(repo.dir, '.sail');
    write(join(sailDir, 'prompts', '_shared', 'finish.md'), 'Submit for {{ticket.ticketKey}}.\n');
    const finish = readFragment(sailDir, 'finish');
    expect(finish).toEqual({
      name: 'finish',
      text: 'Submit for {{ticket.ticketKey}}.\n',
      origin: 'repo:.sail/prompts/_shared/finish.md',
    });
    expect(readFragment(sailDir, 'untrusted-input').origin).toBe('builtin');
  });
});

test('renderPrompt ends a prompt with the untrusted-input fragment and the finish fragment', () => {
  const sailDir = fixtureSailDir;
  const file = join(fixtures, 'repo', '.sail', 'stages', 'implement', 'prompt.md');
  const prompt = readFileSync(file, 'utf8');
  const rendered = renderPrompt({ sailDir, file, values: {} });
  const pattern = new RegExp(
    `^${prompt.trimEnd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\n${UNTRUSTED_HEADING}\\n[\\s\\S]*[^\\n]\\n\\n${FINISH_HEADING}\\n[\\s\\S]*[^\\n]\\n$`,
  );
  expect(rendered.text).toMatch(pattern);
  expect(rendered.fragments).toEqual([
    { name: 'untrusted-input', origin: 'builtin' },
    { name: 'finish', origin: 'builtin' },
  ]);
  expect(rendered.untrusted).toBe(0);
});

test('a shadowing finish fragment has its variables filled', async () => {
  await withTempRepo((repo) => {
    const sailDir = join(repo.dir, '.sail');
    write(join(sailDir, 'prompts', '_shared', 'finish.md'), 'Submit for {{ticket.ticketKey}}.\n');
    const file = write(join(sailDir, 'stages', 'spec', 'prompt.md'), 'Write the spec.\n');
    const rendered = renderPrompt({ sailDir, file, values: { ticket: { ticketKey: 'FAKE-9' } } });
    expect(rendered.text).toEndWith('\n\nSubmit for FAKE-9.\n');
    expect(rendered.fragments[1]).toEqual({ name: 'finish', origin: 'repo:.sail/prompts/_shared/finish.md' });
  });
});

test('a render error names the file it is in and the line within that file', async () => {
  await withTempRepo((repo) => {
    const sailDir = join(repo.dir, '.sail');
    const file = write(join(sailDir, 'stages', 'spec', 'prompt.md'), 'Intro\n\nKey: {{ticket.keey}}\n');
    const inPrompt = renderError(() => renderPrompt({ sailDir, file, values: { ticket: { ticketKey: 'FAKE-9' } } }));
    expect(inPrompt.message).toContain('.sail/stages/spec/prompt.md');
    expect(inPrompt.line).toBe(3);
    expect(inPrompt.path).toBe('ticket.keey');

    write(file, 'Fine.\n');
    write(join(sailDir, 'prompts', '_shared', 'finish.md'), 'Done.\nSubmit for {{ticket.nope}}.\n');
    const inFragment = renderError(() => renderPrompt({ sailDir, file, values: { ticket: { ticketKey: 'FAKE-9' } } }));
    expect(inFragment.message).toContain('.sail/prompts/_shared/finish.md');
    expect(inFragment.line).toBe(2);
    expect(inFragment.path).toBe('ticket.nope');
  });
});

test('an unclosed block in a prompt is an error in the prompt, though a fragment closes it', async () => {
  await withTempRepo((repo) => {
    const sailDir = join(repo.dir, '.sail');
    write(join(sailDir, 'prompts', '_shared', 'finish.md'), '{{/if}}\n');
    const file = write(join(sailDir, 'stages', 'spec', 'prompt.md'), 'Intro\n{{#if x}}\nBody\n');
    const error = renderError(() => renderPrompt({ sailDir, file, values: { x: true } }));
    expect(error.message).toContain('.sail/stages/spec/prompt.md');
    expect(error.line).toBe(2);
  });
});

test('an empty shadowing file adds nothing, and one blank line still separates the parts that remain', async () => {
  await withTempRepo((repo) => {
    const sailDir = join(repo.dir, '.sail');
    write(join(sailDir, 'prompts', '_shared', 'finish.md'), '');
    const file = write(join(sailDir, 'stages', 'spec', 'prompt.md'), 'Write the spec.\n');
    const rendered = renderPrompt({ sailDir, file, values: {} });
    expect(rendered.text).toMatch(new RegExp(`^Write the spec\\.\\n\\n${UNTRUSTED_HEADING}\\n[\\s\\S]*[^\\n]\\n$`));
    expect(rendered.text).not.toContain(FINISH_HEADING);
    expect(rendered.fragments).toHaveLength(2);
  });
});

test('a prompt file that does not exist is an error naming the file', () => {
  const file = join(fixtures, 'repo', '.sail', 'stages', 'nowhere', 'prompt.md');
  expect(() => renderPrompt({ sailDir: fixtureSailDir, file, values: {} })).toThrow(file);
});

test('the spec prompt rendered with the fixture ticket equals the golden prompt', () => {
  const dir = join(fixtures, 'render');
  const ticket = TicketInput.parse(JSON.parse(readFileSync(join(dir, 'ticket.json'), 'utf8')));
  const values = {
    ticket: markUntrusted(TicketInput, ticket, 'ticket'),
    in: { brief: 'brief.md', ticket: 'ticket.json' },
    out: { spec: 'spec.md' },
    feedback: null,
  };
  const rendered = renderPrompt({ sailDir: fixtureSailDir, file: join(dir, 'spec-prompt.md'), values });
  expect(rendered.text).toBe(readFileSync(join(dir, 'spec-prompt.expected.md'), 'utf8'));
  expect(rendered.untrusted).toBe(3);
});
