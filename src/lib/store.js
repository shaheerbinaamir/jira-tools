// Local persistence. chrome.storage.local only — no servers, no sync, no
// accounts. Clearing the extension's data wipes everything it knows.

const MAX_RECORDS = 600;
const DISMISSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function getMentions() {
  const { mentions } = await chrome.storage.local.get('mentions');
  return mentions || {};
}

export async function getSyncState() {
  const { syncState } = await chrome.storage.local.get('syncState');
  return syncState || { lastRunAt: 0, running: false, errors: [], seenUpdated: {}, identities: {} };
}

export async function setSyncState(patch) {
  const next = { ...(await getSyncState()), ...patch };
  await chrome.storage.local.set({ syncState: next });
  return next;
}

/** Last-seen active-sprint signature per site, used to notice a sprint rollover. */
export async function getSprintTracking() {
  const { sprintTracking } = await chrome.storage.local.get('sprintTracking');
  return sprintTracking || {};
}

export async function setSprintTracking(next) {
  await chrome.storage.local.set({ sprintTracking: next });
  return next;
}

/**
 * Merge freshly-found mentions in, preserving read/dismissed state for records
 * we have already shown. Returns the ones that are genuinely new.
 */
export async function upsertMentions(found) {
  const existing = await getMentions();
  const now = Date.now();
  const fresh = [];

  for (const record of found) {
    const prior = existing[record.id];
    if (prior) {
      existing[record.id] = {
        ...prior,
        // Content can be edited after the fact; keep the display fields current.
        excerpt: record.excerpt,
        containerTitle: record.containerTitle,
        url: record.url,
      };
    } else {
      existing[record.id] = { ...record, read: false, dismissed: false, firstSeen: now };
      fresh.push(existing[record.id]);
    }
  }

  await chrome.storage.local.set({ mentions: prune(existing) });
  await refreshBadge();
  return fresh;
}

function prune(map) {
  const now = Date.now();
  let records = Object.values(map).filter(
    (m) => !(m.dismissed && now - (m.dismissedAt || m.firstSeen || 0) > DISMISSED_TTL_MS),
  );
  records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (records.length > MAX_RECORDS) {
    // Keep everything unread; only the oldest already-handled items get dropped.
    const keep = records.filter((m) => !m.read && !m.dismissed);
    const rest = records.filter((m) => m.read || m.dismissed);
    records = [...keep, ...rest.slice(0, Math.max(0, MAX_RECORDS - keep.length))];
  }
  return Object.fromEntries(records.map((m) => [m.id, m]));
}

export async function patchMention(id, patch) {
  const mentions = await getMentions();
  if (!mentions[id]) return null;
  mentions[id] = { ...mentions[id], ...patch };
  await chrome.storage.local.set({ mentions });
  await refreshBadge();
  return mentions[id];
}

export async function markAllRead() {
  const mentions = await getMentions();
  for (const id of Object.keys(mentions)) mentions[id].read = true;
  await chrome.storage.local.set({ mentions });
  await refreshBadge();
}

export async function clearAll() {
  await chrome.storage.local.set({ mentions: {} });
  await refreshBadge();
}

export async function unreadCount() {
  const mentions = await getMentions();
  return Object.values(mentions).filter((m) => !m.read && !m.dismissed).length;
}

export async function refreshBadge() {
  const count = await unreadCount();
  await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 999)) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#0b66e4' });
}
