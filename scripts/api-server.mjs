#!/usr/bin/env node
/**
 * Blog Automation API Server
 *
 * Flow:
 * 1. POST /api/generate → creates post + queues image request
 * 2. Chrome Extension polls GET /api/queue → picks up pending image jobs
 * 3. Extension generates image via ChatGPT → POST /api/upload with image
 * 4. Server saves image, updates post, builds Hugo, pushes to GitHub
 */

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = '\\\\wsl$\\Ubuntu\\home\\netgamer\\.openclaw\\workspace\\code\\wzd-blog-platform';
const PROJECT_ROOT_WSL = '/home/netgamer/.openclaw/workspace/code/wzd-blog-platform';
const PORT = 3456;

// Load .env.local
const envPath = join(PROJECT_ROOT, '.env.local');
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  });
}

const app = express();
app.use(cors());
app.use(express.json());

// Image upload storage
const upload = multer({ storage: multer.memoryStorage() });

// --- Queue ---
const queue = [];     // pending image jobs
const completed = []; // completed jobs

// --- Registry ---
function getRegistry() {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, 'data', 'blog-registry.json'), 'utf-8'));
}

// --- Groq Content Generation ---
async function generateWithGroq(systemPrompt, userPrompt) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');

  for (let attempt = 0; attempt < 3; attempt++) {
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
        max_tokens: 8000
      })
    });

    if (res.status === 429) {
      await new Promise(r => setTimeout(r, (attempt + 1) * 15000));
      continue;
    }
    if (!res.ok) throw new Error(`Groq error: ${res.status}`);

    const data = await res.json();
    return data.choices[0].message.content;
  }
  throw new Error('Groq: max retries');
}

// --- Web Research ---

