// A run's branch (D3): `<branchPrefix><ticket key>-<slug>`, the slug ASCII, lower-case, single-dashed and at most 40
// characters cut at a dash, and the key kept as typed but for characters a branch name can't hold.
import { expect, test } from 'bun:test';
import { branchFor, DEFAULT_BRANCH_PREFIX } from '../../src/engine/branch';

test('a branch is the prefix, the ticket key and the slug of the title, ASCII, lower-case and single-dashed', () => {
  const branches = [
    ['sail/', 'FAKE-1', 'Add a --shout flag to the greet command'],
    ['sail/', 'FAKE-1', 'Café — naïve façade!!! 🚀 déjà vu'],
    [
      'sail/',
      'FAKE-1',
      'Make the greeting configurable per locale so that every supported language greets its users the way they expect it',
    ],
    ['sail/', 'FAKE-1', ''],
    ['sail/', 'FAKE-1', '!!! — ??? 🚀'],
    ['sail/', 'team/FAKE 1', 'Fix it'],
    ['feature/', 'ADW-93', 'Leases'],
  ] as const;
  expect(branches.map(([prefix, key, title]) => branchFor(prefix, key, title))).toEqual([
    'sail/FAKE-1-add-a-shout-flag-to-the-greet-command',
    'sail/FAKE-1-cafe-naive-facade-deja-vu',
    'sail/FAKE-1-make-the-greeting-configurable-per',
    'sail/FAKE-1',
    'sail/FAKE-1',
    'sail/team-FAKE-1-fix-it',
    'feature/ADW-93-leases',
  ]);
});

test("a 120-character title's slug is at most 40 characters, ends at a word, and the default prefix is sail/", () => {
  const title = `${'word '.repeat(23)}tail`;
  expect(title.length).toBe(119);
  const slug = branchFor(DEFAULT_BRANCH_PREFIX, 'FAKE-1', title).slice('sail/FAKE-1-'.length);
  expect({ prefix: DEFAULT_BRANCH_PREFIX, length: slug.length <= 40, slug }).toEqual({
    prefix: 'sail/',
    length: true,
    slug: 'word-word-word-word-word-word-word-word',
  });
});
