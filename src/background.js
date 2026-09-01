import { syncAll, getInbox, getTimeTracking } from './lib/sync.js';
import { getSettings, setSettings, normalizeOrigin } from './lib/settings.js';
import { patchMention, markAllRead, clearAll, refreshBadge, getSyncState } from './lib/store.js';
import { AtlassianClient } from './lib/api.js';
import { BitbucketClient } from './lib/bitbucketApi.js';
import { ensureBitbucketScan, peekBitbucketGraph } from './lib/bitbucketGraph.js';

const ALARM = 'mentions-poll';

chrome.runtime.onInstalled.addListener(async (details) => {
  await scheduleAlarm();
  await refreshBadge();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
  await refreshBadge();
  runSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runSync();
});

// Re-arm the timer whenever the poll interval changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) scheduleAlarm();
});

async function scheduleAlarm() {
  const { pollMinutes } = await getSettings();
  const period = Math.max(1, Number(pollMinutes) || 5);
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: 0.2 });
}

let inFlight = null;

function runSync(force = false) {
  if (inFlight) return inFlight;
  inFlight = syncAll({ force })
    .then(async (result) => {
      if (result?.fresh?.length) await notifyIfEnabled(result.fresh);
      return result;
    })
    .catch((err) => ({ errors: [{ message: err?.message || String(err) }] }))
    .finally(() => { inFlight = null; });
  return inFlight;
}

async function notifyIfEnabled(fresh) {
  const { notifyOnNew } = await getSettings();
  if (!notifyOnNew) return;
  const granted = await chrome.permissions.contains({ permissions: ['notifications'] });
  if (!granted || !chrome.notifications) return;

  const first = fresh[0];
  const extra = fresh.length - 1;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: extra > 0
      ? `${fresh.length} new mentions`
      : `${first.author} mentioned you`,
    message: extra > 0
      ? `${first.author} on ${first.containerKey} — and ${extra} more`
      : `${first.containerKey}: ${first.excerpt.slice(0, 120)}`,
    silent: false,
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // async response
});

async function handle(msg) {
  switch (msg?.type) {
    case 'inbox':
      return getInbox();

    case 'sync':
      await runSync(true);
      return getInbox();

    case 'syncState':
      return getSyncState();

    case 'patch':
      return patchMention(msg.id, msg.patch);

    case 'dismiss':
      return patchMention(msg.id, { dismissed: true, dismissedAt: Date.now(), read: true });

    case 'markAllRead':
      await markAllRead();
      return getInbox();

    case 'clearAll':
      await clearAll();
      return getInbox();

    case 'timeTracking':
      return getTimeTracking();

    // Just opening/switching to the tab — never starts a scan.
    case 'bitbucketGraphPeek':
      return peekBitbucketGraph({ target: msg.target });

    // Explicit refresh: the Refresh button, or submitting a new target to view.
    case 'bitbucketGraph':
      return ensureBitbucketScan({ target: msg.target, force: !!msg.force });

    // Options page "Test connection" for Bitbucket.
    case 'testBitbucket': {
      const client = new BitbucketClient({ email: msg.email, apiToken: msg.apiToken });
      const me = await client.whoAmI();
      const repos = await client.listWorkspaceRepos(msg.workspace);
      return { me, repoCount: repos.length };
    }

    case 'saveSettings':
      return setSettings(msg.patch);

    case 'getSettings':
      return getSettings();

    // Options page "Test connection" — proves auth works before you rely on it.
    case 'testSite': {
      const origin = normalizeOrigin(msg.site);
      if (!origin) throw new Error('That does not look like an https site URL.');
      const settings = await getSettings();
      const auth = msg.authMode === 'token'
        ? { mode: 'token', email: msg.email, token: msg.token }
        : { mode: 'session' };
      const client = new AtlassianClient(origin, auth);
      const me = await client.whoAmI();
      let confluence = false;
      try {
        await client.searchCql('mention = currentUser() order by lastmodified desc', { limit: 1 });
        confluence = true;
      } catch { /* Confluence not present or not licensed */ }
      return { origin, me, confluence, jira: me.products?.jira === true, savedSites: settings.sites };
    }

    default:
      throw new Error(`Unknown message: ${msg?.type}`);
  }
}
