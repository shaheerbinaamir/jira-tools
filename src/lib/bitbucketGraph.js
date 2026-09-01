// Builds a GitHub-profile-style commit heatmap from Bitbucket Cloud, since
// Bitbucket has no equivalent of GitHub's per-user contribution feed.
//
// Approach: list every repo in the configured workspace (or a fixed subset),
// then scan each repo's default-branch commit history for commits authored
// by a chosen account (yourself by default, or anyone else you name), bucketed
// by day.
//
// This can be a lot of requests (Bitbucket's commits endpoint can't filter by
// author server-side, so every commit in the lookback window has to be paged
// through before it can be filtered client-side) and easily runs into
// Bitbucket's rate limit on a busy workspace, so a refresh can take a while.
// Stale-while-revalidate: the last completed scan's `days`/`total` are never
// touched while a new scan is running — only `scanned`/`totalRepos` update
// live, as a progress readout. The graph itself only ever changes at the
// instant a new scan finishes, so opening the tab (or hitting Refresh) never
// blanks out what was already there.

import { getSettings } from './settings.js';
import { BitbucketClient, mapLimit } from './bitbucketApi.js';

const STATE_STORE_KEY = 'bitbucketGraphStates'; // { [targetKey]: state }
const LEGACY_STATE_KEY = 'bitbucketGraphState'; // single-target shape, pre-dates per-person scans
const CACHE_TTL_MS = 30 * 60 * 1000; // how long a completed scan is considered fresh
const STALL_MS = 3 * 60 * 1000; // a "running" scan with no progress for this long is presumed dead
const WEEKS = 53;
const LOOKBACK_MS = WEEKS * 7 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 4;

export const SELF_KEY = 'me';

/** Normalizes whatever the caller typed into the key this scan's state is stored under. */
export function targetKey(target) {
  const trimmed = String(target || '').trim();
  return trimmed ? trimmed.toLowerCase() : SELF_KEY;
}

