import { mentionsAccount, mentionIds, toPlainText, excerptAroundMention, htmlToText } from '../src/lib/adf.js';
import { quoteLiteral, mapLimit } from '../src/lib/api.js';

const ME = '5b10a2844c20165700ede21g';
const OTHER = '712020:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const p = (...content) => ({ type: 'paragraph', content });
const t = (text) => ({ type: 'text', text });
const men = (id, text) => ({ type: 'mention', attrs: { id, text } });
const doc = (...content) => ({ type: 'doc', version: 1, content });

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};

console.log('mention verification');
check('real mention of me is detected',
  mentionsAccount(doc(p(men(ME, '@Shaheer Aamir'), t(' can you look at this?'))), ME), true);

check('my name typed as plain prose is NOT a mention',
  mentionsAccount(doc(p(t('Shaheer Aamir said we should ship it, @here'))), ME), false);

check('someone else mentioned is NOT my mention',
  mentionsAccount(doc(p(men(OTHER, '@Shaheer Aamir'), t(' (a different account, same display name)'))), ME), false);

check('nested mention deep in a table/list is found',
  mentionsAccount(doc({
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('owner: '), men(ME, '@Shaheer Aamir'))] }] },
    ] }] }],
  }), ME), true);

check('empty / malformed docs do not throw',
  [mentionsAccount(null, ME), mentionsAccount({}, ME), mentionsAccount(doc(), ME)], [false, false, false]);

check('missing accountId never matches',
  mentionsAccount(doc(p(men(ME, '@Me'))), undefined), false);

check('all mention ids collected', mentionIds(doc(p(men(ME, '@A'), men(OTHER, '@B'), men(ME, '@A')))), [ME, OTHER]);

console.log('text extraction');
check('plain text flattens mentions and blocks',
  toPlainText(doc(p(t('Hi '), men(ME, '@Shaheer Aamir'), t(',')), p(t('please review.')))),
  'Hi @Shaheer Aamir,\nplease review.');

const long = doc(
  p(t('x'.repeat(400))),
  p(t('Hey '), men(ME, '@Shaheer Aamir'), t(' the staging deploy is red, can you take a look before standup?')),
  p(t('y'.repeat(400))),
);
const ex = excerptAroundMention(long, ME);
check('excerpt is centred on my mention, not the top of the comment',
  [ex.includes('@Shaheer Aamir'), ex.includes('staging deploy is red'), ex.startsWith('…'), ex.endsWith('…'), ex.length < 400],
  [true, true, true, true, true]);

check('excerpt falls back gracefully when I am not mentioned',
  excerptAroundMention(doc(p(t('nothing here'))), ME), 'nothing here');

console.log('confluence excerpt sanitising');
check('html excerpt is stripped to text',
  htmlToText('<p>Hi <b>@Shaheer</b> &amp; team<br/>see <a href="#">this</a></p>'),
  'Hi @Shaheer & team\nsee this');
check('script tags cannot survive as markup',
  htmlToText('<script>alert(1)</script>hello'), 'alert(1)hello');

console.log('jql literal escaping');
check('quotes and backslashes escaped', quoteLiteral('O\'Neil "the \\ boss"'), '"O\'Neil \\"the \\\\ boss\\""');

console.log('concurrency helper');
const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
  if (n === 3) throw new Error('boom');
  return n * 10;
});
check('mapLimit preserves order and isolates failures',
  out.map((r) => (r && r.__error ? 'ERR' : r)), [10, 20, 'ERR', 40, 50]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
