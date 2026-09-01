# Mentions Only — Jira & Confluence

A Chrome extension that gives you one list: **the comments that actually @-mention you.**
No "issue transitioned", no "sprint started", no watcher spam, no digests.

Two more tabs ride along, since they read the same accounts: a **Time Tracking** view of
your current sprint's logged time, and a **Bitbucket** commit-activity heatmap.

Runs entirely on your machine. No build step, no dependencies, no telemetry, no remote code.

---

## Install (unpacked, local)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder (`jira-tools`)
4. The Options page opens automatically. Add your site URL — e.g. `https://your-company.atlassian.net` — and click **Test**, then **Add site**.
5. Pin the extension. The badge shows your unread mention count.

There is nothing to compile. `npm test` runs the mention-detection test suite; it is not needed to use the extension.

---

## How it finds mentions

Deliberately **not** by scraping the notification bell or its undocumented internal API — that feed *is* the bloat, and private endpoints break without warning. Instead:

**Confluence** — CQL has a first-class field for this, so it is exact by construction:

```
mention = currentUser() and lastmodified >= "<date>" order by lastmodified desc
```

**Jira** — JQL has no mention field, so it runs in two stages:

1. **Narrow.** `updated >= -Nd AND text ~ "<your display name>"` gathers candidate issues.
2. **Verify.** Each candidate's comments are fetched and their ADF (Atlassian Document Format) body is walked for a `mention` node whose `attrs.id` is **exactly your `accountId`**.

Stage 2 is the whole point. A colleague typing your name in prose does not survive it. Neither does a different account that happens to share your display name. See [tests/mentions.test.mjs](tests/mentions.test.mjs) — those are the first two test cases.

Because verification is exact, stage 1 is free to be sloppy. That is why the **name variants** box in Options is safe: extra search terms can only ever surface *more true* mentions, never a false one.

Issues whose `updated` timestamp has not moved since the last check are skipped, so steady-state polling is cheap.

### Known limitation

Stage 1 depends on Jira's text index containing your display name. If someone @-mentions you on an issue where your name appears nowhere in the indexed text, that mention can be missed. In practice a mention renders as `@Your Name` and is indexed, but this is a heuristic narrowing step and worth knowing about. Confluence has no such caveat. Widening **Look back (days)** or adding name variants both help.

---

## Authentication

**Browser session (default).** Requests reuse the cookies you already have from being logged in to Atlassian. Nothing is stored anywhere.

If your Atlassian tenant hands out session cookies that are not `SameSite=None`, extension-origin requests will not carry them and you will see *"you are most likely signed out"* even while logged in. That is what the second option is for.

**API token.** Create one at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens), paste it with your account email in Options. It is stored in this extension's local storage on this machine and sent only to your own site, over HTTPS, in an `Authorization: Basic` header. Switching back to session mode erases it. Revoke it from your Atlassian profile at any time.

Either way the token/session is read-only in effect: the extension only ever issues `GET` requests.

---

## Security & privacy properties

These are structural, not promises — you can check each one:

| Property | Where to verify |
| --- | --- |
| No telemetry or analytics of any kind | `grep -rniE "analytics\|telemetry\|gtag\|sentry\|posthog\|googleapis\|cdn\.\|unpkg" src/` returns only the line that *claims* it — no such code exists |
| The only network destinations are sites you configured, plus `api.bitbucket.org` if you set up the commit heatmap | `grep -rn "fetch(" src/` finds exactly two call sites — `AtlassianClient.request` in [src/lib/api.js](src/lib/api.js), whose URL is built from `this.origin`, and `BitbucketClient.request` in [src/lib/bitbucketApi.js](src/lib/bitbucketApi.js), which only ever talks to `api.bitbucket.org` |
| Read-only | both of those methods hardcode `method: 'GET'` |
| No remote code, no CDN, no eval | CSP in [manifest.json](manifest.json) pins `script-src 'self'`; no `<script src="http…">` anywhere |
| Other people's comment text is never treated as HTML | the popup builds DOM with `createElement` / `textContent` only; Confluence's HTML excerpts go through `htmlToText` first |
| Minimal permissions | `storage` + `alarms`. `notifications` is optional and requested only if you tick the box |
| No content scripts | nothing is injected into any page you visit |
| Narrow host access | `https://*.atlassian.net/*` and `https://api.bitbucket.org/*` only; any other host (Data Center, custom domains) must be granted by you, per-site, at the moment you add it |
| Everything is local | `chrome.storage.local`; **Reset all settings** in Options wipes it |

