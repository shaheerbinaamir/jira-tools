// The collector. Given the configured sites, produce the set of Jira and
// Confluence comments that contain a real @-mention of the signed-in user.
//
// Jira has no "mentions me" search field, so the strategy is two-stage:
//   1. Narrow  — JQL text search over a rolling window to get candidate issues.
//   2. Verify  — fetch each candidate's comments and walk the ADF for a mention
//                node whose attrs.id equals your accountId.
// Stage 2 is what makes the result precise: someone typing your name in prose,
// or a colleague who shares your display name, never survives it.
//
// Confluence needs no heuristics: CQL has a real `mention` field.

import { AtlassianClient, ApiError, mapLimit, quoteLiteral } from './api.js';
import { mentionsAccount, excerptAroundMention, htmlToText } from './adf.js';
import { getSettings, setSettings, DEFAULTS } from './settings.js';
import {
  getSyncState, setSyncState, upsertMentions, getMentions,
  getSprintTracking, setSprintTracking,
} from './store.js';

const MAX_ISSUES_PER_SITE = 80;
const ISSUE_CONCURRENCY = 4;

export async function syncAll({ force = false } = {}) {
  const settings = await getSettings();
  const state = await getSyncState();

  if (state.running && !force && Date.now() - (state.runStartedAt || 0) < 120_000) {
    return { skipped: 'already-running' };
  }
  if (!settings.sites.length) {
    await setSyncState({ running: false, lastRunAt: Date.now(), errors: [
      { message: 'No Atlassian site configured yet. Open Options and add your site URL.' },
    ] });
    return { skipped: 'no-sites' };
  }

  await setSyncState({ running: true, runStartedAt: Date.now() });

  const errors = [];
  const found = [];
  const seenUpdated = { ...(state.seenUpdated || {}) };
  const identities = { ...(state.identities || {}) };

  for (const origin of settings.sites) {
    const auth = settings.authMode === 'token'
      ? { mode: 'token', ...(settings.credentials?.[origin] || {}) }
      : { mode: 'session' };
    const client = new AtlassianClient(origin, auth);

    let me;
    try {
      me = await client.whoAmI();
      identities[origin] = me;
    } catch (err) {
      errors.push({ origin, message: err.message });
      continue;
    }
    if (!me.accountId) {
      errors.push({ origin, message: `Could not determine your accountId on ${client.label}.` });
      continue;
    }

    if (settings.includeJira) {
      try {
        found.push(...await collectJira(client, me, settings, seenUpdated));
      } catch (err) {
        if (!isMissingProduct(err)) errors.push({ origin, product: 'Jira', message: err.message });
      }
    }
    if (settings.includeConfluence) {
      try {
        found.push(...await collectConfluence(client, me, settings));
      } catch (err) {
        if (!isMissingProduct(err)) errors.push({ origin, product: 'Confluence', message: err.message });
      }
    }
  }

  const fresh = await upsertMentions(found);
  await setSyncState({
    running: false,
    lastRunAt: Date.now(),
    lastFoundCount: found.length,
    errors,
    seenUpdated,
    identities,
  });

  return { total: found.length, fresh, errors };
}

