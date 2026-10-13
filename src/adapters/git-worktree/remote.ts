// The name leases are keyed by for a clone: origin's URL with any user and password removed, so every clone of one
// repository names it the same way, and a credential never reaches a lease file or an event (ADR-0018).

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PortError } from '../../ports/errors';
import { git } from './git';

/** The URL with `scheme://user:password@` reduced to `scheme://`. Other forms (such as `git@host:path`) pass as they are. */
export function stripCredentials(url: string): string {
  return url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, '$1');
}

/**
 * A local origin (a path, which git also accepts as a remote) is keyed by its `file://` URL, so the key is never a bare
 * path, the way every other key is a URL. Schemed URLs and `user@host:path` forms pass as they are.
 */
function keyOf(url: string, clone: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) || /^[^/]+@[^/]+:/.test(url)) return url;
  return pathToFileURL(resolve(clone, url)).href;
}

/** Origin's URL for the clone at `clone`, credentials removed. Throws `invalid` when the clone has no origin. */
export async function remoteKeyOf(clone: string, env?: Readonly<Record<string, string>>): Promise<string> {
  const got = await git(clone, ['remote', 'get-url', 'origin'], env);
  if (got.code !== 0) {
    throw new PortError('workspace', 'remoteKey', 'invalid', `${clone} has no origin remote: ${got.stderr}`, got);
  }
  return keyOf(stripCredentials(got.stdout.trim()), clone);
}
