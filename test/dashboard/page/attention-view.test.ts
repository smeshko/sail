// Needs attention, drawn: one list across both repositories, each item a button whose data opens its run, its call
// and the inspector's tab, and an item with nothing to open drawn without the action.
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
  const markup = renderAttention(attention(index(m.registryDir))).value;
  expect(markup).toStartWith('<div class="grp-t">needs attention · 6</div>');
  expect(markup).toContain(
    `<button class="sig sig-failed" data-action="open" data-repo="alpha" data-run="${FAKE_2_ID}"><b>failed: stage_error</b><span class="w">alpha · ${FAKE_2_ID}</span><span class="p">FAKE-2 Print the version with --version</span></button>`,
  );
  expect(markup).toContain(
    `<button class="sig sig-denial" data-action="open" data-repo="alpha" data-run="${FAKE_2_ID}" data-key="implement#1" data-tab="permissions"><b>implement#1: 1 denial</b><span class="w">alpha · ${FAKE_2_ID} · implement#1</span>`,
  );
  expect(markup).toContain(
    `<button class="sig sig-suspended" data-action="open" data-repo="beta" data-run="${FAKE_3_ID}"><b>suspended: budget_exceeded</b><span class="w">beta · ${FAKE_3_ID}</span><span class="p">sail resume ${FAKE_3_ID}</span></button>`,
  );
  expect(markup).toContain(
    '<div class="sig sig-parked"><b>ticket:FAKE-6 parked after 2 attempts</b><span class="w">beta · ticket-to-pr</span>',
  );
  expect(markup.match(/data-action="open"/g)?.length).toBe(5);
});

test('an empty list says nothing needs attention', () => {
  expect(renderAttention([]).value).toBe(
    '<div class="grp-t">needs attention · 0</div>\n<div class="att-empty">nothing needs attention</div>',
  );
});
