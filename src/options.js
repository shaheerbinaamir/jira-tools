import { DEFAULTS, normalizeOrigin } from './lib/settings.js';

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };
let syncState = {};

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (reply) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!reply?.ok) return reject(new Error(reply?.error || 'Unknown error'));
      resolve(reply.data);
    });
  });
}

function applyTheme(theme) {
  const dark = theme === 'dark'
    || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function toForm() {
  $('includeJira').checked = settings.includeJira;
  $('includeConfluence').checked = settings.includeConfluence;
  $('includeDescriptions').checked = settings.includeDescriptions;
  $('notifyOnNew').checked = settings.notifyOnNew;
  $('pollMinutes').value = settings.pollMinutes;
  $('lookbackDays').value = settings.lookbackDays;
  $('theme').value = settings.theme;
  $('sprintHoursTarget').value = settings.sprintHoursTarget;
  $('autoResetSprintTarget').checked = settings.autoResetSprintTarget;
  $('aliases').value = (settings.aliases || []).join('\n');

  $('bbWorkspace').value = settings.bitbucket?.workspace || '';
  $('bbEmail').value = settings.bitbucket?.email || '';
  $('bbApiToken').value = settings.bitbucket?.apiToken || '';
  $('bbRepoSlugs').value = (settings.bitbucket?.repoSlugs || []).join('\n');

  for (const radio of document.querySelectorAll('input[name="authMode"]')) {
    radio.checked = radio.value === settings.authMode;
  }
  $('tokenFields').hidden = settings.authMode !== 'token';

  const anyCred = Object.values(settings.credentials || {})[0] || {};
  $('tokenEmail').value = anyCred.email || '';
  $('tokenValue').value = anyCred.token || '';

  applyTheme(settings.theme);
  renderSites();
}

function renderSites() {
  const ul = $('siteList');
  ul.replaceChildren();

  if (!settings.sites.length) {
    const li = document.createElement('li');
    li.textContent = 'No sites yet — add one above.';
    li.style.color = 'var(--text-faint)';
    ul.appendChild(li);
    return;
  }

  for (const origin of settings.sites) {
    const li = document.createElement('li');

    const label = document.createElement('span');
    label.className = 'origin';
    label.textContent = origin;
    li.appendChild(label);

    const identity = syncState.identities?.[origin];
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = identity?.displayName ? `signed in as ${identity.displayName}` : 'not verified yet';
    li.appendChild(who);

    const remove = document.createElement('button');
    remove.className = 'ghost danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      settings.sites = settings.sites.filter((s) => s !== origin);
      delete settings.credentials?.[origin];
      await persist();
      renderSites();
    });
    li.appendChild(remove);

    ul.appendChild(li);
  }
}

function readForm() {
  const authMode = document.querySelector('input[name="authMode"]:checked')?.value || 'session';
  const email = $('tokenEmail').value.trim();
  const token = $('tokenValue').value;

  const credentials = {};
  if (authMode === 'token' && email && token) {
    for (const origin of settings.sites) credentials[origin] = { email, token };
  }

  return {
    sites: settings.sites,
    authMode,
    credentials,
    includeJira: $('includeJira').checked,
    includeConfluence: $('includeConfluence').checked,
    includeDescriptions: $('includeDescriptions').checked,
    notifyOnNew: $('notifyOnNew').checked,
    pollMinutes: clampNumber($('pollMinutes').value, 1, 240, 5),
    lookbackDays: clampNumber($('lookbackDays').value, 1, 90, 14),
    theme: $('theme').value,
    sprintHoursTarget: clampNumber($('sprintHoursTarget').value, 0, 200, 65, { round: false }),
    autoResetSprintTarget: $('autoResetSprintTarget').checked,
    aliases: $('aliases').value.split('\n').map((s) => s.trim()).filter(Boolean),
    bitbucket: {
      workspace: $('bbWorkspace').value.trim(),
      email: $('bbEmail').value.trim(),
      apiToken: $('bbApiToken').value,
      repoSlugs: $('bbRepoSlugs').value.split('\n').map((s) => s.trim()).filter(Boolean),
    },
  };
}

function clampNumber(value, min, max, fallback, { round = true } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, round ? Math.round(n) : n));
}

async function persist(patch) {
  settings = await send({ type: 'saveSettings', patch: patch || { sites: settings.sites, credentials: settings.credentials } });
  return settings;
}

function showResult(text, kind) {
  const el = $('testResult');
  el.hidden = false;
  el.className = `result ${kind}`;
  el.textContent = text;
}

