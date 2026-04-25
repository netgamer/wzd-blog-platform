#!/usr/bin/env node
/**
 * Korean Government Policy Blog Post Generator
 * Uses Groq API (free) for content generation
 * Sources: Google Trends KR RSS + Government RSS feeds
 *
 * Usage: node scripts/generate-post.mjs <blog_id>
 * Example: node scripts/generate-post.mjs tax-yearend
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);

// Load .env.local
const envPath = join(PROJECT_ROOT, '.env.local');
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) {
      process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  });
}

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error('Error: GROQ_API_KEY required. Get free key at https://console.groq.com');
  process.exit(1);
}

// Load blog registry
const registry = JSON.parse(readFileSync(join(PROJECT_ROOT, 'data', 'blog-registry.json'), 'utf-8'));

const blogId = process.argv[2];
if (!blogId) {
  console.error('Usage: node scripts/generate-post.mjs <blog_id>');
  console.error('Available blogs:', registry.blogs.map(b => b.id).join(', '));
  process.exit(1);
}

const blogConfig = registry.blogs.find(b => b.id === blogId);
if (!blogConfig) {
  console.error(`Blog not found: ${blogId}`);
  process.exit(1);
}

// --- Topic Discovery ---

async function fetchGoogleTrendsKR() {
  try {
    const url = 'https://trends.google.com/trending/rss?geo=KR';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const xml = await res.text();
    // Simple XML parsing for trend titles
    const titles = [...xml.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>/g)]
      .map(m => m[1])
      .filter(t => t !== 'Daily Search Trends');
    return titles.slice(0, 20);
  } catch (e) {
    console.warn('Google Trends fetch failed:', e.message);
    return [];
  }
}

async function fetchGovRSS(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    const xml = await res.text();
    const items = [...xml.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>|<title>(.+?)<\/title>/g)]
      .map(m => m[1] || m[2])
      .filter(t => t && !t.includes('<?xml'));
    return items.slice(0, 10);
  } catch (e) {
    console.warn(`RSS fetch failed (${url}):`, e.message);
    return [];
  }
}

async function discoverTopics() {
  console.log(`[${blogConfig.id}] Discovering topics...`);

  const [trends, ...govFeeds] = await Promise.all([
    fetchGoogleTrendsKR(),
    ...blogConfig.sources.map(url => fetchGovRSS(url))
  ]);

  // Filter trends relevant to this blog's keywords
  const relevantTrends = trends.filter(t =>
    blogConfig.keywords.some(kw => t.includes(kw) || kw.includes(t))
  );

  // Combine all sources
  const allTopics = [
    ...relevantTrends.map(t => ({ source: 'trend', title: t, priority: 3 })),
    ...govFeeds.flat().map(t => ({ source: 'gov', title: t, priority: 2 })),
    ...blogConfig.keywords.map(kw => ({ source: 'keyword', title: kw, priority: 1 }))
  ];

  return allTopics;
}

// --- Content Generation ---

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateWithGroq(systemPrompt, userPrompt, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 3000
      })
    });

    if (res.status === 429) {
      const waitSec = (attempt + 1) * 15;
      console.warn(`Rate limited, waiting ${waitSec}s (attempt ${attempt + 1}/${retries})...`);
      await sleep(waitSec * 1000);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  }
  throw new Error('Groq API: max retries exceeded');
}

async function generatePost(topic) {
  const systemPrompt = `당신은 한국 정부 정책을 쉽고 친근하게 설명하는 블로그 작가입니다.
다음 규칙을 따라 글을 작성하세요:

1. 반말이 아닌 "~합니다", "~세요" 같은 존댓말 사용
2. 전문 용어는 괄호로 쉬운 설명 추가
3. 실제 사례나 예시를 들어 이해를 도울 것
4. 신청 방법, 대상, 금액 등 실용적 정보 위주
5. 표(테이블)를 활용해 정보를 정리할 것
6. 마크다운 형식으로 작성 (# 제목은 사용하지 말고, ## 소제목부터 시작)
7. 글 마지막에 "마무리" 섹션으로 핵심 요약
8. 총 1500-2500자 분량

블로그 주제: ${blogConfig.topic}
블로그 타겟: ${blogConfig.demographic}`;

  const userPrompt = `다음 주제로 SEO에 최적화된 한국어 블로그 포스트를 작성해주세요.

주제: ${topic.title}
관련 키워드: ${blogConfig.keywords.join(', ')}

포스트에 포함할 내용:
- 정책/제도의 핵심 내용
- 신청 대상 및 조건
- 신청 방법 (온라인/오프라인)
- 주요 금액이나 혜택
- 주의사항이나 팁

마크다운으로 작성하되, 프론트매터(---)는 포함하지 마세요. 본문만 작성하세요.`;

  console.log(`[${blogConfig.id}] Generating post about: ${topic.title}`);
  const content = await generateWithGroq(systemPrompt, userPrompt);
  return content;
}

async function generateTitle(topic, content) {
  const prompt = `다음 블로그 글에 대해 SEO에 최적화된 제목을 1개만 작성하세요.
조건:
- 30-50자 사이
- 핵심 키워드 포함
- 클릭을 유도하는 제목
- 제목만 출력 (따옴표, 번호 없이)

주제: ${topic.title}
키워드: ${blogConfig.keywords.slice(0, 3).join(', ')}

본문 요약: ${content.slice(0, 300)}`;

  const title = await generateWithGroq('한국어 SEO 제목 생성기. 제목만 출력.', prompt);
  return title.trim().replace(/^["']|["']$/g, '').replace(/^\d+\.\s*/, '');
}

