// All rendering goes through textContent / createElement. Comment bodies come
// from other people, so they are never interpolated as HTML.

const listEl = document.getElementById('mentionsView');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');
const bannerEl = document.getElementById('banner');
const pageTitleEl = document.getElementById('pageTitle');
const filtersEl = document.getElementById('filters');
const ttViewEl = document.getElementById('timeTrackingView');
const ttTotalEl = document.getElementById('ttTotal');
const ttListEl = document.getElementById('ttList');
const ttSortEl = document.getElementById('ttSort');
const bbViewEl = document.getElementById('bitbucketView');
const bbSummaryEl = document.getElementById('bbSummary');
const bbGraphEl = document.getElementById('bbGraph');
const markAllBtn = document.getElementById('markAll');

let filter = 'all';
let tab = 'mentions';
let inbox = { list: [], state: {}, settings: {} };
let timeTracking = null; // fetched lazily, on first visit to the tab
let ttSort = 'doneDate'; // overwritten once settings load, see loadTimeTracking
let bitbucketGraph = null; // fetched lazily, on first visit to the tab
let bitbucketTarget = ''; // '' = your own configured account

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

function relativeTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Flat hour count — no day/week breakdown. */
function formatHours(totalSeconds) {
  if (!totalSeconds) return '0h';
  const hours = totalSeconds / 3600;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}h`;
}

/** How far logged time is from this sprint's configurable hours target. */
function formatMandateGap(totalSeconds, targetHours) {
  const targetSeconds = targetHours * 3600;
  const diffSeconds = (totalSeconds || 0) - targetSeconds;
  if (diffSeconds >= 0) return `${formatHours(diffSeconds)} over the ${targetHours}h sprint target`;
  return `${formatHours(-diffSeconds)} short of the ${targetHours}h sprint target`;
}

/** Names to visually highlight inside an excerpt. */
function highlightTerms() {
  const terms = new Set();
  for (const identity of Object.values(inbox.state?.identities || {})) {
    if (identity?.displayName) terms.add(`@${identity.displayName}`);
  }
  for (const alias of inbox.settings?.aliases || []) {
    if (alias) terms.add(`@${alias}`);
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

function renderExcerpt(target, text) {
  const terms = highlightTerms();
  if (!terms.length) { target.textContent = text; return; }

  let remaining = text;
  let guard = 0;
  while (remaining && guard++ < 200) {
    let bestIndex = -1;
    let bestTerm = null;
    for (const term of terms) {
      const at = remaining.toLowerCase().indexOf(term.toLowerCase());
      if (at !== -1 && (bestIndex === -1 || at < bestIndex)) { bestIndex = at; bestTerm = term; }
    }
    if (bestIndex === -1) break;
    if (bestIndex > 0) target.appendChild(document.createTextNode(remaining.slice(0, bestIndex)));
    const mark = document.createElement('mark');
    mark.textContent = remaining.slice(bestIndex, bestIndex + bestTerm.length);
    target.appendChild(mark);
    remaining = remaining.slice(bestIndex + bestTerm.length);
  }
  if (remaining) target.appendChild(document.createTextNode(remaining));
}

function visible() {
  return inbox.list.filter((m) => {
    if (filter === 'unread') return !m.read;
    if (filter === 'jira') return m.product === 'jira';
    if (filter === 'confluence') return m.product === 'confluence';
    return true;
  });
}

function card(m) {
  const el = document.createElement('article');
  el.className = `card ${m.read ? 'is-read' : 'is-unread'}`;
  el.tabIndex = 0;

  const head = document.createElement('div');
  head.className = 'card-head';

  const badge = document.createElement('span');
  badge.className = `badge ${m.product}`;
  badge.textContent = m.product === 'jira' ? 'Jira' : 'Confluence';
  head.appendChild(badge);

  const key = document.createElement('span');
  key.className = 'card-key';
  key.textContent = m.containerKey || '';
  head.appendChild(key);

  if (m.kind && m.kind !== 'comment') {
    const kind = document.createElement('span');
    kind.className = 'badge';
    kind.textContent = m.kind;
    head.appendChild(kind);
  }

  const time = document.createElement('span');
  time.className = 'card-time';
  time.textContent = relativeTime(m.createdAt);
  time.title = m.createdAt ? new Date(m.createdAt).toLocaleString() : '';
  head.appendChild(time);
  el.appendChild(head);

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = m.containerTitle || '';
  title.title = m.containerTitle || '';
  el.appendChild(title);

  const author = document.createElement('div');
  author.className = 'card-author';
  author.textContent = `${m.author} mentioned you`;
  el.appendChild(author);

  const excerpt = document.createElement('div');
  excerpt.className = 'card-excerpt';
  renderExcerpt(excerpt, m.excerpt || '');
  el.appendChild(excerpt);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const open = document.createElement('button');
  open.className = 'primary';
  open.textContent = 'Open';
  open.addEventListener('click', (e) => { e.stopPropagation(); openMention(m); });
  actions.appendChild(open);

  const toggleRead = document.createElement('button');
  toggleRead.textContent = m.read ? 'Mark unread' : 'Mark read';
  toggleRead.addEventListener('click', async (e) => {
    e.stopPropagation();
    await send({ type: 'patch', id: m.id, patch: { read: !m.read } });
    await load();
  });
  actions.appendChild(toggleRead);

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  actions.appendChild(spacer);

  const dismiss = document.createElement('button');
  dismiss.textContent = 'Dismiss';
  dismiss.title = 'Hide this from the list (does not touch Jira)';
  dismiss.addEventListener('click', async (e) => {
    e.stopPropagation();
    await send({ type: 'dismiss', id: m.id });
    await load();
  });
  actions.appendChild(dismiss);

  el.appendChild(actions);

  el.addEventListener('click', () => el.classList.toggle('is-expanded'));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openMention(m);
  });

  return el;
}

async function openMention(m) {
  await send({ type: 'patch', id: m.id, patch: { read: true } });
  await chrome.tabs.create({ url: m.url });
  window.close();
}

function renderEmpty() {
  const wrap = document.createElement('div');
  wrap.className = 'empty';

  const noSites = !(inbox.settings?.sites || []).length;
  const big = document.createElement('div');
  big.className = 'big';
  big.textContent = noSites ? '⚙' : '✓';
  wrap.appendChild(big);

  const lines = noSites
    ? ['No Atlassian site configured.', 'Open Settings and add your site URL to get started.']
    : filter === 'all'
      ? ['Nobody has @-mentioned you.', 'Routine Jira noise stays where it belongs.']
      : ['Nothing here.', 'Try the All tab.'];

  for (const line of lines) {
    const p = document.createElement('p');
    p.textContent = line;
    wrap.appendChild(p);
  }

  if (noSites) {
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Open Settings';
    btn.addEventListener('click', () => chrome.runtime.openOptionsPage());
    wrap.appendChild(btn);
  }
  return wrap;
}

function render() {
  applyTheme(inbox.settings?.theme || 'system');

  const items = visible();
  const unread = inbox.list.filter((m) => !m.read).length;
  countEl.textContent = unread ? `${unread} unread` : `${inbox.list.length} total`;

  listEl.replaceChildren();
  if (!items.length) {
    listEl.appendChild(renderEmpty());
  } else {
    for (const m of items) listEl.appendChild(card(m));
  }

  const errors = inbox.state?.errors || [];
  if (errors.length) {
    bannerEl.hidden = false;
    bannerEl.textContent = errors
      .map((e) => (e.product ? `${e.product}: ${e.message}` : e.message))
      .join('\n');
  } else {
    bannerEl.hidden = true;
    bannerEl.textContent = '';
  }

  const last = inbox.state?.lastRunAt;
  statusEl.textContent = inbox.state?.running
    ? 'Checking…'
    : last
      ? `Last checked ${relativeTime(last)} · every ${inbox.settings?.pollMinutes || 5} min`
      : 'Not checked yet';
}

// ---------------------------------------------------------------------------
// Time tracking tab
// ---------------------------------------------------------------------------

function ttRow(t) {
  const el = document.createElement('article');
  el.className = 'tt-row';
  el.tabIndex = 0;

  const key = document.createElement('span');
  key.className = 'tt-key';
  key.textContent = t.key;
  el.appendChild(key);

  const summary = document.createElement('span');
  summary.className = 'tt-summary';
  summary.textContent = t.summary;
  summary.title = t.summary;
  el.appendChild(summary);

  if (t.status) {
    const status = document.createElement('span');
    status.className = 'tt-status';
    status.textContent = t.status;
    el.appendChild(status);
  }

  const time = document.createElement('span');
  time.className = 'tt-time';
  time.textContent = formatHours(t.seconds);
  el.appendChild(time);

  if (ttSort === 'doneDate') {
    const done = document.createElement('span');
    done.className = 'tt-done';
    done.textContent = t.resolvedAt ? `Done ${relativeTime(t.resolvedAt)}` : 'Not done yet';
    el.appendChild(done);
  }

  const open = () => { chrome.tabs.create({ url: t.url }); window.close(); };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });

  return el;
}

/** Mirrors lib/sync.js's sortTickets — kept local so toggling doesn't need a refetch. */
function sortTicketsForDisplay(tickets, sortBy) {
  const sorted = [...tickets];
  if (sortBy === 'size') {
    sorted.sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
  } else {
    sorted.sort((a, b) => {
      if (a.resolvedAt && b.resolvedAt) return b.resolvedAt - a.resolvedAt;
      if (a.resolvedAt) return -1;
      if (b.resolvedAt) return 1;
      return a.key.localeCompare(b.key);
    });
  }
  return sorted;
}

function renderTimeTracking() {
  ttTotalEl.replaceChildren();
  ttListEl.replaceChildren();

  if (!timeTracking) return;

  const targetHours = timeTracking.sprintHoursTarget ?? 65;

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Logged this sprint';
  const value = document.createElement('span');
  value.className = 'value';
  value.textContent = formatHours(timeTracking.totalSeconds);
  const mandateGap = document.createElement('span');
  mandateGap.className = `sub tt-mandate ${timeTracking.totalSeconds >= targetHours * 3600 ? 'is-met' : 'is-short'}`;
  mandateGap.textContent = formatMandateGap(timeTracking.totalSeconds, targetHours);
  ttTotalEl.appendChild(label);
  ttTotalEl.appendChild(value);
  ttTotalEl.appendChild(mandateGap);

  if (timeTracking.sprintReset) {
    const note = document.createElement('span');
    note.className = 'sub tt-sprint-note';
    note.textContent = `New sprint detected — target reset to ${targetHours}h`;
    ttTotalEl.appendChild(note);
  }

  const tracked = sortTicketsForDisplay(timeTracking.tickets.filter((t) => t.seconds > 0), ttSort);
  const multiSite = new Set(timeTracking.tickets.map((t) => t.origin)).size > 1;

  if (!tracked.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const p = document.createElement('p');
    p.textContent = timeTracking.tickets.length
      ? 'No time logged yet on your current-sprint issues.'
      : 'No issues assigned to you in an active sprint.';
    empty.appendChild(p);
    ttListEl.appendChild(empty);
    return;
  }

  let lastSite = null;
  for (const t of tracked) {
    if (multiSite && t.siteLabel !== lastSite) {
      const heading = document.createElement('div');
      heading.className = 'tt-site';
      heading.textContent = t.siteLabel;
      ttListEl.appendChild(heading);
      lastSite = t.siteLabel;
    }
    ttListEl.appendChild(ttRow(t));
  }
}

async function loadTimeTracking(force = false) {
  if (timeTracking && !force) { renderTimeTracking(); return; }
  statusEl.textContent = 'Checking…';
  try {
    timeTracking = await send({ type: 'timeTracking' });
    ttSort = timeTracking.timeTrackingSort || 'doneDate';
    ttSortEl.value = ttSort;
    renderTimeTracking();
    const errors = timeTracking.errors || [];
    bannerEl.hidden = !errors.length;
    bannerEl.textContent = errors.map((e) => e.message).join('\n');
    statusEl.textContent = `Checked ${relativeTime(timeTracking.fetchedAt)}`;
  } catch (err) {
    bannerEl.hidden = false;
    bannerEl.textContent = err.message;
    statusEl.textContent = 'Could not load time tracking.';
  }
}

// ---------------------------------------------------------------------------
// Bitbucket commit heatmap tab
// ---------------------------------------------------------------------------

const BB_WEEKS = 53;
const SVG_NS = 'http://www.w3.org/2000/svg';

function bbDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function bbLevel(count) {
  if (!count) return 0;
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  if (count <= 7) return 3;
  return 4;
}

function bbBuildCells(days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (BB_WEEKS * 7 - 1));
  start.setDate(start.getDate() - start.getDay()); // back up to the preceding Sunday

  const cells = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const key = bbDayKey(cursor);
    cells.push({ date: new Date(cursor), key, count: days[key] || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return cells;
}

function renderBitbucketGraphSvg(days) {
  const cells = bbBuildCells(days);
  const cols = Math.ceil(cells.length / 7);
  const CELL = 10;
  const GAP = 2;
  const STEP = CELL + GAP;
  const width = cols * STEP;
  const height = 7 * STEP;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Commit activity heatmap');

  cells.forEach((cell, i) => {
    const col = Math.floor(i / 7);
    const row = i % 7;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', `bb-cell bb-level-${bbLevel(cell.count)}`);
    rect.setAttribute('x', col * STEP);
    rect.setAttribute('y', row * STEP);
    rect.setAttribute('width', CELL);
    rect.setAttribute('height', CELL);
    rect.setAttribute('rx', 2);
    const title = document.createElementNS(SVG_NS, 'title');
    const label = cell.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    title.textContent = cell.count
      ? `${cell.count} commit${cell.count === 1 ? '' : 's'} on ${label}`
      : `No commits on ${label}`;
    rect.appendChild(title);
    svg.appendChild(rect);
  });

  return svg;
}

function renderBitbucketLegend() {
  const wrap = document.createElement('div');
  wrap.className = 'bb-legend';
  const less = document.createElement('span');
  less.textContent = 'Less';
  wrap.appendChild(less);
  for (let level = 0; level <= 4; level++) {
    const swatch = document.createElement('span');
    swatch.className = `bb-swatch bb-level-${level}`;
    wrap.appendChild(swatch);
  }
  const more = document.createElement('span');
  more.textContent = 'More';
  wrap.appendChild(more);
  return wrap;
}

function bitbucketWhoLabel() {
  const who = bitbucketGraph?.who;
  if (!who) return bitbucketTarget ? `@${bitbucketTarget}` : 'you';
  const name = who.displayName || who.username || bitbucketTarget;
  return who.unresolved ? `${name} (matched by name, not a confirmed account)` : name;
}

function renderBitbucketGraph() {
  bbSummaryEl.replaceChildren();
  bbGraphEl.replaceChildren();

  if (!bitbucketGraph) return;

  if (!bitbucketGraph.configured) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const big = document.createElement('div');
    big.className = 'big';
    big.textContent = '⚙';
    empty.appendChild(big);
    const p = document.createElement('p');
    p.textContent = 'Bitbucket is not configured yet.';
    empty.appendChild(p);
    const p2 = document.createElement('p');
    p2.textContent = 'Open Settings and add your workspace, email and an API token.';
    empty.appendChild(p2);
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Open Settings';
    btn.addEventListener('click', () => chrome.runtime.openOptionsPage());
    empty.appendChild(btn);
    bbGraphEl.appendChild(empty);
    return;
  }

  if (bitbucketGraph.status === 'idle' || !bitbucketGraph.status) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const p = document.createElement('p');
    p.textContent = 'Not checked yet.';
    empty.appendChild(p);
    const p2 = document.createElement('p');
    p2.textContent = 'Scanning a workspace can be slow, so this only runs when you ask for it.';
    empty.appendChild(p2);
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Scan now';
    btn.addEventListener('click', () => loadBitbucketGraph(true));
    empty.appendChild(btn);
    bbGraphEl.appendChild(empty);
    return;
  }

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = `Commits by ${bitbucketWhoLabel()} in the last ${BB_WEEKS} weeks`;
  const value = document.createElement('span');
  value.className = 'value';
  value.textContent = String(bitbucketGraph.total || 0);
  bbSummaryEl.appendChild(label);
  bbSummaryEl.appendChild(value);

  if (bitbucketGraph.status === 'running') {
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = bitbucketGraph.fetchedAt
      ? `Refreshing in the background… ${bitbucketGraph.scanned || 0}/${bitbucketGraph.totalRepos || '?'} repos`
      : `Scanning… ${bitbucketGraph.scanned || 0}/${bitbucketGraph.totalRepos || '?'} repos`;
    bbSummaryEl.appendChild(sub);
  }

  bbGraphEl.appendChild(renderBitbucketGraphSvg(bitbucketGraph.days || {}));
  bbGraphEl.appendChild(renderBitbucketLegend());
}

function bitbucketStatusLine() {
  if (!bitbucketGraph || !bitbucketGraph.configured) return 'Not configured';
  if (bitbucketGraph.status === 'error') return 'Could not load Bitbucket activity.';
  if (bitbucketGraph.status === 'running') {
    return bitbucketGraph.fetchedAt
      ? `Refreshing in the background… ${bitbucketGraph.scanned || 0}/${bitbucketGraph.totalRepos || '?'} so far`
      : `Scanning repos… ${bitbucketGraph.scanned || 0}/${bitbucketGraph.totalRepos || '?'} so far`;
  }
  if (bitbucketGraph.fetchedAt) {
    return `Checked ${relativeTime(bitbucketGraph.fetchedAt)} · ${bitbucketGraph.repoCount || bitbucketGraph.scanned || 0} repos scanned`;
  }
  return 'Not checked yet';
}

function refreshBitbucketBanner() {
  const errors = bitbucketGraph?.errors || [];
  bannerEl.hidden = !errors.length;
  bannerEl.textContent = errors.map((e) => (e.repo ? `${e.repo}: ${e.message}` : e.message)).join('\n');
}

/** Opening/switching to the tab: show whatever's cached, never start a scan. */
async function peekBitbucketGraph() {
  try {
    bitbucketGraph = await send({ type: 'bitbucketGraphPeek', target: bitbucketTarget });
    renderBitbucketGraph();
    refreshBitbucketBanner();
    statusEl.textContent = bitbucketStatusLine();
  } catch (err) {
    bannerEl.hidden = false;
    bannerEl.textContent = err.message;
    statusEl.textContent = 'Could not load Bitbucket activity.';
  }
}

/** Explicit ask — the Refresh button, "Scan now", or submitting a target to view. */
async function loadBitbucketGraph(force = false) {
  if (bitbucketGraph && !force && bitbucketGraph.status !== 'running'
      && bitbucketGraph.target === bbNormalizeTarget(bitbucketTarget)) {
    renderBitbucketGraph();
    return;
  }
  statusEl.textContent = 'Checking…';
  try {
    bitbucketGraph = await send({ type: 'bitbucketGraph', target: bitbucketTarget, force });
    renderBitbucketGraph();
    refreshBitbucketBanner();
    statusEl.textContent = bitbucketStatusLine();
  } catch (err) {
    bannerEl.hidden = false;
    bannerEl.textContent = err.message;
    statusEl.textContent = 'Could not load Bitbucket activity.';
  }
}

function bbNormalizeTarget(target) {
  const trimmed = String(target || '').trim();
  return trimmed ? trimmed.toLowerCase() : 'me';
}

ttSortEl.addEventListener('change', () => {
  ttSort = ttSortEl.value;
  renderTimeTracking();
  send({ type: 'saveSettings', patch: { timeTrackingSort: ttSort } }).catch(() => {});
});

const bbTargetForm = document.getElementById('bbTargetForm');
const bbTargetInput = document.getElementById('bbTargetInput');

bbTargetForm.addEventListener('submit', (e) => {
  e.preventDefault();
  bitbucketTarget = bbTargetInput.value.trim();
  loadBitbucketGraph();
});

// While a scan is running, the background worker snapshots progress after
// every repo — pick those up live instead of waiting for one long response.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.bitbucketGraphStates || tab !== 'bitbucket') return;
  const key = bbNormalizeTarget(bitbucketTarget);
  const state = changes.bitbucketGraphStates.newValue?.[key];
  if (!state) return;
  bitbucketGraph = { configured: true, target: key, ...state };
  renderBitbucketGraph();
  refreshBitbucketBanner();
  statusEl.textContent = bitbucketStatusLine();
});

// ---------------------------------------------------------------------------

async function load() {
  inbox = await send({ type: 'inbox' });
  if (tab === 'mentions') render();
}

const TAB_TITLES = { mentions: 'Mentions', timetracking: 'Time Tracking', bitbucket: 'Bitbucket' };

function setTab(next) {
  tab = next;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('is-active', b.dataset.tab === next);

  const isMentions = next === 'mentions';
  const isTimeTracking = next === 'timetracking';
  const isBitbucket = next === 'bitbucket';
  pageTitleEl.textContent = TAB_TITLES[next] || 'Mentions';
  filtersEl.hidden = !isMentions;
  markAllBtn.hidden = !isMentions;
  listEl.hidden = !isMentions;
  ttViewEl.hidden = !isTimeTracking;
  bbViewEl.hidden = !isBitbucket;
  bannerEl.hidden = true;

  if (isMentions) render();
  else if (isTimeTracking) loadTimeTracking();
  else if (isBitbucket) peekBitbucketGraph();
}

document.getElementById('refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    if (tab === 'mentions') {
      inbox = await send({ type: 'sync' });
      render();
    } else if (tab === 'timetracking') {
      await loadTimeTracking(true);
    } else {
      await loadBitbucketGraph(true);
    }
  } catch (err) {
    bannerEl.hidden = false;
    bannerEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
});

markAllBtn.addEventListener('click', async () => {
  inbox = await send({ type: 'markAllRead' });
  render();
});

document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  setTab(btn.dataset.tab);
});

filtersEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  filter = chip.dataset.filter;
  for (const c of document.querySelectorAll('.chip')) c.classList.toggle('is-active', c === chip);
  render();
});

// Reflect background updates while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.mentions || changes.syncState)) load();
});

load();
