// The dashboard page at `GET /`: one self-contained document. Nothing is built ahead of time. On the first request,
// `Bun.build` bundles the page's modules in memory, from a virtual entry that boots the shell on the real window, and
// the bundle is inlined into `page/index.html`'s one script element. Its sha256 is the only script the page's CSP
// admits, so no inline handler, injected script or other origin can run, and `default-src 'none'` leaves the page
// nowhere to send anything but its own server.
//
// A failed build answers 500 and isn't kept: the next request builds again, and `/api` and `/ws` are unaffected.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BunPlugin } from 'bun';

export interface PageOptions {
  /** Where `index.html`, `app.ts` and `host.ts` are: `page/` beside this module unless a test says otherwise. */
  dir?: string;
}

export interface Page {
  /** The page for a request whose validated `Host` is `host`. */
  response(host: string): Promise<Response>;
}

const ENTRY = 'sail-dashboard:entry';
const NAMESPACE = 'sail-dashboard';
export const PLACEHOLDER = '<script type="module" id="sail-page"></script>';

interface Built {
  html: string;
  hash: string;
}

/**
 * The bundle made safe inside a script element: neither `</script`, in any case, nor `<!--` may appear. Each `<` of them
 * becomes `\x3C`, which means the same in a string, a template and a regular expression, and nothing in a comment. The
 * HTML tokenizer ends a script at `</SCRIPT` too, so the match ignores case (review R1-6).
 */
export function inlineScript(bundle: string): string {
  return bundle.replace(/<(\/script|!--)/gi, (_, rest: string) => `\\x3C${rest}`);
}

async function build(dir: string): Promise<Built> {
  const template = readFileSync(join(dir, 'index.html'), 'utf8');
  if (!template.includes(PLACEHOLDER)) throw new Error(`index.html has no ${PLACEHOLDER}`);
  const entry = [
    `import { boot } from ${JSON.stringify(join(dir, 'app'))};`,
    `import { browserHost } from ${JSON.stringify(join(dir, 'host'))};`,
    'boot(browserHost(window));',
  ].join('\n');
  const plugin: BunPlugin = {
    name: NAMESPACE,
    setup(builder) {
      builder.onResolve({ filter: /^sail-dashboard:entry$/ }, () => ({ path: 'entry', namespace: NAMESPACE }));
      builder.onLoad({ filter: /.*/, namespace: NAMESPACE }, () => ({ contents: entry, loader: 'ts' }));
    },
  };
  const output = await Bun.build({ entrypoints: [ENTRY], target: 'browser', format: 'esm', plugins: [plugin] });
  const [bundle] = output.outputs;
  if (!output.success || bundle === undefined) throw new Error(output.logs.map(String).join('; ') || 'no output');
  const script = inlineScript(await bundle.text());
  const hash = createHash('sha256').update(script).digest('base64');
  // A function, not a string: a replacement string would read the bundle's `$$` and `$&` as patterns.
  const html = template.replace(PLACEHOLDER, () => `<script type="module" id="sail-page">${script}</script>`);
  return { html, hash };
}

/** The page's headers, its CSP admitting only the inlined script and the dashboard's own origins. */
export function pageHeaders(host: string, hash: string): Record<string, string> {
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    `connect-src http://${host} ws://${host}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The page, built once on first use. A build that fails is tried again on the next request. */
export function createPage(options: PageOptions = {}): Page {
  const dir = options.dir ?? join(import.meta.dir, 'page');
  let built: Promise<Built> | undefined;
  return {
    async response(host) {
      built ??= build(dir);
      try {
        const { html, hash } = await built;
        return new Response(html, { headers: pageHeaders(host, hash) });
      } catch (error) {
        built = undefined;
        return Response.json({ error: `the dashboard page could not be built: ${messageOf(error)}` }, { status: 500 });
      }
    },
  };
}
