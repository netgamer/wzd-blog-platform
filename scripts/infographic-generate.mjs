#!/usr/bin/env node
/**
 * HTML Infographic Image Generator
 * Reads blog post → AI extracts key info → Renders HTML infographic → PNG screenshot
 *
 * Usage: node scripts/infographic-generate.mjs <blog_id> [post_filename]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);

// Load .env.local
const envPath = join(PROJECT_ROOT, '.env.local');
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  });
}

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// --- AI: Extract infographic data from post ---

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function extractInfographicData(title, content, topic, retries = 3) {
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
          {
            role: 'system',
            content: `블로그 포스트를 분석해서 인포그래픽용 데이터를 JSON으로 추출해. 반드시 아래 형식을 따라.
JSON만 출력. 다른 텍스트 없이.

{
  "badge": "카테고리 (2-4글자, 예: 세금환급, 실업급여)",
  "title": "인포그래픽 제목 (20자 이내, 핵심만)",
  "subtitle": "부제 설명 (30자 이내)",
  "cards": [
    {
      "icon": "이모지 1개",
      "title": "카드 제목 (8자 이내)",
      "items": ["항목1 (15자 이내)", "항목2", "항목3"],
      "accent": false
    },
    {
      "icon": "이모지 1개",
      "title": "카드 제목",
      "items": ["항목1", "항목2", "항목3"],
      "accent": false
    },
    {
      "icon": "이모지 1개",
      "title": "카드 제목",
      "items": ["항목1", "항목2", "항목3"],
      "accent": true
    }
  ],
  "flow": [
    {"icon": "이모지", "text": "단계1 (4자 이내)"},
    {"icon": "이모지", "text": "단계2"},
    {"icon": "이모지", "text": "단계3"},
    {"icon": "이모지", "text": "단계4", "active": true}
  ],
  "source": "출처 (예: 국세청, 고용노동부)"
}`
          },
          {
            role: 'user',
            content: `주제: ${topic}\n제목: ${title}\n\n본문:\n${content.slice(0, 2000)}`
          }
        ],
        temperature: 0.3,
        max_tokens: 1500
      })
    });

    if (res.status === 429) {
      console.warn(`Rate limited, waiting ${(attempt + 1) * 15}s...`);
      await sleep((attempt + 1) * 15000);
      continue;
    }

    if (!res.ok) throw new Error(`Groq API error: ${res.status}`);

    const data = await res.json();
    const text = data.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('No JSON in response');
  }
  throw new Error('Max retries exceeded');
}

// --- Render HTML infographic ---

function buildInfographicHTML(data) {
  const template = readFileSync(join(__dirname, 'templates', 'infographic.html'), 'utf-8');

  // Build cards HTML
  const cardsHTML = data.cards.map(card => `
    <div class="info-card${card.accent ? ' accent' : ''}">
      <div class="card-icon">${card.icon}</div>
      <div class="card-title">${card.title}</div>
      <ul class="card-list">
        ${card.items.map(item => `<li>${item}</li>`).join('\n        ')}
      </ul>
    </div>
  `).join('\n');

  // Build flow HTML
  const flowHTML = data.flow.map((step, i) => {
    const arrow = i < data.flow.length - 1 ? '<span class="flow-arrow">→</span>' : '';
    return `<div class="flow-step${step.active ? ' active' : ''}">
      <span class="step-icon">${step.icon}</span> ${step.text}
    </div>${arrow}`;
  }).join('\n    ');

  return template
    .replace('{{BADGE}}', data.badge)
    .replace('{{TITLE}}', data.title)
    .replace('{{SUBTITLE}}', data.subtitle)
    .replace('{{SOURCE}}', `출처: ${data.source} | ${new Date().getFullYear()}`)
    .replace('<!-- Cards injected by script -->', cardsHTML)
    .replace('<!-- Flow steps injected by script -->', flowHTML)
    .replace('연말정산 가이드', data.blogName || '정책 가이드');
}

// --- Capture PNG ---

async function captureScreenshot(html, outputPath) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630 });
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

  // Wait for font to load
  await page.evaluate(() => document.fonts.ready);
  await new Promise(r => setTimeout(r, 500));

  await page.screenshot({
    path: outputPath,
    type: 'png',
    clip: { x: 0, y: 0, width: 1200, height: 630 }
  });

  await browser.close();
  console.log(`Screenshot saved: ${outputPath}`);
}

// --- Main ---

async function main() {
  const blogId = process.argv[2];
  if (!blogId) {
    console.error('Usage: node scripts/infographic-generate.mjs <blog_id> [post_filename]');
    process.exit(1);
  }

  const registry = JSON.parse(readFileSync(join(PROJECT_ROOT, 'data', 'blog-registry.json'), 'utf-8'));
  const blogConfig = registry.blogs.find(b => b.id === blogId);
  if (!blogConfig) {
    console.error(`Blog not found: ${blogId}`);
    process.exit(1);
  }

  const postsDir = join(PROJECT_ROOT, 'sites', blogConfig.slug, 'content', 'posts');
  const imagesDir = join(PROJECT_ROOT, 'sites', blogConfig.slug, 'static', 'images');
  mkdirSync(imagesDir, { recursive: true });

  let postFiles;
  if (process.argv[3]) {
    postFiles = [process.argv[3]];
  } else {
    postFiles = readdirSync(postsDir).filter(f => f.endsWith('.md'));
  }

  for (const filename of postFiles) {
    const filepath = join(postsDir, filename);
    let content = readFileSync(filepath, 'utf-8');

    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    const fm = fmMatch[1];
    const titleMatch = fm.match(/title:\s*"(.+?)"/);
    const title = titleMatch?.[1] || filename;
    const postBody = content.slice(content.indexOf('---', 4) + 4);

    const slug = filename.replace('.md', '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
    const imgFilename = `${slug}.png`;
    const imgPath = join(imagesDir, imgFilename);

    console.log(`\n--- Processing: ${filename}`);
    console.log(`Title: ${title}`);

    try {
      // 1. AI가 포스트 내용 분석 → 인포그래픽 데이터 추출
      console.log('Extracting infographic data via AI...');
      const infographicData = await extractInfographicData(title, postBody, blogConfig.topic);
      infographicData.blogName = blogConfig.name;

      console.log('Data:', JSON.stringify(infographicData, null, 2));

      // 2. HTML 렌더링
      const html = buildInfographicHTML(infographicData);

      // 3. Puppeteer로 PNG 캡처
      console.log('Capturing screenshot...');
      await captureScreenshot(html, imgPath);

      // 4. 포스트 frontmatter 업데이트
      const newImage = `/images/${imgFilename}`;
      content = content.replace(/image:\s*".*?"/, `image: "${newImage}"`);
      writeFileSync(filepath, content, 'utf-8');
      console.log(`Updated ${filename} → image: ${newImage}`);

    } catch (err) {
      console.error(`Failed for ${filename}:`, err.message);
    }

    await sleep(3000);
  }

  console.log('\nAll done!');
}

main();
