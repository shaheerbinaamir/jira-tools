// Thin client over the documented Bitbucket Cloud REST API (2.0).
//
// The only network destination is api.bitbucket.org, and only when a
// workspace + API token have been configured in Options.

export class ApiError extends Error {
  constructor(message, { status = 0, path = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

const BASE = 'https://api.bitbucket.org/2.0';

// Bitbucket Cloud enforces a per-token request-rate budget that a multi-repo
// scan can burn through quickly. Space requests out and back off on 429
// instead of hammering it and losing whatever a repo's request was for.
const MIN_INTERVAL_MS = 300; // ~3 req/s ceiling, shared across every call this client makes
const MAX_RETRIES = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BitbucketClient {
  /** @param {{email: string, apiToken: string}} auth Scoped Atlassian API token, not the deprecated app password. */
  constructor(auth) {
    this.auth = auth || {};
    this._lastRequestAt = 0;
  }

  async _throttle() {
    const wait = MIN_INTERVAL_MS - (Date.now() - this._lastRequestAt);
    if (wait > 0) await sleep(wait);
    this._lastRequestAt = Date.now();
  }

  async request(pathOrUrl, { params, signal } = {}) {
    const url = pathOrUrl.startsWith('http') ? new URL(pathOrUrl) : new URL(BASE + pathOrUrl);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const headers = { Accept: 'application/json' };
    if (this.auth.email && this.auth.apiToken) {
      headers.Authorization = `Basic ${btoa(`${this.auth.email}:${this.auth.apiToken}`)}`;
    }

    for (let attempt = 0; ; attempt++) {
      await this._throttle();

      let res;
      try {
        res = await fetch(url, { method: 'GET', headers, signal, cache: 'no-store', credentials: 'omit' });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw new ApiError('Could not reach api.bitbucket.org.', { path: String(pathOrUrl) });
      }

      if (res.status === 401 || res.status === 403) {
        throw new ApiError(
          `Bitbucket rejected your credentials (HTTP ${res.status}). Check the email and API token in Options, and that the token has the Bitbucket repository-read scope.`,
          { status: res.status, path: String(pathOrUrl) },
        );
      }

      if (res.status === 429) {
        if (attempt >= MAX_RETRIES) {
          throw new ApiError('Bitbucket kept rate-limiting requests after several retries. Try again later, or scan fewer repos.', {
            status: 429, path: String(pathOrUrl),
          });
        }
        const retryAfterHeader = Number(res.headers.get('retry-after'));
        const backoffMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : Math.min(30_000, 1000 * 2 ** attempt);
        await sleep(backoffMs);
        continue;
      }

      if (!res.ok) {
        throw new ApiError(`Bitbucket returned HTTP ${res.status} for ${pathOrUrl}.`, {
          status: res.status, path: String(pathOrUrl),
        });
      }
      return res.json();
    }
  }

  /** Resolve the authenticated user, mainly for a reliable UUID to match commit authorship against. */
  async whoAmI(signal) {
    const me = await this.request('/user', { signal });
    return { uuid: me.uuid, username: me.username, displayName: me.display_name };
  }

  /**
   * Resolve any other Bitbucket account by username, for viewing their commit
   * graph. Returns null (not thrown) when the account doesn't exist or its
   * username lookup is hidden by that person's privacy settings — callers
   * fall back to matching commits by name/email text in that case.
   */
  async resolveUser(username, { signal } = {}) {
    try {
      const user = await this.request(`/users/${encodeURIComponent(username)}`, { signal });
      return { uuid: user.uuid, username: user.username, displayName: user.display_name };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 401 || err.status === 403)) return null;
      throw err;
    }
  }

  /** All repo slugs in a workspace, newest-updated first. */
  async listWorkspaceRepos(workspace, { signal } = {}) {
    const slugs = [];
    let next = `${BASE}/repositories/${encodeURIComponent(workspace)}`;
    let params = { pagelen: 100, fields: 'values.slug,values.mainbranch.name,next', sort: '-updated_on' };
    while (next) {
      const data = await this.request(next, { params, signal });
      params = undefined; // `next` already carries the query string
      for (const repo of data.values || []) {
        slugs.push({ slug: repo.slug, mainBranch: repo.mainbranch?.name || null });
      }
      next = data.next || null;
    }
    return slugs;
  }

  /**
   * Commits on a repo's default branch, newest first. Stops paginating as soon
   * as a page's oldest commit falls before `sinceMs` — callers still need to
   * filter the last page's stragglers themselves.
   */
  async listRecentCommits(workspace, slug, { sinceMs, signal } = {}) {
    const commits = [];
    let next = `${BASE}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/commits`;
    let params = {
      pagelen: 100,
      // Requesting the raw/nickname/display_name fields too lets callers match
      // commits by an author whose username lookup is hidden by their privacy
      // settings, not just by uuid.
      fields: 'values.hash,values.date,values.author.raw,values.author.user.uuid,'
        + 'values.author.user.nickname,values.author.user.display_name,next',
    };
    while (next) {
      const data = await this.request(next, { params, signal });
      params = undefined;
      const page = data.values || [];
      for (const c of page) commits.push(c);
      const oldest = page[page.length - 1];
      if (!oldest || new Date(oldest.date).getTime() < sinceMs) break;
      next = data.next || null;
    }
    return commits.filter((c) => new Date(c.date).getTime() >= sinceMs);
  }
}

/** Run `worker` over `items` with bounded concurrency. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { __error: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
