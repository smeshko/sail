// The dashboard page at `GET /`: one self-contained document. Nothing is built ahead of time. On the first request,
// `Bun.build` bundles the page's modules in memory, from a virtual entry that boots the shell on the real window, and
// the bundle is inlined into `page/index.html`'s one script element. Its sha256 is the only script the page's CSP
// admits, so no inline handler, injected script or other origin can run, and `default-src 'none'` leaves the page
// nowhere to send anything but its own server.
//
// A failed build answers 500 and isn't kept: the next request builds again, and `/api` and `/ws` are unaffected.
//
// Stub (TASK-009): no page yet.

export interface PageOptions {
  /** Where `index.html`, `app.ts` and `host.ts` are: `page/` beside this module unless a test says otherwise. */
  dir?: string;
}

export interface Page {
  /** The page for a request whose validated `Host` is `host`. */
  response(host: string): Promise<Response>;
}

export const PLACEHOLDER = '<script type="module" id="sail-page"></script>';

/**
 * The bundle made safe inside a script element: neither `</script` nor `<!--` may appear. Each `<` of them becomes
 * `\x3C`, which means the same in a string, a template and a regular expression, and nothing in a comment.
 */
export function inlineScript(bundle: string): string {
  return bundle;
}

/** The page's headers, its CSP admitting only the inlined script and the dashboard's own origins. */
export function pageHeaders(_host: string, _hash: string): Record<string, string> {
  return {};
}

/** The page, built once on first use. A build that fails is tried again on the next request. */
export function createPage(_options: PageOptions = {}): Page {
  return { response: async () => new Response('', { status: 404 }) };
}