/** Non-atlassian.net hosts (Data Center, custom domains) need opt-in access. */
async function ensurePermission(origin) {
  const pattern = `${origin}/*`;
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

$('testSite').addEventListener('click', async () => {
  const origin = normalizeOrigin($('siteInput').value);
  if (!origin) return showResult('Enter a full https URL, e.g. https://acme.atlassian.net', 'bad');

  if (!await ensurePermission(origin)) {
    return showResult(`Permission to reach ${origin} was declined, so it cannot be checked.`, 'bad');
  }

  showResult('Checking…', '');
  const form = readForm();
  try {
    const result = await send({
      type: 'testSite',
      site: origin,
      authMode: form.authMode,
      email: $('tokenEmail').value.trim(),
      token: $('tokenValue').value,
    });
    const products = [result.jira && 'Jira', result.confluence && 'Confluence'].filter(Boolean);
    showResult(
      `Connected to ${result.origin}\n`
      + `Signed in as ${result.me.displayName} (${result.me.accountId})\n`
      + `Available: ${products.length ? products.join(', ') : 'neither product responded — check your licences'}`,
      'ok',
    );
  } catch (err) {
    showResult(err.message, 'bad');
  }
});

$('addSite').addEventListener('click', async () => {
  const origin = normalizeOrigin($('siteInput').value);
  if (!origin) return showResult('Enter a full https URL, e.g. https://acme.atlassian.net', 'bad');
  if (settings.sites.includes(origin)) return showResult('That site is already on the list.', 'bad');
  if (!await ensurePermission(origin)) {
    return showResult(`Permission to reach ${origin} was declined, so it was not added.`, 'bad');
  }

  settings.sites = [...settings.sites, origin];
  await persist(readForm());
  $('siteInput').value = '';
  showResult(`Added ${origin}. It will be included in the next check.`, 'ok');
  renderSites();
});

for (const radio of document.querySelectorAll('input[name="authMode"]')) {
  radio.addEventListener('change', () => {
    $('tokenFields').hidden = radio.value !== 'token' || !radio.checked;
  });
}

$('theme').addEventListener('change', (e) => applyTheme(e.target.value));

function showBbResult(text, kind) {
  const el = $('bbTestResult');
  el.hidden = false;
  el.className = `result ${kind}`;
  el.textContent = text;
}

$('testBitbucket').addEventListener('click', async () => {
  const workspace = $('bbWorkspace').value.trim();
  const email = $('bbEmail').value.trim();
  const apiToken = $('bbApiToken').value;
  if (!workspace || !email || !apiToken) {
    return showBbResult('Workspace, email and API token are all required.', 'bad');
  }
  showBbResult('Checking…', '');
  try {
    const result = await send({ type: 'testBitbucket', workspace, email, apiToken });
    showBbResult(
      `Signed in as ${result.me.displayName} (@${result.me.username})\n`
      + `Found ${result.repoCount} repo${result.repoCount === 1 ? '' : 's'} in workspace "${workspace}"`,
      'ok',
    );
  } catch (err) {
    showBbResult(err.message, 'bad');
  }
});

$('notifyOnNew').addEventListener('change', async (e) => {
  if (!e.target.checked) return;
  const granted = await chrome.permissions.request({ permissions: ['notifications'] });
  if (!granted) {
    e.target.checked = false;
    showResult('Desktop notifications need the notifications permission, which was declined.', 'bad');
  }
});

$('save').addEventListener('click', async () => {
  const patch = readForm();
  if (patch.authMode === 'token' && (!$('tokenEmail').value.trim() || !$('tokenValue').value)) {
    return showResult('API-token mode needs both your account email and a token.', 'bad');
  }
  settings = await send({ type: 'saveSettings', patch });
  $('saveStatus').textContent = `Saved at ${new Date().toLocaleTimeString()}`;
  toForm();
  send({ type: 'sync' }).catch(() => {});
});

$('clearCache').addEventListener('click', async () => {
  await send({ type: 'clearAll' });
  $('saveStatus').textContent = 'Collected mentions cleared.';
});

$('resetAll').addEventListener('click', async () => {
  await chrome.storage.local.clear();
  settings = { ...DEFAULTS };
  syncState = {};
  toForm();
  $('saveStatus').textContent = 'Everything reset.';
});

(async function init() {
  settings = await send({ type: 'getSettings' });
  syncState = await send({ type: 'syncState' });
  toForm();
})();
