import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export function readState(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function writeState(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  renameSync(temporary, path);
}

export const digest = data => createHash('sha256').update(data).digest('hex');
export const telegramText = message => String(message);

export async function verifyPublication(job, { fetcher = fetch, baseURL = 'https://news.wzd.kr' } = {}) {
  const options = { signal: AbortSignal.timeout(20000), cache: 'no-store' };
  const revision = await fetcher(`${baseURL}/build-revision.txt?verify=${job.revision}`, options);
  if (!revision.ok || (await revision.text()).trim() !== job.revision) throw new Error('Waiting for deployed revision');
  if (!job.url) return;
  const response = await fetcher(`${job.url}?verify=${job.revision}`, { ...options, signal: AbortSignal.timeout(20000) });
  if (job.deleted) {
    if (response.status !== 404) throw new Error('Waiting for article removal');
    return;
  }
  if (!response.ok) throw new Error(`Article HTTP ${response.status}`);
  const html = await response.text();
  const { load } = await import('cheerio');
  const $ = load(html);
  if ($('h1').first().text().trim() !== job.title) throw new Error('Published title does not match');
  if (decodeURI($('link[rel=canonical]').attr('href') || '') !== decodeURI(job.url)) throw new Error('Canonical does not match');
  for (const asset of job.assets || []) {
    const referenced = $('img').toArray().some(img => [$(img).attr('src'), $(img).attr('data-original-src')].some(src => {
      try { return decodeURI(new URL(src, baseURL).pathname) === decodeURI(asset.url); } catch { return false; }
    }));
    if (!referenced) throw new Error(`Article image is missing: ${asset.url}`);
    const image = await fetcher(`${baseURL}${encodeURI(asset.url)}?verify=${job.revision}`, { signal: AbortSignal.timeout(30000) });
    if (!image.ok || digest(Buffer.from(await image.arrayBuffer())) !== asset.hash) throw new Error(`Image is not deployed: ${asset.url}`);
  }
}

// A serialized queue prevents one article's git commit from absorbing another's changes.
export function createPublisher({ statePath, deploy, verify = verifyPublication, onPublished = async () => {}, onChange = () => {}, attempts = 60, delay = 15000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const jobs = readState(statePath, []);
  let draining = false;
  const save = () => { writeState(statePath, jobs); onChange(); };
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (const job of jobs.filter(item => ['queued', 'deploying', 'verifying'].includes(item.status))) {
        try {
          if (!job.revision) { job.status = 'deploying'; save(); job.revision = await deploy(job); }
          job.status = 'verifying'; save();
          let verified = false;
          for (let attempt = 0; attempt < attempts; attempt++) {
            try { await verify(job); verified = true; break; }
            catch (error) { job.detail = error.message; save(); if (attempt + 1 < attempts) await sleep(delay); }
          }
          if (!verified) throw new Error(job.detail || 'Deployment verification timed out');
          job.status = 'published'; job.completedAt = new Date().toISOString(); job.detail = ''; save();
          // Persist before sending: an ambiguous interrupted notification is never blindly duplicated.
          job.notification = 'sending'; save();
          try { await onPublished(job); job.notification = 'sent'; }
          catch (error) { job.notification = 'failed'; job.notificationError = error.message; }
          save();
        } catch (error) { job.status = 'failed'; job.error = error.message; job.completedAt = new Date().toISOString(); save(); }
      }
    } finally {
      draining = false;
      if (jobs.some(job => job.status === 'queued')) void drain();
    }
  }
  return {
    jobs, drain,
    enqueue(input) {
      const existing = jobs.find(job => job.id === input.id);
      if (existing) return existing;
      const job = { ...input, status: 'queued', createdAt: input.createdAt || new Date().toISOString() };
      jobs.push(job); save(); void drain(); return job;
    },
    retry(id) {
      const job = jobs.find(item => item.id === id);
      if (!job || job.status !== 'failed') throw new Error('Only a failed deployment can be retried');
      job.status = 'queued'; delete job.error; save(); void drain(); return job;
    }
  };
}