async function searchWeb(query, numResults = 5) {
  console.log(`[research] Searching: ${query}`);
  try {
    // DuckDuckGo HTML search (no API key needed)
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + ' 신청 방법 조건 2026')}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000)
    });
    const html = await res.text();

    // Extract result URLs
    const urls = [...html.matchAll(/href="\/\/duckduckgo\.com\/l\/\?uddg=(.*?)&/g)]
      .map(m => decodeURIComponent(m[1]))
      .filter(u => u.startsWith('http'))
      .slice(0, numResults);

    console.log(`[research] Found ${urls.length} URLs`);
    return urls;
  } catch (e) {
    console.warn('[research] Search failed:', e.message);
    // Fallback: Google search via scraping
    try {
      const gUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=ko&num=5`;
      const gRes = await fetch(gUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000)
      });
      const gHtml = await gRes.text();
      const gUrls = [...gHtml.matchAll(/href="\/url\?q=(.*?)&/g)]
        .map(m => decodeURIComponent(m[1]))
        .filter(u => u.startsWith('http') && !u.includes('google.com'))
        .slice(0, numResults);
      console.log(`[research] Google fallback: ${gUrls.length} URLs`);
      return gUrls;
    } catch {
      return [];
    }
  }
}

async function fetchPageContent(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    const html = await res.text();

    // Strip HTML tags, get text content
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000); // limit per page

    return { url, text, success: true };
  } catch (e) {
    return { url, text: '', success: false, error: e.message };
  }
}

async function researchTopic(topic) {
  console.log(`[research] Researching: ${topic}`);

  // Search for related articles
  const urls = await searchWeb(`${topic} 2026 신청방법 조건 금액`);

  // Fetch content from top results
  const results = await Promise.all(
    urls.slice(0, 5).map(url => fetchPageContent(url))
  );

  const successResults = results.filter(r => r.success && r.text.length > 200);
  console.log(`[research] Fetched ${successResults.length}/${urls.length} pages`);

  // Combine research material
  const researchText = successResults
    .map((r, i) => `[출처 ${i + 1}] ${r.url}\n${r.text.slice(0, 2000)}`)
    .join('\n\n---\n\n');

  return {
    sources: successResults.map(r => r.url),
    text: researchText,
    count: successResults.length
  };
}

// --- Google Trends ---

const POLICY_KEYWORDS = [
  '종합소득세', '연말정산', '실업급여', '청년정책', '근로장려금',
  '지원금', '문화의날', '근로자의날', '주택청약', '출산지원금',
  '경정청구', '세액공제', '소득공제', '청년도약계좌', '국민연금',
  '건강보험', '주거급여', '에너지바우처', '자녀장려금', '교육급여',
  '기초연금', '실업급여 신청', '청년월세', '전세대출', '부가가치세'
];

async function fetchGoogleTrendsKR() {
  try {
    const url = 'https://trends.google.com/trending/rss?geo=KR';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    const xml = await res.text();
    const titles = [...xml.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>/g)]
      .map(m => m[1])
      .filter(t => t !== 'Daily Search Trends');
    return titles.slice(0, 30);
  } catch (e) {
    console.warn('[trends] Google Trends fetch failed:', e.message);
    return [];
  }
}

function findPolicyTrend(trends) {
  // 1. Find trends matching policy keywords
  for (const trend of trends) {
    for (const kw of POLICY_KEYWORDS) {
      if (trend.includes(kw) || kw.includes(trend)) {
        return { topic: trend, source: 'google-trends', matchedKeyword: kw };
      }
    }
  }
  // 2. Check for general policy-related terms
  const policyTerms = ['세금', '환급', '신청', '지원', '보험', '연금', '대출', '공제', '급여', '정책'];
  for (const trend of trends) {
    for (const term of policyTerms) {
      if (trend.includes(term)) {
        return { topic: trend, source: 'google-trends-related', matchedKeyword: term };
      }
    }
  }
  // 3. Fallback to random keyword
  const kw = POLICY_KEYWORDS[Math.floor(Math.random() * POLICY_KEYWORDS.length)];
  return { topic: kw, source: 'keyword-fallback', matchedKeyword: kw };
}

// --- API Routes ---

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', queue: queue.length, completed: completed.length });
});

// Get current Google Trends
app.get('/api/trends', async (req, res) => {
  const trends = await fetchGoogleTrendsKR();
  const policyMatch = findPolicyTrend(trends);
  res.json({ trends: trends.slice(0, 10), policyMatch, allTrends: trends });
});

// List available blogs
app.get('/api/blogs', (req, res) => {
  const registry = getRegistry();
  res.json(registry.blogs.map(b => ({ id: b.id, name: b.name, topic: b.topic, enabled: b.enabled })));
});

// Generate a new blog post + queue image request
app.post('/api/generate', async (req, res) => {
  const { blogId, topic } = req.body;
  const registry = getRegistry();
  const blogConfig = registry.blogs.find(b => b.id === (blogId || 'policy-guide'));

  if (!blogConfig) return res.status(404).json({ error: 'Blog not found' });

  try {
    // Auto-select topic from Google Trends if not provided
    let topicTitle = topic;
    let topicSource = 'manual';

    if (!topicTitle) {
      console.log('[generate] Fetching Google Trends KR...');
      const trends = await fetchGoogleTrendsKR();
      const match = findPolicyTrend(trends);
      topicTitle = match.topic;
      topicSource = match.source;
      console.log(`[generate] Topic from ${topicSource}: ${topicTitle} (matched: ${match.matchedKeyword})`);
    }

    // 1. Web Research - 관련 기사 5개 검색 + 내용 수집
    console.log(`[generate] Researching: ${topicTitle}`);
    const research = await researchTopic(topicTitle);
    console.log(`[generate] Research done: ${research.count} sources collected`);

    await new Promise(r => setTimeout(r, 2000));

    // 2. Generate blog post in TWO parts for longer content
    console.log(`[generate] Writing post part 1 with ${research.count} sources...`);

    const systemPrompt = `당신은 한국 정부 정책을 전문적이면서도 쉽게 설명하는 블로그 전문 작가입니다.
존댓말 사용. 전문용어는 괄호 설명. 표(테이블) 활용. 마크다운 ##부터 시작.
구체적 금액/날짜/비율 포함. 최대한 길고 상세하게 작성.`;

    const part1 = await generateWithGroq(systemPrompt,
      `주제: ${topicTitle}

참고 자료:
${research.text.slice(0, 2500)}

위 자료를 바탕으로 블로그 포스트의 전반부를 작성하세요:
1. 제도/정책의 개요와 목적 (3문단 이상)
2. 신청 대상 및 자격 조건 - 표로 정리 (소득기준, 나이, 가구 등)
3. 지원 금액 또는 혜택 상세 - 표로 정리 (항목별 금액)

각 섹션을 최대한 상세하게 작성. 프론트매터 없이 본문만.`
    );

    await new Promise(r => setTimeout(r, 3000));

    console.log(`[generate] Writing post part 2...`);
    const part2 = await generateWithGroq(systemPrompt,
      `주제: ${topicTitle}

참고 자료:
${research.text.slice(0, 2500)}

블로그 포스트의 후반부를 작성하세요:
1. 신청 방법 - 온라인 (1단계~5단계 상세히) + 오프라인 방법
2. 신청 기간 및 일정 (월별 정리)
3. 주의사항 및 꿀팁 (5개 이상)
4. 자주 묻는 질문(FAQ) 5개 (Q&A 형식)

각 섹션을 최대한 상세하게 작성. 프론트매터 없이 본문만.`
    );

    const content = part1 + '\n\n' + part2;
    console.log(`[generate] Total content: ${content.length} chars`);

    await new Promise(r => setTimeout(r, 3000));

    // 3. Generate title
    const title = await generateWithGroq(
      'SEO 제목 생성기. 제목만 출력. 따옴표 없이.',
      `다음 글의 SEO 최적화 제목 1개 (25-45자, 핵심 키워드 포함): ${content.slice(0, 500)}`
    );
    const cleanTitle = title.trim().replace(/^["']|["']$/g, '').replace(/^\d+\.\s*/, '');

    await new Promise(r => setTimeout(r, 2000));

    // 4. Generate excerpt
    const excerpt = await generateWithGroq(
      '요약 생성기. 2-3문장 요약만 출력.',
      `2-3문장으로 핵심 요약: ${content.slice(0, 1000)}`
    );

    // 2. Create slug and filename
    const date = new Date().toISOString().split('T')[0];
    const slug = cleanTitle.toLowerCase().replace(/[^\w\s가-힣-]/g, '').replace(/\s+/g, '-').slice(0, 50);
    const filename = `${date}-${slug}.md`;
    const imageFilename = `${slug}.png`;

    // 3. Prepare post content (DO NOT save yet - wait for image)
    const frontmatter = `---
title: "${cleanTitle.replace(/"/g, '\\"')}"
date: ${date}
description: "${excerpt.trim().replace(/"/g, '\\"')}"
categories: ["${blogConfig.topic}"]
tags: [${blogConfig.keywords.slice(0, 5).map(t => `"${t}"`).join(', ')}]
author: "${blogConfig.name}"
image: "/images/${imageFilename}"
---`;

    const postContent = `${frontmatter}\n\n${content}\n`;
    console.log(`[generate] Post prepared (NOT saved yet, waiting for image): ${filename}`);

    // 4. Create image prompt
    const imagePrompt = `한국 ${blogConfig.topic} 관련 "${cleanTitle}" 주제의 인포그래픽 이미지를 만들어줘.
