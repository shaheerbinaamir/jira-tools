// Settings live entirely in chrome.storage.local. Nothing leaves this machine.

export const DEFAULTS = {
  // e.g. ["https://acme.atlassian.net"]
  sites: [],
  // "session" = reuse the cookies from your logged-in browser (nothing stored).
  // "token"   = Basic auth with an Atlassian API token you paste in Options.
  authMode: 'session',
  // Only used when authMode === "token". Stored locally, never transmitted
  // anywhere except to your own Atlassian site over HTTPS.
  credentials: {}, // { [siteOrigin]: { email, token } }
  pollMinutes: 5,
  lookbackDays: 14,
  includeJira: true,
  includeConfluence: true,
  // Extra strings to feed the Jira text search, for when your mention text
  // differs from your profile display name (nicknames, maiden names, etc.).
  // Every hit is still ADF-verified against your accountId, so adding aliases
  // can only ever find more true mentions, never create false ones.
  aliases: [],
  // Also treat @-mentions in issue/page descriptions as mentions, not just comments.
  includeDescriptions: true,
  notifyOnNew: false,
  theme: 'system', // system | light | dark
  // Editable per sprint — lower it when you take a day off or there's a
  // public holiday, since you have fewer hours to deliver against.
  sprintHoursTarget: 65,
  // How the Time Tracking tab orders your current-sprint issues.
  // "doneDate" = most recently resolved first; "size" = most time logged first.
  timeTrackingSort: 'doneDate',
  // When a new sprint is detected (see lib/sync.js detectSprintRollover),
  // snap sprintHoursTarget back to this default instead of carrying over
  // whatever you'd dialled it down to for the last one.
  autoResetSprintTarget: true,

  // Bitbucket Cloud commit-activity heatmap (GitHub-profile-style green squares).
  // App passwords are deprecated; auth is a scoped Atlassian API token (same
  // mechanism as the Jira/Confluence token auth above), stored locally and
  // sent only to api.bitbucket.org over HTTPS.
  bitbucket: {
    workspace: '', // e.g. "acme" from bitbucket.org/acme/...
    email: '',
    apiToken: '',
    repoSlugs: [], // empty = scan every repo in the workspace
  },
};

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function normalizeOrigin(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return url.origin;
}
