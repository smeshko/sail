// The page at `GET /` (D2, D4): one self-contained document, `index.html` with the page's modules bundled in-process
// and inlined into its one script element, whose sha256 is the only script the CSP admits. A build that fails answers
// 500 and is tried again on the next request.
import { afterAll, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPage, inlineScript } from '../../src/dashboard/page';

const HOST = '127.0.0.1:4100';
const PAGE_DIR = join(import.meta.dir, '..', '..', 'src', 'dashboard', 'page');
const temp = mkdtempSync(join(tmpdir(), 'sail-page-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const built = createPage().response(HOST);
/** The served document's one inline script, or undefined. */
const scriptOf = (html: string) => /<script type="module" id="sail-page">([\s\S]*)<\/script>/.exec(html)?.[1];

test('the page builds into one document with exactly one script, inline, holding no import, export, raw </script or <!--', async () => {
  const response = await built;
  const html = await response.clone().text();
  expect([response.status, response.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8']);
  expect(html).toStartWith('<!doctype html>');
  expect(html.match(/<script\b/g)).toEqual(['<script']);
  const script = scriptOf(html) ?? '';
  expect(script.length).toBeGreaterThan(10_000);
  expect(script).toContain('X-Sail-Dashboard');
  expect(script).not.toMatch(/^\s*(import|export)\s/m);
  expect([script.includes('</script'), script.includes('<!--')]).toEqual([false, false]);
  for (const region of ['rail', 'attention', 'queues', 'main', 'inspector', 'status']) {
    expect(html).toContain(`id="${region}"`);
  }
});

test('nothing in the page points outside it: no src, no href, and no @import or url() in its style', async () => {
  const html = await (await built).clone().text();
  const style = /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? '';
  expect(style.length).toBeGreaterThan(1000);
  expect(html.replace(/<script[\s\S]*<\/script>/, '').match(/\s(src|href)=/g)).toBeNull();
  expect(style.match(/@import|url\(/g)).toBeNull();
});

test("the CSP admits the inlined script by its sha256 and the dashboard's own origins, beside D4's other headers", async () => {
  const response = await built;
  const script = scriptOf(await response.clone().text()) ?? '';
  const hash = new Bun.CryptoHasher('sha256').update(script).digest('base64');
  expect(Object.fromEntries(response.headers)).toEqual({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src http://${HOST} ws://${HOST}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
});

test('inlineScript makes </script and <!-- inert where they stand, and leaves the rest of the bundle as it is', () => {
  const bundle = 'const a = "</script><!--"; const b = `$$&$1`; /<!--x/u.test(c);';
  expect(inlineScript(bundle)).toBe('const a = "\\x3C/script>\\x3C!--"; const b = `$$&$1`; /\\x3C!--x/u.test(c);');
  // The escape means the same in a string and a unicode regular expression.
  expect(new Function(`return ${inlineScript('"</script<!--"')}`)()).toBe('</script<!--');
  expect(new Function(`return ${inlineScript('/<!--/u')}`)().test('<!--')).toBe(true);
});

test('a page whose build fails answers 500 naming why, and builds on the next request once it can', async () => {
  const dir = join(temp, 'page');
  cpSync(PAGE_DIR, dir, { recursive: true });
  rmSync(join(dir, 'index.html'), { force: true });
  const page = createPage({ dir });
  const failed = await page.response(HOST);
  expect([failed.status, failed.headers.get('content-type')]).toEqual([500, 'application/json;charset=utf-8']);
  expect(((await failed.json()) as { error: string }).error).toStartWith('the dashboard page could not be built: ');
  cpSync(join(PAGE_DIR, 'index.html'), join(dir, 'index.html'));
  const recovered = await page.response(HOST);
  expect(recovered.status).toBe(200);
  expect(scriptOf(await recovered.text())).toContain('X-Sail-Dashboard');
}, 30_000);