async function generateExcerpt(content) {
  const prompt = `다음 블로그 글의 핵심 내용을 2-3문장으로 요약하세요. 요약만 출력.

${content.slice(0, 1000)}`;

  const excerpt = await generateWithGroq('한국어 요약 생성기. 요약만 출력.', prompt);
  return excerpt.trim();
}

// --- Fact Check ---

async function factCheck(content, topic) {
  const checkPrompt = `당신은 한국 정부 정책 팩트체커입니다.
다음 블로그 글에서 사실 관계를 검증하세요.

확인 항목:
1. 날짜/기한이 정확한가? (현재 연도: ${new Date().getFullYear()})
2. 금액/비율이 합리적인가?
3. 신청 조건이 논리적인가?
4. 명백한 오류가 있는가?

글 주제: ${topic.title}

글 내용:
${content}

검증 결과를 JSON 형식으로 출력하세요:
{"confidence": 0.0-1.0, "issues": ["issue1", "issue2"], "corrections": ["correction1"]}
JSON만 출력하세요.`;

  try {
    const result = await generateWithGroq('팩트체커. JSON만 출력.', checkPrompt);
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.warn('Fact check parsing failed:', e.message);
  }
  return { confidence: 0.5, issues: ['팩트체크 파싱 실패'], corrections: [] };
}

// --- Output ---

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s가-힣-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/-$/, '');
}

function formatDate() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().split('T')[0];
}

function createFrontmatter(title, excerpt, topic) {
  const date = formatDate();
  const categories = [blogConfig.topic];
  const tags = blogConfig.keywords.slice(0, 5);
  if (topic.source === 'trend') tags.push('트렌드');

  return `---
title: "${title.replace(/"/g, '\\"')}"
date: ${date}
description: "${excerpt.replace(/"/g, '\\"')}"
categories: [${categories.map(c => `"${c}"`).join(', ')}]
tags: [${tags.map(t => `"${t}"`).join(', ')}]
author: "${blogConfig.name}"
image: ""
---`;
}

// --- Main ---

async function main() {
  try {
    // 1. Discover topics
    const topics = await discoverTopics();
    if (topics.length === 0) {
      console.error('No topics found');
      process.exit(1);
    }

    // Pick highest priority topic (with some randomization)
    topics.sort((a, b) => b.priority - a.priority);
    const topCandidates = topics.slice(0, 5);
    const topic = topCandidates[Math.floor(Math.random() * topCandidates.length)];

    // 2. Generate content
    const content = await generatePost(topic);

    // 3. Generate title and excerpt (sequential to avoid rate limit)
    await sleep(2000);
    const title = await generateTitle(topic, content);
    await sleep(2000);
    const excerpt = await generateExcerpt(content);

    // 4. Fact check
    const factResult = await factCheck(content, topic);
    console.log(`[${blogConfig.id}] Fact check: confidence=${factResult.confidence}`);
    if (factResult.issues?.length > 0) {
      console.log(`[${blogConfig.id}] Issues:`, factResult.issues);
    }

    if (factResult.confidence < 0.6) {
      console.warn(`[${blogConfig.id}] LOW CONFIDENCE (${factResult.confidence}) - flagging for review`);
      // In production: send Telegram notification via OpenClaw
    }

    // 5. Save post
    const date = formatDate();
    const slug = slugify(title);
    const filename = `${date}-${slug}.md`;
    const postsDir = join(PROJECT_ROOT, 'sites', blogConfig.slug, 'content', 'posts');

    if (!existsSync(postsDir)) {
      mkdirSync(postsDir, { recursive: true });
    }

    const frontmatter = createFrontmatter(title, excerpt, topic);
    const fullPost = `${frontmatter}\n\n${content}\n`;

    const filepath = join(postsDir, filename);
    writeFileSync(filepath, fullPost, 'utf-8');

    console.log(`[${blogConfig.id}] Post saved: ${filename}`);
    console.log(`[${blogConfig.id}] Title: ${title}`);
    console.log(`[${blogConfig.id}] Confidence: ${factResult.confidence}`);

    // Output for automation (JSON on last line)
    console.log(JSON.stringify({
      status: 'ok',
      blog: blogConfig.id,
      file: filename,
      title,
      confidence: factResult.confidence,
      topic: topic.title,
      source: topic.source
    }));

  } catch (error) {
    console.error(`[${blogConfig.id}] Error:`, error.message);
    process.exit(1);
  }
}

main();
