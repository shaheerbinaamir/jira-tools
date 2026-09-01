// Utilities for Atlassian Document Format (ADF) trees.
//
// The whole accuracy story of this extension rests here: a candidate is only
// treated as a mention if the ADF contains a `mention` node whose attrs.id is
// exactly your accountId. Text that merely happens to contain your name is not
// a mention, and is discarded.

const BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock',
  'panel', 'tableRow', 'taskItem', 'decisionItem', 'expand',
]);

/** Depth-first walk over every node in an ADF document. */
export function* walk(node) {
  if (!node || typeof node !== 'object') return;
  yield node;
  const kids = Array.isArray(node.content) ? node.content : [];
  for (const kid of kids) yield* walk(kid);
}

/** True if the doc contains an @-mention of `accountId`. */
export function mentionsAccount(doc, accountId) {
  if (!accountId) return false;
  for (const node of walk(doc)) {
    if (node.type === 'mention' && node.attrs && node.attrs.id === accountId) return true;
  }
  return false;
}

/** Every distinct mention node id present in the doc. */
export function mentionIds(doc) {
  const ids = new Set();
  for (const node of walk(doc)) {
    if (node.type === 'mention' && node.attrs && node.attrs.id) ids.add(node.attrs.id);
  }
  return [...ids];
}

/** Flatten an ADF doc to readable plain text. */
export function toPlainText(doc) {
  const out = [];
  (function emit(node) {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'text':
        out.push(node.text || '');
        return;
      case 'mention':
        out.push(node.attrs?.text || '@unknown');
        return;
      case 'emoji':
        out.push(node.attrs?.shortName || '');
        return;
      case 'hardBreak':
        out.push('\n');
        return;
      case 'inlineCard':
      case 'blockCard':
        out.push(node.attrs?.url || '[link]');
        return;
      case 'mediaSingle':
      case 'mediaGroup':
      case 'media':
        out.push('[attachment]');
        return;
      default:
        break;
    }
    const kids = Array.isArray(node.content) ? node.content : [];
    for (const kid of kids) emit(kid);
    if (BLOCK_TYPES.has(node.type)) out.push('\n');
  })(doc);

  return out.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A short excerpt centred on the first mention of `accountId`, so the popup
 * shows the sentence you were actually pulled into rather than the top of a
 * 40-line comment.
 */
export function excerptAroundMention(doc, accountId, radius = 260) {
  const text = toPlainText(doc);
  if (!accountId) return clamp(text, radius * 2);

  let needle = null;
  for (const node of walk(doc)) {
    if (node.type === 'mention' && node.attrs?.id === accountId) {
      needle = node.attrs.text || null;
      break;
    }
  }
  if (!needle) return clamp(text, radius * 2);

  const at = text.indexOf(needle);
  if (at === -1) return clamp(text, radius * 2);

  const start = Math.max(0, at - Math.floor(radius / 3));
  const end = Math.min(text.length, at + needle.length + radius);
  let slice = text.slice(start, end).trim();
  if (start > 0) slice = `…${slice}`;
  if (end < text.length) slice = `${slice}…`;
  return slice;
}

function clamp(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

/** Strip HTML (Confluence search excerpts come back as markup) to plain text. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
