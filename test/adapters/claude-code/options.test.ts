// The SDK's options for one session: the workspace, model and budgets from the request, the isolation settings, the
// envelope and contract, the tools and permission mode, the environment allowlist, and the zero-budget refusal (TASK-004).
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type SessionPlan, SUBMIT_CONTRACT, sessionOptions } from '../../../src/adapters/claude-code/options';
import type { Options } from '../../../src/adapters/claude-code/sdk';
import { MODEL, requestOf } from './helpers';

/** The options of a plan, or none when it refused the session. */
function optionsOf(plan: SessionPlan): Options {
  return 'options' in plan ? plan.options : {};
}

const STEP_SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };

test('the session options take the workspace, model and budgets from the request, with no setting sources and no partial messages', () => {
  const controller = new AbortController();
  const options = optionsOf(
    sessionOptions(requestOf({ budget: { maxTurns: 7, maxUsd: 0.5, maxMinutes: 5 } }), {
      env: {},
      abortController: controller,
    }),
  );
  expect({
    cwd: options.cwd,
    model: options.model,
    settingSources: options.settingSources,
    includePartialMessages: options.includePartialMessages,
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
  }).toEqual({
    cwd: '/work/fixture',
    model: MODEL,
    settingSources: [],
    includePartialMessages: false,
    maxTurns: 7,
    maxBudgetUsd: 0.5,
  });
  expect(options.abortController).toBe(controller);
});

test('the structured output is a json_schema envelope that holds the step schema, and the system prompt appends the submit contract', () => {
  const options = optionsOf(
    sessionOptions(requestOf({ outputSchema: STEP_SCHEMA }), { env: {}, abortController: new AbortController() }),
  );
  const schema = options.outputFormat?.schema as { oneOf?: { properties?: Record<string, unknown> }[] } | undefined;
  expect({
    type: options.outputFormat?.type,
    stepSchema: schema?.oneOf?.[0]?.properties?.output,
    systemPrompt: options.systemPrompt,
  }).toEqual({
    type: 'json_schema',
    stepSchema: STEP_SCHEMA,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SUBMIT_CONTRACT },
  });
});

test('the session runs in default permission mode with six tools allowed and no hook or permission callback, and bypassPermissions appears nowhere in the module', () => {
  const options = optionsOf(sessionOptions(requestOf(), { env: {}, abortController: new AbortController() }));
  const source = readFileSync(join(import.meta.dir, '../../../src/adapters/claude-code/options.ts'), 'utf8');
  expect({
    permissionMode: options.permissionMode,
    allowedTools: options.allowedTools,
    canUseTool: options.canUseTool,
    hooks: options.hooks,
  }).toEqual({
    permissionMode: 'default',
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    canUseTool: undefined,
    hooks: undefined,
  });
  expect(source).not.toContain('bypassPermissions');
});

test('the session environment is the allowlist of the process environment plus the request preamble, and nothing else', () => {
  const options = optionsOf(
    sessionOptions(requestOf({ env: { STAGE_IN: '/work/in', STAGE_OUT: '/work/out' } }), {
      env: {
        ANTHROPIC_API_KEY: 'sk-test',
        CLAUDE_CONFIG_DIR: '/home/someone/.claude-alt',
        SECRET_UNRELATED: 'not for the session',
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
      },
      abortController: new AbortController(),
    }),
  );
  expect(options.env).toEqual({
    ANTHROPIC_API_KEY: 'sk-test',
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    STAGE_IN: '/work/in',
    STAGE_OUT: '/work/out',
  });
});

test('a zero dollar budget is refused before any session starts, naming maxUsd, and gives no options', () => {
  const plan = sessionOptions(requestOf({ budget: { maxTurns: 5, maxUsd: 0, maxMinutes: 5 } }), {
    env: {},
    abortController: new AbortController(),
  });
  expect({
    refused: 'refused' in plan,
    reason: 'refused' in plan ? plan.refused.reason : undefined,
    names: 'refused' in plan ? plan.refused.message.includes('maxUsd') : false,
    options: 'options' in plan,
  }).toEqual({ refused: true, reason: 'budget_exceeded', names: true, options: false });
});

test('the submit contract names the done and blocked branches and says the session ends with one submission', () => {
  expect([
    /\bdone\b/.test(SUBMIT_CONTRACT),
    /\bblocked\b/.test(SUBMIT_CONTRACT),
    /one submission/i.test(SUBMIT_CONTRACT),
  ]).toEqual([true, true, true]);
});
