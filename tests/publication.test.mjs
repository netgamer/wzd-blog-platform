import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublisher, readState, writeState, verifyPublication, digest, telegramText } from '../scripts/publication.mjs';

function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'wzd-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'state.json'); }
async function finish(publisher) { while (publisher.jobs.some(job => ['queued', 'deploying', 'verifying'].includes(job.status))) await new Promise(resolve => setTimeout(resolve, 5)); }
test('Telegram keeps UTM underscores and the full URL unchanged', () => {
  const text = '기사 https://news.wzd.kr/posts/test/?utm_source=telegram&utm_medium=social&utm_campaign=auto_post';
  assert.equal(telegramText(text), text);
  assert.equal(new URL(text.split(' ')[1]).searchParams.get('utm_source'), 'telegram');
});
test('push failure cannot become published or notify', async t => {
  let notifications = 0;
  const p = createPublisher({ statePath: fixture(t), deploy: async () => { throw new Error('push rejected'); }, onPublished: () => notifications++ });
  p.enqueue({ id: 'a' }); await finish(p);
  assert.equal(p.jobs[0].status, 'failed'); assert.equal(notifications, 0);
});
test('waits for actual deployment and notifies only after verification', async t => {
  let attempts = 0; let notifications = 0;
  const path = fixture(t);
  const p = createPublisher({ statePath: path, deploy: async () => 'abc', attempts: 3, delay: 0, verify: async () => { if (++attempts < 3) throw new Error('HTTP 404'); }, onPublished: () => notifications++ });
  p.enqueue({ id: 'a' }); await finish(p);
  assert.equal(p.jobs[0].status, 'published'); assert.equal(notifications, 1);
  assert.equal(readState(path, [])[0].notification, 'sent');
  const restored = createPublisher({ statePath: path, deploy: async () => { throw new Error('must not redeploy'); }, onPublished: () => notifications++ });
  await restored.drain(); assert.equal(notifications, 1);
});
test('unfinished verification resumes after restart without recommitting', async t => {
  const path = fixture(t);
  writeState(path, [{ id: 'a', status: 'verifying', revision: 'abc' }]);
  const p = createPublisher({ statePath: path, deploy: async () => { throw new Error('must not commit'); }, verify: async () => {} });
  await p.drain(); assert.equal(p.jobs[0].status, 'published');
});
test('verification timeout remains failed and can be retried', async t => {
  let valid = false;
  const p = createPublisher({ statePath: fixture(t), attempts: 1, deploy: async () => 'abc', verify: async () => { if (!valid) throw new Error('image missing'); } });
  p.enqueue({ id: 'a' }); await finish(p); assert.equal(p.jobs[0].status, 'failed');
  valid = true; p.retry('a'); await finish(p); assert.equal(p.jobs[0].status, 'published');
});
test('atomic state roundtrip retains an explicit stopped scheduler', t => {
  const path = fixture(t); const state = { schedulerRunning: false, queue: [{ id: 1 }], completed: [{ id: 2 }] };
  writeState(path, state); assert.deepEqual(readState(path, {}), state);
});
test('live verifier checks revision, title, canonical and the exact original image', async () => {
  const bytes = Buffer.from('image fixture');
  const job = { revision: 'abc', url: 'https://news.wzd.kr/posts/test/', title: 'Test', assets: [{ url: '/images/test.png', hash: digest(bytes) }] };
  let badImage = false;
  const fetcher = async url => url.includes('build-revision') ? new Response('abc') : url.includes('/images/') ? new Response(badImage ? 'wrong' : bytes) : new Response('<h1>Test</h1><link rel="canonical" href="https://news.wzd.kr/posts/test/"><img src="/images/small.webp" data-original-src="/images/test.png">');
  await verifyPublication(job, { fetcher }); badImage = true;
  await assert.rejects(verifyPublication(job, { fetcher }), /Image is not deployed/);
  await assert.rejects(verifyPublication(job, { fetcher: async () => new Response('old') }), /revision/);
});
