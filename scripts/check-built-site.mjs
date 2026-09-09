import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { load } from 'cheerio';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const $ = load(html);
assert.equal($('.lead-story, .top-story, .home-latest .post-card').length, 14);
assert.equal($('.lazy-post').length, 0);
assert.ok(Buffer.byteLength(html) < 100000, 'Homepage HTML budget is 100KB');
assert.ok($('.home-pagination a').length > 0, 'Crawlable next page');
for (const path of ['/posts/page/2/', '/page/2/']) {
  const page = load(readFileSync(join(root, path, 'index.html'), 'utf8'));
  assert.equal(page('link[rel=canonical]').attr('href'), `https://news.wzd.kr${path}`);
}
for (const img of $('.home-newsdesk img').toArray()) {
  assert.ok($(img).attr('srcset'));
  assert.ok(existsSync(join(root, $(img).attr('src'))));
}
for (const link of $('.site-nav a').toArray()) {
  const url = new URL($(link).attr('href'), 'https://news.wzd.kr');
  assert.ok(existsSync(join(root, decodeURI(url.pathname), 'index.html')), `Broken navigation: ${url.pathname}`);
}
console.log(JSON.stringify({ homeBytes: Buffer.byteLength(html), homeCards: 14, canonical: 'passed', navigation: 'passed' }));