깔끔하고 현대적인 카드뉴스 스타일, 파란색과 흰색 중심의 컬러 팔레트.
핵심 내용을 3-4개 카드/단계로 시각화. 각 단계에 아이콘 포함.
한국 정부 정책 안내 인포그래픽 느낌. 가로 16:9 비율. 1200x630 사이즈.`;

    // 5. Queue image job (post content stored in memory until image is ready)
    const job = {
      id: Date.now().toString(),
      blogId: blogConfig.id,
      blogSlug: blogConfig.slug,
      postFilename: filename,
      postContent,
      imageFilename,
      imagePrompt,
      title: cleanTitle,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    queue.push(job);

    console.log(`[queue] Image job queued: ${job.id}`);
    res.json({ success: true, job, post: { filename, title: cleanTitle } });

  } catch (err) {
    console.error('[generate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Chrome Extension polls this for pending jobs
app.get('/api/queue', (req, res) => {
  const pending = queue.filter(j => j.status === 'pending');
  res.json(pending);
});

// Chrome Extension uploads completed image
app.post('/api/upload', upload.single('image'), (req, res) => {
  const { jobId } = req.body;
  const job = queue.find(j => j.id === jobId);

  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!req.file) return res.status(400).json({ error: 'No image file' });

  try {
    // 1. Save image
    const imagesDir = join(PROJECT_ROOT, 'sites', job.blogSlug, 'static', 'images');
    mkdirSync(imagesDir, { recursive: true });
    const imagePath = join(imagesDir, job.imageFilename);
    writeFileSync(imagePath, req.file.buffer);
    console.log(`[upload] Image saved: ${imagePath} (${(req.file.buffer.length / 1024).toFixed(0)}KB)`);

    // 2. NOW save the post (only after image is ready)
    const postsDir = join(PROJECT_ROOT, 'sites', job.blogSlug, 'content', 'posts');
    mkdirSync(postsDir, { recursive: true });
    writeFileSync(join(postsDir, job.postFilename), job.postContent, 'utf-8');
    console.log(`[upload] Post saved: ${job.postFilename}`);

    // 3. Update job status
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    delete job.postContent; // free memory
    completed.push(job);

    // 4. Deploy (post + image together)
    console.log(`[upload] Deploying post + image together...`);
    deployBlog(job.blogSlug);

    res.json({ success: true, message: 'Post + image saved and deployed' });
  } catch (err) {
    console.error('[upload] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manual deploy trigger
app.post('/api/deploy', (req, res) => {
  const { blogId } = req.body;
  try {
    deployBlog(blogId || 'tax-yearend');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get job status
app.get('/api/jobs', (req, res) => {
  res.json({ pending: queue.filter(j => j.status === 'pending'), completed });
});

// --- Deploy ---
function deployBlog(blogSlug) {
  console.log(`[deploy] Building and pushing ${blogSlug}...`);
  try {
    execSync(`wsl -- bash -c "export PATH=\\$HOME/.nvm/versions/node/v25.8.2/bin:\\$PATH && cd ${PROJECT_ROOT_WSL} && git add -A && git commit -m 'post: auto-generated for ${blogSlug}' && git push"`, {
      stdio: 'pipe',
      timeout: 60000
    });
    console.log(`[deploy] Pushed to GitHub. GitHub Actions will build and deploy.`);
  } catch (err) {
    console.log(`[deploy] Git push result:`, err.stdout?.toString().slice(0, 200) || err.message);
  }
}

// --- CDP Image Generation (ChatGPT via Chrome) ---

async function generateImageViaCDP(job) {
  const { WebSocket } = await import('ws');
  const CDP_URL = 'http://localhost:18800';

  try {
    // Check Chrome is running
    const tabsRes = await fetch(`${CDP_URL}/json`);
    const tabs = await tabsRes.json();
    const tab = tabs.find(t => t.url.includes('chatgpt.com'));
    if (!tab) {
      console.log('[cdp] No ChatGPT tab found. Open Chrome with ChatGPT.');
      return false;
    }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

    const cdpCmd = (method, params = {}) => new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 999999);
      const h = (data) => { const msg = JSON.parse(data.toString()); if (msg.id === id) { ws.removeListener('message', h); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); } };
      ws.on('message', h);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { ws.removeListener('message', h); reject(new Error('CDP timeout')); }, 30000);
    });

    const ev = async (expr) => {
      const r = await cdpCmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r.result?.value;
    };

    await cdpCmd('Runtime.enable');

    // Navigate to new chat
    console.log('[cdp] Opening new ChatGPT conversation...');
    await cdpCmd('Page.navigate', { url: 'https://chatgpt.com/' });
    await new Promise(r => setTimeout(r, 5000));

    const before = await ev(`document.querySelectorAll('img').length`);

    // Type prompt
    const escaped = job.imagePrompt.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    await ev(`(() => { const el = document.querySelector('#prompt-textarea') || document.querySelector('[contenteditable]'); if (!el) return 'no input'; el.focus(); el.innerHTML = \`<p>${escaped}</p>\`; el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await new Promise(r => setTimeout(r, 1500));

    // Send
    await ev(`(() => { const btn = document.querySelector('[data-testid="send-button"]') || document.querySelector('button[aria-label*="Send"]'); if (btn) { btn.click(); return 'ok'; } return 'no btn'; })()`);
    console.log('[cdp] Prompt sent, waiting for image...');

    // Wait for image (max 3 min)
    let imageFound = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const count = await ev(`document.querySelectorAll('img').length`);
      if (count > before) { imageFound = true; await new Promise(r => setTimeout(r, 3000)); break; }
    }

    if (!imageFound) { ws.close(); console.log('[cdp] No image generated'); return false; }

    // Extract via canvas
    const base64 = await ev(`(async () => { const imgs = document.querySelectorAll('img'); let t = null; for (const img of imgs) { if (img.naturalWidth > 200 && !img.src.includes('avatar') && !img.src.includes('icon')) t = img; } if (!t) return null; if (!t.complete) await new Promise(r => { t.onload = r; setTimeout(r, 5000); }); const c = document.createElement('canvas'); c.width = t.naturalWidth; c.height = t.naturalHeight; c.getContext('2d').drawImage(t, 0, 0); return c.toDataURL('image/png').split(',')[1]; })()`);

    ws.close();

    if (!base64 || base64.length < 100) { console.log('[cdp] Failed to extract image'); return false; }

    // Save image
    const buf = Buffer.from(base64, 'base64');
    const imagesDir = join(PROJECT_ROOT, 'sites', job.blogSlug, 'static', 'images');
    mkdirSync(imagesDir, { recursive: true });
    writeFileSync(join(imagesDir, job.imageFilename), buf);
    console.log(`[cdp] Image saved: ${job.imageFilename} (${(buf.length / 1024).toFixed(0)}KB)`);

    // Save post
    const postsDir = join(PROJECT_ROOT, 'sites', job.blogSlug, 'content', 'posts');
    mkdirSync(postsDir, { recursive: true });
    writeFileSync(join(postsDir, job.postFilename), job.postContent, 'utf-8');
    console.log(`[cdp] Post saved: ${job.postFilename}`);

    // Update job
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    delete job.postContent;
    completed.push(job);

    // Deploy
    deployBlog(job.blogSlug);
    return true;

  } catch (e) {
    console.error('[cdp] Error:', e.message);
    return false;
  }
}

// --- Hourly Scheduler ---

let schedulerRunning = false;
const PUBLISH_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]; // KST

async function hourlyTask() {
  const now = new Date();
  const kstHour = (now.getUTCHours() + 9) % 24;

  if (!PUBLISH_HOURS.includes(kstHour)) {
    console.log(`[cron] ${kstHour}시 - 발행 시간 아님 (${PUBLISH_HOURS.join(',')}시에 발행)`);
    return;
  }

  console.log(`\n[cron] ===== ${now.toISOString()} (KST ${kstHour}시) 자동 포스트 생성 시작 =====`);

  try {
    // 1. Generate post
    const genRes = await fetch(`http://localhost:${PORT}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const genData = await genRes.json();

    if (!genData.success) {
      console.error('[cron] Post generation failed:', genData.error);
      return;
    }

    console.log(`[cron] Post generated: "${genData.post.title}"`);

    // 2. Generate image via CDP
    const pendingJob = queue.find(j => j.id === genData.job.id);
    if (pendingJob) {
      console.log('[cron] Generating image via ChatGPT CDP...');
      const imgResult = await generateImageViaCDP(pendingJob);
      if (imgResult) {
        console.log('[cron] ✅ Post + image published successfully!');
      } else {
        console.log('[cron] ⚠️ Image generation failed. Post queued for Chrome Extension.');
      }
    }

  } catch (e) {
    console.error('[cron] Error:', e.message);
  }

  console.log(`[cron] ===== 완료 =====\n`);
}