function isMissingProduct(err) {
  // A site with only one product answers 404 for the other one's endpoints.
  return err instanceof ApiError && err.status === 404;
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

async function collectJira(client, me, settings, seenUpdated) {
  const terms = searchTerms(me, settings);
  const window = `updated >= -${Math.max(1, settings.lookbackDays)}d`;

  /** @type {Map<string, any>} */
  const candidates = new Map();
  let anySearchWorked = false;
  let lastSearchError = null;

  for (const term of terms) {
    const jql = `${window} AND text ~ ${quoteLiteral(term)} ORDER BY updated DESC`;
    try {
      const issues = await client.searchJql(jql, { maxResults: MAX_ISSUES_PER_SITE });
      anySearchWorked = true;
      for (const issue of issues) if (!candidates.has(issue.key)) candidates.set(issue.key, issue);
    } catch (err) {
      // One malformed term must not sink the whole run.
      lastSearchError = err;
    }
  }
  if (!anySearchWorked && lastSearchError) throw lastSearchError;

  const issues = [...candidates.values()].slice(0, MAX_ISSUES_PER_SITE);

  // Skip issues whose `updated` timestamp has not moved since we last verified
  // them — their mentions are already in the store.
  const toVerify = issues.filter((issue) => {
    const key = `${client.origin}|${issue.key}`;
    return seenUpdated[key] !== issue.fields?.updated;
  });

  const results = await mapLimit(toVerify, ISSUE_CONCURRENCY, async (issue) => {
    const records = await verifyJiraIssue(client, issue, me, settings);
    seenUpdated[`${client.origin}|${issue.key}`] = issue.fields?.updated;
    return records;
  });

  const out = [];
  for (const r of results) {
    if (r && r.__error) continue; // a single unreadable issue is not fatal
    if (Array.isArray(r)) out.push(...r);
  }
  return out;
}

async function verifyJiraIssue(client, issue, me, settings) {
  const records = [];
  const summary = issue.fields?.summary || issue.key;

  const comments = await client.issueComments(issue.key);
  for (const comment of comments) {
    if (!mentionsAccount(comment.body, me.accountId)) continue;
    if (comment.author?.accountId === me.accountId) continue; // your own @-mentions of yourself
    records.push({
      id: `${client.origin}|jira|comment|${comment.id}`,
      product: 'jira',
      kind: 'comment',
      origin: client.origin,
      siteLabel: client.label,
      containerKey: issue.key,
      containerTitle: summary,
      author: comment.author?.displayName || 'Unknown',
      authorAvatar: pickAvatar(comment.author?.avatarUrls),
      createdAt: Date.parse(comment.updated || comment.created) || Date.now(),
      excerpt: excerptAroundMention(comment.body, me.accountId),
      url: `${client.origin}/browse/${encodeURIComponent(issue.key)}?focusedCommentId=${encodeURIComponent(comment.id)}`,
    });
  }

  if (settings.includeDescriptions) {
    try {
      const full = await client.issueDescription(issue.key);
      const description = full.fields?.description;
      if (description && mentionsAccount(description, me.accountId)
          && full.fields?.creator?.accountId !== me.accountId) {
        records.push({
          id: `${client.origin}|jira|description|${issue.key}`,
          product: 'jira',
          kind: 'description',
          origin: client.origin,
          siteLabel: client.label,
          containerKey: issue.key,
          containerTitle: summary,
          author: full.fields?.creator?.displayName || 'Unknown',
          authorAvatar: pickAvatar(full.fields?.creator?.avatarUrls),
          createdAt: Date.parse(full.fields?.updated) || Date.now(),
          excerpt: excerptAroundMention(description, me.accountId),
          url: `${client.origin}/browse/${encodeURIComponent(issue.key)}`,
        });
      }
    } catch {
      // Description is a bonus; never let it break comment collection.
    }
  }

  return records;
}

function searchTerms(me, settings) {
  const terms = new Set();
  if (me.displayName) terms.add(me.displayName);
  for (const alias of settings.aliases || []) {
    const trimmed = String(alias).trim();
    if (trimmed) terms.add(trimmed);
  }
  // Jira indexes the raw mention markup on some sites, so this is worth a shot.
  if (me.accountId) terms.add(me.accountId);
  return [...terms];
}

function pickAvatar(avatarUrls) {
  if (!avatarUrls) return null;
  return avatarUrls['48x48'] || avatarUrls['32x32'] || avatarUrls['24x24'] || null;
}

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

async function collectConfluence(client, me, settings) {
  const since = new Date(Date.now() - Math.max(1, settings.lookbackDays) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const cql = `mention = currentUser() and lastmodified >= "${since}" order by lastmodified desc`;

  const { results, base } = await client.searchCql(cql, {
    limit: 100,
    expand: 'content.version,content.history,content.space',
  });

  const records = [];
  for (const result of results) {
    const content = result.content || {};
    const type = content.type || 'page';
    const isComment = type === 'comment';
    if (!isComment && !settings.includeDescriptions) continue;

    const author = content.version?.by?.displayName
      || content.history?.createdBy?.displayName
      || 'Unknown';
    const authorId = content.version?.by?.accountId || content.history?.createdBy?.accountId;
    if (authorId && authorId === me.accountId) continue;

    const excerpt = htmlToText(result.excerpt) || '(no preview available)';
    const title = (result.title || content.title || 'Confluence content').replace(/^Re:\s*/, '');

    records.push({
      id: `${client.origin}|confluence|${type}|${content.id || result.url}`,
      product: 'confluence',
      kind: isComment ? 'comment' : 'page',
      origin: client.origin,
      siteLabel: client.label,
      containerKey: content.space?.name || content.space?.key || 'Confluence',
      containerTitle: title,
      author,
      authorAvatar: absolutize(content.version?.by?.profilePicture?.path, client.origin),
      createdAt: Date.parse(result.lastModified || content.version?.when) || Date.now(),
      excerpt,
      url: absolutize(result.url, client.origin, base),
    });
  }
  return records;
}

function absolutize(path, origin, base) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (base) return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
  const prefix = path.startsWith('/wiki') ? '' : '/wiki';
  return origin + prefix + (path.startsWith('/') ? path : `/${path}`);
}

// ---------------------------------------------------------------------------

/** Everything the popup needs, in one read. */
export async function getInbox() {
  const [mentions, state, settings] = await Promise.all([getMentions(), getSyncState(), getSettings()]);
  const list = Object.values(mentions)
    .filter((m) => !m.dismissed)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { list, state, settings };
}

// ---------------------------------------------------------------------------
// Time tracking — issues assigned to you in the current sprint
// ---------------------------------------------------------------------------

// 'sprint' resolves to whichever custom field Jira Software uses for Sprint
// on each site — Jira accepts field names as well as ids, and silently
// omits it if a site has no such field, so this is safe to always request.
// 'resolutiondate' is set the moment an issue is resolved (moved to a
// Done-category status under default workflows) — the closest stock Jira
// field to "the date this was moved to Done" without walking each issue's
// full changelog.
const TIME_TRACKING_FIELDS = ['key', 'summary', 'status', 'timetracking', 'sprint', 'resolutiondate'];

/** The active sprint(s) an issue belongs to, as Jira's "sprint" field reports them. */
function activeSprintIds(issue) {
  const raw = issue.fields?.sprint;
  const sprints = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return sprints.filter((s) => s?.state === 'active').map((s) => s.id);
}

/**
 * Compares this origin's currently active sprint(s) against what was seen
 * last time. Returns true the first time a *different* non-empty sprint
 * signature shows up — i.e. a genuine rollover, not the first-ever check.
 */
async function detectSprintRollover(origin, issues) {
  const ids = [...new Set(issues.flatMap(activeSprintIds))].sort((a, b) => a - b);
  const signature = ids.join(',');

  const tracking = await getSprintTracking();
  const previous = tracking[origin];
  tracking[origin] = signature;
  await setSprintTracking(tracking);

  return Boolean(signature && previous !== undefined && previous !== signature);
}

/**
 * Sums the Jira "Time Tracking" field (logged time) across every issue
 * assigned to you in each site's current/active sprint(s). This is a live,
 * on-demand read — it is not cached or polled, since sprint scope is small
 * and the point is always "right now".
 */
export async function getTimeTracking() {
  let settings = await getSettings();
  const errors = [];
  const tickets = [];
  let totalSeconds = 0;
  let sprintRolledOver = false;

  if (!settings.sites.length) {
    return { totalSeconds, tickets, errors: [
      { message: 'No Atlassian site configured yet. Open Options and add your site URL.' },
    ], fetchedAt: Date.now(), sprintHoursTarget: settings.sprintHoursTarget };
  }

  for (const origin of settings.sites) {
    const auth = settings.authMode === 'token'
      ? { mode: 'token', ...(settings.credentials?.[origin] || {}) }
      : { mode: 'session' };
    const client = new AtlassianClient(origin, auth);

    let me;
    try {
      me = await client.whoAmI();
    } catch (err) {
      errors.push({ origin, message: err.message });
      continue;
    }

    let issues;
    try {
      issues = await client.searchJql('assignee = currentUser() AND sprint in openSprints() ORDER BY key ASC', {
        fields: TIME_TRACKING_FIELDS,
        maxResults: 200,
      });
    } catch (err) {
      errors.push({
        origin,
        message: err instanceof ApiError && err.status === 400
          ? `${client.label}: no active sprint, or this project isn't board-managed (Sprints need Jira Software).`
          : err.message,
      });
      continue;
    }

    if (await detectSprintRollover(origin, issues)) sprintRolledOver = true;

    for (const issue of issues) {
      const seconds = issue.fields?.timetracking?.timeSpentSeconds || 0;
      totalSeconds += seconds;
      tickets.push({
        id: `${client.origin}|${issue.key}`,
        origin: client.origin,
        siteLabel: client.label,
        key: issue.key,
        summary: issue.fields?.summary || '',
        status: issue.fields?.status?.name || '',
        seconds,
        resolvedAt: issue.fields?.resolutiondate ? new Date(issue.fields.resolutiondate).getTime() : null,
        url: `${client.origin}/browse/${encodeURIComponent(issue.key)}`,
      });
    }
  }

  let sprintReset = false;
  if (sprintRolledOver && settings.autoResetSprintTarget && settings.sprintHoursTarget !== DEFAULTS.sprintHoursTarget) {
    settings = await setSettings({ sprintHoursTarget: DEFAULTS.sprintHoursTarget });
    sprintReset = true;
  }

  sortTickets(tickets, settings.timeTrackingSort);
  return {
    totalSeconds, tickets, errors, fetchedAt: Date.now(),
    sprintHoursTarget: settings.sprintHoursTarget, sprintReset,
    timeTrackingSort: settings.timeTrackingSort,
  };
}

/** Most-recently-done first by default; unresolved issues sort after resolved ones. */
function sortTickets(tickets, sortBy) {
  if (sortBy === 'size') {
    tickets.sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
    return;
  }
  tickets.sort((a, b) => {
    if (a.resolvedAt && b.resolvedAt) return b.resolvedAt - a.resolvedAt;
    if (a.resolvedAt) return -1;
    if (b.resolvedAt) return 1;
    return a.key.localeCompare(b.key);
  });
}
