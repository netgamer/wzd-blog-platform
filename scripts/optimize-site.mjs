import { readdir, readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || join(root, 'public'));
const cache = join(root, '.cache', 'responsive-v1');
const generated = new Map();
await mkdir(join(output, 'images', 'responsive'), { recursive: true });
await mkdir(cache, { recursive: true });
sharp.concurrency(2);

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'images') yield* files(path); }
    else if (entry.name.endsWith('.html')) yield path;
  }
}

function localPath(url) {
  try {
    const parsed = new URL(url, 'https://news.wzd.kr');
    const pathname = decodeURIComponent(parsed.pathname);
    if (parsed.hostname !== 'news.wzd.kr' || !pathname.startsWith('/images/') || !/\.(png|jpe?g)$/i.test(pathname)) return null;
    const path = resolve(output, '.' + pathname);
    if (relative(output, path).startsWith('..')) return null;
    return { path, pathname };
  } catch { return null; }
}

async function variants(source) {
  if (generated.has(source.path)) return generated.get(source.path);
  const data = await readFile(source.path);
  const meta = await sharp(data).metadata();
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 20);
  const widths = [...new Set([320, 640, 960, 1280, Math.min(1600, meta.width)].filter(width => width <= meta.width))].sort((a, b) => a - b);
  const items = [];
  for (const width of widths) {
    const name = `${hash}-${width}.webp`;
    const cached = join(cache, name);
    try { await access(cached); }
    catch { await sharp(data).resize({ width, withoutEnlargement: true }).webp({ quality: 85, effort: 4 }).toFile(cached); }
    await copyFile(cached, join(output, 'images', 'responsive', name));
    items.push({ width, url: `/images/responsive/${name}` });
  }
  const result = { width: meta.width, height: meta.height, items };
  generated.set(source.path, result);
  return result;
}

let count = 0;
for await (const path of files(output)) {
  const html = await readFile(path, 'utf8');
  const $ = load(html);
  let changed = false;
  for (const element of $('img[src]').toArray()) {
    const img = $(element);
    const source = localPath(img.attr('src'));
    if (!source) continue;
    let image;
    try { image = await variants(source); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const detail = img.closest('.post-content').length > 0;
    const hero = img.closest('.post-hero, .lead-story-image').length > 0;
    const preferred = detail ? 1600 : hero ? 1280 : 640;
    const selected = image.items.find(item => item.width >= preferred) || image.items.at(-1);
    img.attr({
      src: selected.url,
      srcset: image.items.map(item => `${item.url} ${item.width}w`).join(', '),
      sizes: detail ? '(max-width: 900px) 100vw, 850px' : hero ? '(max-width: 768px) 100vw, 900px' : '(max-width: 600px) 50vw, 320px',
      width: image.width, height: image.height, decoding: 'async', 'data-original-src': source.pathname
    });
    changed = true;
  }
  if (changed) { await writeFile(path, $.html()); count++; }
}
// Search cards use compact images too; they are loaded only when searching/filtering.
for (const path of [join(output, 'posts', 'index.json'), join(output, 'index.json')]) {
  let posts;
  try { posts = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (!Array.isArray(posts)) continue;
  for (const post of posts) {
    const source = localPath(post.image);
    if (!source) continue;
    try { const image = await variants(source); post.image = (image.items.find(item => item.width >= 640) || image.items.at(-1)).url; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(path, JSON.stringify(posts));
}
console.log(JSON.stringify({ optimizedPages: count, sourceImages: generated.size }));
