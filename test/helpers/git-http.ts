// serveGitHttp(): a bare repository served over git's smart HTTP on 127.0.0.1, through `git http-backend` as a CGI
// program under Bun.serve, behind Basic auth. It answers 401 with `WWW-Authenticate: Basic` until the right credential
// comes, as a host does, so git asks its credential helpers. Each request is recorded with whether it carried an
// `Authorization` header and whether that matched: the header's value is never kept.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface GitHttpRequest {
  readonly method: string;
  /** The path and query, such as `/repo.git/info/refs?service=git-receive-pack`. */
  readonly path: string;
  readonly authorization: 'none' | 'matched' | 'wrong';
}

export interface GitHttp {
  /** The bare repository's URL, such as `http://127.0.0.1:<port>/origin.git`. */
  readonly url: string;
  /** The server's own URL, `http://127.0.0.1:<port>`: what a credential helper is scoped to. */
  readonly base: string;
  readonly requests: GitHttpRequest[];
  stop(): void;
}

export interface GitHttpOptions {
  /** The bare repository's path. It is served under its folder name. */
  readonly bare: string;
  readonly user: string;
  readonly password: string;
  /** The environment `git http-backend` runs in. */
  readonly env: Readonly<Record<string, string>>;
}

/** Where this machine's git keeps `git-http-backend`, or a thrown error naming where it looked. */
export function httpBackend(env: Readonly<Record<string, string>>): string {
  const execPath = Bun.spawnSync(['git', '--exec-path'], { env, stdin: 'ignore' }).stdout.toString().trim();
  const backend = join(execPath, 'git-http-backend');
  if (!existsSync(backend)) throw new Error(`git-http-backend is not at ${backend}: git's smart HTTP can't be served`);
  return backend;
}

/** Splits a CGI answer into its status, headers and body. */
function cgiResponse(output: Uint8Array): Response {
  const bytes = Buffer.from(output);
  const crlf = bytes.indexOf('\r\n\r\n');
  const lf = bytes.indexOf('\n\n');
  const [end, gap] = crlf !== -1 && (lf === -1 || crlf < lf) ? [crlf, 4] : [lf, 2];
  if (end === -1)
    return new Response(`git http-backend gave no headers: ${bytes.toString().slice(0, 200)}`, { status: 502 });
  const headers = new Headers();
  let status = 200;
  for (const line of bytes.subarray(0, end).toString().split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
    else headers.append(name, value);
  }
  return new Response(bytes.subarray(end + gap), { status, headers });
}

export function serveGitHttp(options: GitHttpOptions): GitHttp {
  const backend = httpBackend(options.env);
  const root = join(options.bare, '..');
  const name = options.bare.split('/').at(-1) ?? '';
  const expected = `Basic ${Buffer.from(`${options.user}:${options.password}`).toString('base64')}`;
  const requests: GitHttpRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const header = request.headers.get('authorization');
      const authorization = header === null ? 'none' : header === expected ? 'matched' : 'wrong';
      requests.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization });
      if (authorization !== 'matched') {
        return new Response('authentication required\n', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="sail-test"' },
        });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      const cgi = Bun.spawn([backend], {
        env: {
          ...options.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          REQUEST_METHOD: request.method,
          QUERY_STRING: url.search.replace(/^\?/, ''),
          CONTENT_TYPE: request.headers.get('content-type') ?? '',
          CONTENT_LENGTH: String(body.length),
          HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
          REMOTE_USER: options.user,
          REMOTE_ADDR: '127.0.0.1',
        },
        stdin: body,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [output] = await Promise.all([new Response(cgi.stdout).bytes(), cgi.exited]);
      return cgiResponse(output);
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { url: `${base}/${name}`, base, requests, stop: () => server.stop(true) };
}