No dependencies means no supply chain: `package.json` has zero `dependencies` and zero `devDependencies`.

---

## Using it

- **Badge** — unread mention count.
- **Popup** — newest first, filterable by All / Unread / Jira / Confluence. Your `@Name` is highlighted inside each excerpt, and the excerpt is centred on the mention rather than the top of a long comment.
- **Click a card** to expand the full excerpt; **Open** jumps straight to the comment anchor and marks it read.
- **Dismiss** hides an item locally. It does not touch anything in Jira or Confluence — nothing here ever writes to Atlassian.
- **Refresh** checks immediately; otherwise it polls on your configured interval (default 5 min).

Errors surface as a red banner in the popup instead of failing silently — signed out, rate-limited, and site-unreachable each say so plainly.

### Time Tracking tab

Sums the Jira **Time Tracking** field (logged time) across every issue assigned to you in each configured site's current sprint, and lists those tickets.

```
assignee = currentUser() AND sprint in openSprints()
```

- Duration is formatted the way Jira's own Time Tracking field is (8-hour day, 5-day week) — e.g. `1d 2h`.
- **Sort by**, in the tab itself, switches the list between most-recently-done first (default) and most-time-logged first.
- Only tickets with logged time (`timeSpentSeconds > 0`) are listed; the total still reflects everyone else at zero.
- This is a live, on-demand read, not something the background poller collects — it's fetched when you open the tab and on **Refresh**, since sprint scope is small and "right now" is what matters.
- Requires Jira Software (boards/sprints). A project without an active sprint, or a plain Jira Work Management project with no board, surfaces as a banner rather than an error.
- **Sprint hours target**, in Options, is what you're comparing logged time against; lower it for a sprint with time off in it. Tick **Automatically reset the sprint hours target** to snap it back to the default (65h) whenever Jira reports a new active sprint, instead of carrying over a dialled-down value into the next one.

### Bitbucket tab

A GitHub-profile-style commit-activity heatmap — 53 weeks of green squares — for a Bitbucket Cloud workspace. Bitbucket has no equivalent of GitHub's per-user contribution feed, so this builds one: it lists every repo in the configured workspace, then pages through each repo's default-branch commit history looking for commits authored by the account you're viewing.

- Configure a **workspace**, an Atlassian account **email**, and an **API token** (scoped with `read:repository:bitbucket` and `read:account:bitbucket` — app passwords are deprecated) in Options.
- The tab shows your own activity by default; type any other Bitbucket **username** in the field at the top to view theirs instead.
- Optionally list specific **repo slugs** in Options to limit the scan. Strongly recommended — Bitbucket's commits endpoint can't filter by author server-side, so an unscoped scan of a busy workspace pages through everyone's history before it can filter down to one person, which is slow and can trip Bitbucket's rate limit.
- A completed scan is cached for 30 minutes; **Refresh** (or switching to a different username) forces a new one. While a scan runs, whatever heatmap was already on screen stays put — only a progress readout ("scanned N of M repos") updates live — so opening the tab never blanks it out.
- Requests to `api.bitbucket.org` are throttled to a few per second and back off automatically on HTTP 429.

---

## Layout

```
manifest.json               MV3 manifest
src/background.js           service worker: alarm-driven polling, message router
src/lib/api.js              Atlassian REST client (GET only), auth, bounded concurrency
src/lib/adf.js              ADF walking: mention verification, excerpting, HTML stripping
src/lib/sync.js             the collector — narrow-then-verify for Jira, CQL for Confluence,
                            plus the Time Tracking query
src/lib/store.js            chrome.storage.local persistence, read/dismiss state, badge
src/lib/settings.js         defaults and origin normalisation
src/lib/bitbucketApi.js     Bitbucket Cloud REST client (GET only), throttling, 429 backoff
src/lib/bitbucketGraph.js   commit-heatmap scan: per-target state, caching, stale-while-revalidate
src/popup.*                 the inbox / time tracking / bitbucket UI
src/options.*               settings UI
tests/mentions.test.mjs     mention-detection tests (node tests/mentions.test.mjs)
```

## Multiple sites

Add as many as you like; they are polled together and each card is tagged with its host. Sites outside `*.atlassian.net` (Data Center, custom domains) trigger a one-time Chrome permission prompt when you add them.