// Cron control endpoints
app.post('/api/cron/start', (req, res) => {
  if (schedulerRunning) return res.json({ message: 'Already running' });
  schedulerRunning = true;
  // Run every hour at :00
  const now = new Date();
  const msUntilNextHour = (60 - now.getMinutes()) * 60000 - now.getSeconds() * 1000;
  setTimeout(() => {
    hourlyTask();
    setInterval(hourlyTask, 60 * 60 * 1000); // every hour
  }, msUntilNextHour);
  console.log(`[cron] Scheduler started. Next run in ${Math.floor(msUntilNextHour / 60000)}분`);
  res.json({ success: true, message: `Scheduler started. Next run in ${Math.floor(msUntilNextHour / 60000)} min` });
});

app.post('/api/cron/stop', (req, res) => {
  schedulerRunning = false;
  res.json({ success: true, message: 'Scheduler stopped' });
});

app.post('/api/cron/run', async (req, res) => {
  res.json({ success: true, message: 'Running now...' });
  hourlyTask();
});

app.get('/api/cron/status', (req, res) => {
  res.json({ running: schedulerRunning, publishHours: PUBLISH_HOURS, completed: completed.length });
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Blog API Server running at http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /api/health       - Health check`);
  console.log(`  POST /api/generate     - Generate post + queue image`);
  console.log(`  GET  /api/queue        - Pending image jobs`);
  console.log(`  POST /api/upload       - Upload completed image`);
  console.log(`  POST /api/cron/start   - Start hourly scheduler`);
  console.log(`  POST /api/cron/stop    - Stop scheduler`);
  console.log(`  POST /api/cron/run     - Run now (manual trigger)`);
  console.log(`  GET  /api/cron/status  - Scheduler status`);
  console.log(`\n⏰ 매시간 자동: POST /api/cron/start`);
  console.log(`🔥 즉시 실행: POST /api/cron/run`);
});