function dayKey(dateLike) {
  const d = new Date(dateLike);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let migrated = false;

/** One-time move of the pre-multi-target cache into the new per-target shape, so upgrading doesn't lose it. */
async function migrateLegacyState() {
  if (migrated) return;
  migrated = true;
  const stored = await chrome.storage.local.get([STATE_STORE_KEY, LEGACY_STATE_KEY]);
  if (!stored[LEGACY_STATE_KEY]) return;
  const states = stored[STATE_STORE_KEY] || {};
  if (!states[SELF_KEY]) states[SELF_KEY] = stored[LEGACY_STATE_KEY];
  await chrome.storage.local.set({ [STATE_STORE_KEY]: states });
  await chrome.storage.local.remove(LEGACY_STATE_KEY);
}

async function getAllStates() {
  await migrateLegacyState();
  const stored = await chrome.storage.local.get(STATE_STORE_KEY);
  return stored[STATE_STORE_KEY] || {};
}

export async function getBitbucketGraphState(target) {
  const key = targetKey(target);
  const states = await getAllStates();
  return states[key] || { status: 'idle', days: {}, total: 0, errors: [] };
}

/**
 * Reads whatever is already cached for `target`, without ever starting a
 * scan — for just opening/switching to the tab, which should show whatever
 * was last found and nothing more, until the person explicitly asks for a
 * refresh via ensureBitbucketScan.
 */
export async function peekBitbucketGraph({ target } = {}) {
  const { bitbucket } = await getSettings();
  const configured = !!(bitbucket?.workspace && bitbucket?.email && bitbucket?.apiToken);
  if (!configured) return { configured: false, status: 'unconfigured' };

  const key = targetKey(target);
  return { configured: true, target: key, ...(await getBitbucketGraphState(key)) };
}

async function patchState(key, patch) {
  const states = await getAllStates();
  const next = { ...(states[key] || {}), ...patch };
  await chrome.storage.local.set({ [STATE_STORE_KEY]: { ...states, [key]: next } });
  return next;
}

// Tracks in-progress scans for this service-worker lifetime only, keyed the
// same way as storage, so re-opening the popup on the same target while a
// scan is already running doesn't start a second one.
const inFlight = new Map();

/**
 * Ensures a scan is running or fresh for `target` (a Bitbucket username, or
 * omitted/empty for your own configured account), and returns the current
 * state immediately — it does not wait for a full scan to finish. Callers
 * should treat the result as a snapshot and pick up further progress via
 * chrome.storage.onChanged on STATE_STORE_KEY. The `days`/`total` in that
 * snapshot are always the last *completed* scan, even while a refresh is
 * running in the background — never a wiped-out in-progress value.
 */
export async function ensureBitbucketScan({ target, force = false } = {}) {
  const { bitbucket } = await getSettings();
  const configured = !!(bitbucket?.workspace && bitbucket?.email && bitbucket?.apiToken);
  if (!configured) return { configured: false, status: 'unconfigured' };

  const key = targetKey(target);
  const state = await getBitbucketGraphState(key);

  const isFresh = state.status === 'done' && state.fetchedAt && Date.now() - state.fetchedAt < CACHE_TTL_MS;
  const isStalled = state.status === 'running' && Date.now() - (state.startedAt || 0) > STALL_MS;

  if (isFresh && !force) return { configured: true, target: key, ...state };

  if (!inFlight.has(key) && (force || state.status !== 'running' || isStalled)) {
    const promise = runScan(bitbucket, key, key === SELF_KEY ? null : key)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
  }

  return { configured: true, target: key, ...(await getBitbucketGraphState(key)) };
}

/** Builds a predicate matching commits authored by the resolved/typed target. */
function buildMatcher(resolvedUser, rawTarget) {
  if (resolvedUser) {
    return (c) => c.author?.user?.uuid === resolvedUser.uuid;
  }
  // Username lookup failed (private profile, or not actually a username) —
  // fall back to matching the free-text author fields Bitbucket still gives us.
  const needle = rawTarget.toLowerCase();
  return (c) => {
    const nickname = c.author?.user?.nickname?.toLowerCase();
    const displayName = c.author?.user?.display_name?.toLowerCase();
    const raw = c.author?.raw?.toLowerCase() || '';
    return nickname === needle || displayName === needle || raw.includes(needle);
  };
}

async function runScan(bitbucket, key, rawTarget) {
  // Only the progress readout goes live during the scan — status/scanned/
  // totalRepos/errors — never `days`/`total`, so whatever was already on
  // screen stays there until this run actually finishes.
  await patchState(key, { status: 'running', scanned: 0, totalRepos: 0, startedAt: Date.now(), errors: [] });

  const client = new BitbucketClient({ email: bitbucket.email, apiToken: bitbucket.apiToken });
  const sinceMs = Date.now() - LOOKBACK_MS;

  let who; // the identity actually displayed for this scan
  let matches;
  try {
    if (rawTarget) {
      const resolved = await client.resolveUser(rawTarget);
      who = resolved || { username: rawTarget, displayName: rawTarget, unresolved: true };
      matches = buildMatcher(resolved, rawTarget);
    } else {
      who = await client.whoAmI();
      matches = buildMatcher(who, '');
    }
  } catch (err) {
    return patchState(key, { status: 'error', fetchedAt: Date.now(), errors: [{ message: err.message }] });
  }

  let repos;
  try {
    repos = bitbucket.repoSlugs?.length
      ? bitbucket.repoSlugs.map((slug) => ({ slug }))
      : await client.listWorkspaceRepos(bitbucket.workspace);
  } catch (err) {
    return patchState(key, { status: 'error', fetchedAt: Date.now(), errors: [{ message: err.message }] });
  }

  await patchState(key, { totalRepos: repos.length, who });

  const days = {};
  let total = 0;
  let scanned = 0;
  const errors = [];

  await mapLimit(repos, CONCURRENCY, async (repo) => {
    try {
      const commits = await client.listRecentCommits(bitbucket.workspace, repo.slug, { sinceMs });
      for (const c of commits) {
        if (!matches(c)) continue;
        const dKey = dayKey(c.date);
        days[dKey] = (days[dKey] || 0) + 1;
        total += 1;
      }
    } catch (err) {
      errors.push({ repo: repo.slug, message: err.message });
    } finally {
      scanned += 1;
      // Progress only — the visible graph is untouched until the final patch below.
      await patchState(key, { scanned, errors: [...errors] });
    }
  });

  return patchState(key, { status: 'done', fetchedAt: Date.now(), repoCount: repos.length, scanned, days, total, errors, who });
}
