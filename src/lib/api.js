// Thin client over the documented Atlassian Cloud REST APIs.
//
// Every request goes to an origin the user explicitly configured. There is no
// other network destination anywhere in this extension.

export class ApiError extends Error {
  constructor(message, { status = 0, origin = '', path = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.origin = origin;
    this.path = path;
  }
}

export class AtlassianClient {
  /**
   * @param {string} origin e.g. "https://acme.atlassian.net"
   * @param {{mode: 'session'|'token', email?: string, token?: string}} auth
   */
  constructor(origin, auth) {
    this.origin = origin.replace(/\/+$/, '');
    this.auth = auth || { mode: 'session' };
  }

  get label() {
    try {
      return new URL(this.origin).hostname;
    } catch {
      return this.origin;
    }
  }

  async request(path, { params, signal } = {}) {
    const url = new URL(this.origin + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const headers = { Accept: 'application/json' };
    const init = { method: 'GET', headers, signal, cache: 'no-store', redirect: 'follow' };

    if (this.auth.mode === 'token' && this.auth.email && this.auth.token) {
      headers.Authorization = `Basic ${btoa(`${this.auth.email}:${this.auth.token}`)}`;
      init.credentials = 'omit';
    } else {
      // Reuse the session you already have in this browser.
      init.credentials = 'include';
    }

    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ApiError(
        `Could not reach ${this.label}. Check the site URL and that the extension has permission for it.`,
        { origin: this.origin, path },
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new ApiError(
        this.auth.mode === 'token'
          ? `${this.label} rejected your API token (HTTP ${res.status}).`
          : `Not signed in to ${this.label}. Open it in a tab and log in, or switch to API-token auth in Options.`,
        { status: res.status, origin: this.origin, path },
      );
    }
    if (res.status === 429) {
      throw new ApiError(`${this.label} is rate-limiting requests. Backing off until the next check.`, {
        status: 429, origin: this.origin, path,
      });
    }
    if (!res.ok) {
      // Jira/Confluence report JQL/CQL problems (bad field, no such sprint
      // function) as a 400 with an errorMessages array — surface that instead
      // of a bare status code when it's there.
      let detail = '';
      try {
        const body = await res.clone().json();
        detail = (body.errorMessages && body.errorMessages[0]) || '';
      } catch { /* not JSON, or already consumed */ }
      throw new ApiError(
        detail || `${this.label} returned HTTP ${res.status} for ${path}.`,
        { status: res.status, origin: this.origin, path },
      );
    }

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      // A login redirect served as HTML is the usual cause here.
      throw new ApiError(
        `${this.label} returned a non-JSON response — you are most likely signed out.`,
        { status: res.status, origin: this.origin, path },
      );
    }
    return res.json();
  }

  // ---- identity ----------------------------------------------------------

  /** Resolve the current user via Jira, falling back to Confluence. */
  async whoAmI(signal) {
    try {
      const me = await this.request('/rest/api/3/myself', { signal });
      return {
        accountId: me.accountId,
        displayName: me.displayName,
        email: me.emailAddress || null,
        products: { jira: true },
      };
    } catch (jiraErr) {
      try {
        const me = await this.request('/wiki/rest/api/user/current', { signal });
        return {
          accountId: me.accountId,
          displayName: me.displayName || me.publicName,
          email: me.email || null,
          products: { jira: false },
        };
      } catch {
        throw jiraErr;
      }
    }
  }

  // ---- Jira --------------------------------------------------------------

  /** JQL search, tolerant of both the current and legacy search endpoints. */
  async searchJql(jql, { fields = ['key', 'summary', 'updated'], maxResults = 100, signal } = {}) {
    try {
      const data = await this.request('/rest/api/3/search/jql', {
        params: { jql, fields: fields.join(','), maxResults },
        signal,
      });
      return data.issues || [];
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
        const data = await this.request('/rest/api/3/search', {
          params: { jql, fields: fields.join(','), maxResults },
          signal,
        });
        return data.issues || [];
      }
      throw err;
    }
  }

  async issueComments(issueKey, { maxResults = 50, signal } = {}) {
    const data = await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      params: { maxResults, orderBy: '-created' },
      signal,
    });
    return data.comments || [];
  }

  async issueDescription(issueKey, { signal } = {}) {
    const data = await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      params: { fields: 'description,summary,updated,creator' },
      signal,
    });
    return data;
  }

  // ---- Confluence --------------------------------------------------------

  /**
   * CQL exposes a first-class `mention` field, so Confluence mentions need no
   * heuristics at all.
   */
  async searchCql(cql, { limit = 50, expand, signal } = {}) {
    const data = await this.request('/wiki/rest/api/search', {
      params: { cql, limit, expand },
      signal,
    });
    return { results: data.results || [], base: data._links?.base || `${this.origin}/wiki` };
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

/** Escape a bare string for use inside a quoted JQL/CQL literal. */
export function quoteLiteral(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
