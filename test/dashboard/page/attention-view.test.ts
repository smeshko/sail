// Needs attention, drawn: a top-bar button with the count, and, open, a pane with one list across both repositories,
// each item a button whose data opens its run, its call and the inspector's tab, and an item with nothing to open drawn
// without the action.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { index } from '../../../src/dashboard/files';
import { attention } from '../../../src/dashboard/page/attention';
import { renderAttention } from '../../../src/dashboard/page/attention-view';
import { FAKE_2_ID, FAKE_3_ID, type Machine, seedFixtures } from '../../helpers/dashboard';

let m: Machine;
beforeEach(() => {
  m = seedFixtures();
});
afterEach(() => m.remove());

test("FAKE-2's failure and denial and FAKE-3's suspension are buttons in one list whose data opens the run, the key and the tab", () => {
  const items = attention(index(m.registryDir));
  const button =
    '<button class="btn att-btn on" type="button" data-action="toggle-attention" title="needs attention (a)">⚑ needs attention<span class="badge">6</span></button>';
  const markup = renderAttention(items, true).value;
  expect(markup).toStartWith(
    `${button}<div class="att-scrim" data-action="toggle-attention"></div><div class="att-pane"><div class="rail-h"><span>needs attention</span><span class="c">6</span></div><div class="att-list">`,
  );
  expect(renderAttention(items, false).value).toBe(button.replace(' on"', '"'));
  expect(markup).toContain(
    `<button class="sig sig-failed" data-action="open" data-repo="alpha" data-run="${FAKE_2_ID}"><b>failed: stage_error</b><span class="w">alpha · ${FAKE_2_ID}</span><span class="p">FAKE-2 Print the version with --version · implement#1 ended in error: harness: the session ended before it submitted a result</span></button>`,
  );
  expect(markup).toContain(
    `<button class="sig sig-denial" data-action="open" data-repo="alpha" data-run="${FAKE_2_ID}" data-key="implement#1" data-tab="permissions"><b>1 denial</b><span class="w">alpha · ${FAKE_2_ID}</span><span class="p">implement#1: 1</span></button>`,
  );
  expect(markup).toContain(
    `<button class="sig sig-suspended" data-action="open" data-repo="beta" data-run="${FAKE_3_ID}"><b>suspended: budget_exceeded</b><span class="w">beta · ${FAKE_3_ID}</span><span class="p">stopped during implement#1: the run spent $1.06 of its $1.00 budget · sail resume ${FAKE_3_ID}</span></button>`,
  );
  expect(markup).toContain(
    '<div class="sig sig-parked"><b>ticket:FAKE-6 parked after 2 attempts</b><span class="w">beta · ticket-to-pr</span>',
  );
  expect(markup.match(/data-action="open"/g)?.length).toBe(5);
});

test('an empty list has no count on the button, and the open pane says nothing needs attention', () => {
  expect(renderAttention([], false).value).toBe(
    '<button class="btn att-btn" type="button" data-action="toggle-attention" title="needs attention (a)">⚑ needs attention</button>',
  );
  expect(renderAttention([], true).value).toContain(
    '<div class="att-list"><div class="att-empty">nothing needs attention</div></div></div>',
  );
});
