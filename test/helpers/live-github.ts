// What the live tests against GitHub itself share: a REST request with the token, outside the adapter, for the setup a
// case needs and the cleanup after it, and the deletion of a branch the case pushed. Only the live tests import it, and
// each runs behind its own switch. It holds no secret: the token is passed in, and every error is redacted of it.
import { redactor } from '../../src/engine/redact';

const API = 'https://api.github.com';

/** GitHub's answer to `method path`, parsed, or null for an empty one. A status that isn't 2xx throws, redacted. */
export async function liveFetch(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const redact = redactor([token]);
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sail-live-tests',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(redact.text(`GitHub ${response.status} on ${method} ${path}: ${text.slice(0, 300)}`));
  return text === '' ? null : JSON.parse(text);
}

/** Deletes `branch` of `repository` (`owner/name`), and says whether it was there to delete. */
export async function deleteBranch(token: string, repository: string, branch: string): Promise<boolean> {
  try {
    await liveFetch(token, 'DELETE', `/repos/${repository}/git/refs/heads/${branch}`);
    return true;
  } catch (error) {
    if (String(error).includes('GitHub 422') || String(error).includes('GitHub 404')) return false;
    throw error;
  }
}

/** Closes each of `numbers` that is still open, and deletes its head branch. Answers what it closed. */
export async function closePullRequests(token: string, repository: string, numbers: readonly number[]) {
  const closed: number[] = [];
  for (const number of numbers) {
    const pr = (await liveFetch(token, 'GET', `/repos/${repository}/pulls/${number}`)) as {
      state: string;
      head: { ref: string };
    };
    if (pr.state === 'open') {
      await liveFetch(token, 'PATCH', `/repos/${repository}/pulls/${number}`, { state: 'closed' });
      closed.push(number);
    }
    await deleteBranch(token, repository, pr.head.ref);
  }
  return closed;
}
