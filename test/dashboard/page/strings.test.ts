// What the page drops from the prototype (D15): its project's labels, its controls' hard-coded targets and its frozen
// clock. No file of the page and no built page may hold any of them, in any case.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPage } from '../../../src/dashboard/page';

const PAGE = join(import.meta.dir, '..', '..', '..', 'src', 'dashboard', 'page');
const BANNED = [/sunrise/i, /aws-hackaton/i, /\bmaster\b/i, /14:02:11/, /azure/i, /ADO-/i];

const found = (text: string) => BANNED.filter((pattern) => pattern.test(text)).map(String);

test('no file of the page and no built page holds a string the prototype is dropped for', async () => {
  const files = readdirSync(PAGE);
  expect(files).toEqual(expect.arrayContaining(['index.html', 'app.ts', 'html.ts']));
  expect(
    files.flatMap((file) => found(readFileSync(join(PAGE, file), 'utf8')).map((hit) => `${file}: ${hit}`)),
  ).toEqual([]);
  const response = await createPage().response('127.0.0.1:4100');
  const built = await response.text();
  expect([response.status, built.includes('<script type="module" id="sail-page">')]).toEqual([200, true]);
  expect(found(built)).toEqual([]);
  expect(found('a Sunrise board, pushed to Master at 14:02:11 in Azure for ado-17263')).toHaveLength(5);
}, 30_000);
