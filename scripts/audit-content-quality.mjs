#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POSTS_DIR = join(ROOT, 'sites', 'tax-yearend', 'content', 'posts');
const IMAGES_DIR = join(ROOT, 'sites', 'tax-yearend', 'static', 'images');
const REPORT_PATH = join(ROOT, 'reports', 'content-quality-audit.md');
const APPLY_DUPLICATES = process.argv.includes('--apply-duplicates');
const PLACEHOLDER_PATTERN = /(?:확인\s*(?:이\s*)?불가|특정할\s*수\s*없|구체적(?:인)?\s*(?:장소|명소|상호|정보).*없|참고\s*자료(?:에서|에는)?.*(?:없|않))/gi;
const PREAMBLE_PATTERN = /^(?:요청하신|아래는|다음은|제공(?:해\s*주신|된)\s*(?:자료|참고\s*자료)|참고\s*자료를\s*바탕으로)/i;

function splitFrontmatter(text) {
  const match = String(text).match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!match) return { frontmatter: '', body: String(text), match: null };
  return {
    frontmatter: match[1],
    body: String(text).slice(match[0].length).trim(),
    match
  };
}

function parsePost(filename) {
  const path = join(POSTS_DIR, filename);
  const text = readFileSync(path, 'utf8');
  const { frontmatter, body } = splitFrontmatter(text);
  const field = name => frontmatter.match(new RegExp(`^${name}:\\s*["']?(.*?)["']?\\s*$`, 'mi'))?.[1]?.trim() || '';
  const image = field('image');
  const placeholderCount = (body.match(PLACEHOLDER_PATTERN) || []).length;
  PLACEHOLDER_PATTERN.lastIndex = 0;
  return {
    filename,
    path,
    text,
    title: field('title') || filename.replace(/\.md$/, ''),
    date: field('date'),
    image,
    draft: /^draft:\s*true\s*$/mi.test(frontmatter),
    bodyLength: body.replace(/\s+/g, ' ').length,
    placeholderCount,
    hasPreamble: PREAMBLE_PATTERN.test(body),
    missingImage: Boolean(image) && !existsSync(join(IMAGES_DIR, image.replace(/^\/images\//, '')))
  };
}

function markDraft(post) {
  if (post.draft) return false;
  const { frontmatter, body, match } = splitFrontmatter(post.text);
  if (!match) return false;
  const newline = match[0].includes('\r\n') ? '\r\n' : '\n';
  const cleanBody = body.replace(/^draft:\s*true\s*\r?\n(?=---\s*$)/gm, '');
  const updatedFrontmatter = `${frontmatter.replace(/\s+$/, '')}${newline}draft: true`;
  const opening = post.text.startsWith('\uFEFF') ? `\uFEFF---${newline}` : `---${newline}`;
  const updated = `${opening}${updatedFrontmatter}${newline}---${newline}${newline}${cleanBody.trimStart()}`;
  writeFileSync(post.path, updated, 'utf8');
  post.draft = true;
  return true;
}

const posts = readdirSync(POSTS_DIR).filter(name => name.endsWith('.md')).map(parsePost);
const published = posts.filter(post => !post.draft);
const byTitle = new Map();
for (const post of published) {
  if (!byTitle.has(post.title)) byTitle.set(post.title, []);
  byTitle.get(post.title).push(post);
}

const duplicateGroups = [...byTitle.entries()]
  .filter(([, group]) => group.length > 1)
  .map(([title, group]) => [title, group.sort((a, b) => `${b.date}|${b.filename}`.localeCompare(`${a.date}|${a.filename}`))]);

const drafted = [];
if (APPLY_DUPLICATES) {
  for (const [, group] of duplicateGroups) {
    for (const post of group.slice(1)) {
      if (markDraft(post)) drafted.push(post.filename);
    }
  }
}

const severe = published.filter(post => post.placeholderCount >= 5 || post.bodyLength < 1200 || post.missingImage);
const preambles = published.filter(post => post.hasPreamble);
const report = [
  '# 콘텐츠 품질 감사',
  '',
  `- 전체 Markdown: ${posts.length}개`,
  `- 공개 글: ${published.length}개`,
  `- 동일 제목 그룹: ${duplicateGroups.length}개`,
  `- 심각한 품질 경고: ${severe.length}개`,
  `- AI 답변형 서두: ${preambles.length}개`,
  `- 이번 실행에서 비공개 처리: ${drafted.length}개`,
  '',
  '## 동일 제목',
  '',
  ...duplicateGroups.flatMap(([title, group]) => [
    `### ${title}`,
    ...group.map((post, index) => `- ${index === 0 ? '유지' : post.draft ? '비공개' : '검토'}: ${post.filename}`),
    ''
  ]),
  '## 심각한 품질 경고',
  '',
  ...severe.map(post => `- ${post.filename}: 본문 ${post.bodyLength}자, 확인 불가 ${post.placeholderCount}건${post.missingImage ? ', 이미지 누락' : ''}`),
  '',
  '## AI 답변형 서두',
  '',
  ...preambles.map(post => `- ${post.filename}`),
  ''
].join('\n');

mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, report, 'utf8');
console.log(JSON.stringify({ total: posts.length, published: published.length, duplicateGroups: duplicateGroups.length, severe: severe.length, preambles: preambles.length, drafted: drafted.length, report: REPORT_PATH }, null, 2));
