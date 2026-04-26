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

// --- Telegram Notification ---
const TELEGRAM_BOT_TOKEN = '8714352426:AAEwgv61r2Rb9GM2NqejO14IclpDyBb8MU8';
const TELEGRAM_CHAT_ID = '876899791';

async function notifyTelegram(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
  } catch (e) {
    console.warn('[telegram] Notification failed:', e.message);
  }
}
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
  const searchSuffix = CATEGORIES[getCurrentCategory()]?.searchSuffix || '2026 총정리';
  const urls = await searchWeb(`${topic} ${searchSuffix}`);

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

// --- 3 Content Categories (rotate hourly) ---

const CATEGORIES = {
  // 카테고리 1: 정책/뉴스 (이재명정부, 새 정책, 정치 이슈)
  policy: {
    name: '정책·뉴스',
    keywords: [
      '이재명 정부', '새 정책', '국정과제', '국회', '대통령',
      '교육부', '국방부', '외교부', '법무부', '행정안전부',
      '디지털 뉴딜', '탄소중립', '저출산 대책', '부동산 정책',
      '최저임금', '공공주택', '지방자치', '규제 완화', '공정경제'
    ],
    trendTerms: ['정부', '정책', '대통령', '국회', '장관', '법안', '개혁', '예산', '선거'],
    searchSuffix: '정부 정책 뉴스 2026',
    systemPrompt: `한국 정부 정책과 시사 뉴스를 쉽고 객관적으로 전달하는 기자형 블로거입니다.
- 객관적 팩트 중심 서술, 찬반 의견 균형있게 소개
- 정책의 배경, 주요 내용, 국민 영향을 체계적으로 정리
- 표와 타임라인 활용`
  },

  // 카테고리 2: 지원금/세금/혜택 (시민이 받을 수 있는 것들)
  benefits: {
    name: '지원금·혜택',
    keywords: [
      '근로장려금', '자녀장려금', '연말정산', '종합소득세', '경정청구',
      '실업급여', '청년도약계좌', '청년월세지원', '출산지원금', '육아휴직',
      '건강보험료', '국민연금', '기초연금', '주거급여', '에너지바우처',
      '소상공인 지원', '전세대출', '주택청약', '교육급여', '긴급복지',
      '소득공제', '세액공제', '월세공제', '의료비공제', '카드공제'
    ],
    trendTerms: ['지원금', '환급', '신청', '보험', '연금', '대출', '공제', '급여', '세금', '수당'],
    searchSuffix: '신청방법 조건 금액 2026',
    systemPrompt: `한국 정부의 지원금/세금/혜택 제도를 친근하고 상세하게 안내하는 전문 블로거입니다.
- 신청 대상, 자격 조건, 금액을 표로 정리
- 온라인 신청 단계를 5단계로 상세히 설명
- "이런 분이 받을 수 있어요" 식의 친근한 안내
- 꿀팁과 주의사항 포함`
  },

  // 카테고리 3: 생활정보/명소/계절 (데이트, 가족나들이, 계절명소)
  lifestyle: {
    name: '생활·명소',
    keywords: [],  // 월별로 동적 생성
    trendTerms: ['명소', '축제', '여행', '맛집', '카페', '데이트', '캠핑', '공원', '해수욕장', '드라이브'],
    searchSuffix: '추천 명소 가볼만한곳 2026',
    systemPrompt: `한국 생활정보, 여행, 명소를 생생하게 소개하는 라이프스타일 블로거입니다.
- 구체적인 장소명, 주소, 운영시간, 입장료 포함
- "이런 분에게 추천" 섹션 (데이트, 가족, 혼자 등)
- 사진 포인트, 주차 정보, 맛집 팁 포함
- 계절감 있는 생동감 있는 묘사`
  }
};

// 월별 생활 키워드 (계절에 맞는 콘텐츠)
function getLifestyleKeywords() {
  const month = new Date().getMonth() + 1;
  const seasonal = {
    1:  ['겨울 여행지', '스키장 추천', '온천 명소', '새해 일출 명소', '실내 데이트'],
    2:  ['발렌타인 데이트', '매화 명소', '실내 놀거리', '겨울 축제', '눈꽃 명소'],
    3:  ['봄꽃 명소', '벚꽃 개화시기', '봄나들이', '졸업여행', '등산 코스 추천'],
    4:  ['벚꽃 명소', '철쭉 명소', '봄 데이트', '아이와 갈만한곳', '공원 피크닉'],
    5:  ['어린이날 가볼만한곳', '어버이날 선물', '장미축제', '계곡 명소', '봄 캠핑'],
    6:  ['여름 물놀이', '계곡 추천', '해수욕장 개장', '수국 명소', '워터파크'],
    7:  ['해수욕장 추천', '여름 휴가지', '물놀이 명소', '여름 캠핑', '바다 드라이브'],
    8:  ['피서지 추천', '계곡 물놀이', '해외여행 대안', '여름 맛집', '빙수 맛집'],
    9:  ['가을 단풍', '코스모스 명소', '억새 명소', '가을 축제', '가을 데이트'],
    10: ['단풍 명소', '가을 드라이브', '핑크뮬리', '할로윈 행사', '가을 캠핑'],
    11: ['단풍 끝물', '겨울 준비', '김장 시기', '수능 응원', '초겨울 여행'],
    12: ['크리스마스 데이트', '연말 여행', '겨울 축제', '눈 오는 명소', '스키장 오픈']
  };
  return seasonal[month] || seasonal[4];
}

// Google Trends
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

// Find topic matching category
function findTopicForCategory(trends, category) {
  const cat = CATEGORIES[category];

  // Lifestyle: use seasonal keywords
  if (category === 'lifestyle') {
    cat.keywords = getLifestyleKeywords();
  }

  // 1. Match trends to category keywords
  for (const trend of trends) {
    for (const kw of cat.keywords) {
      if (trend.includes(kw) || kw.includes(trend)) {
        return { topic: trend, source: 'google-trends', category, matchedKeyword: kw };
      }
    }
  }

  // 2. Match trends to general terms
  for (const trend of trends) {
    for (const term of cat.trendTerms) {
      if (trend.includes(term)) {
        return { topic: trend, source: 'google-trends-related', category, matchedKeyword: term };
      }
    }
  }

  // 3. Fallback to random keyword from category
  const keywords = category === 'lifestyle' ? getLifestyleKeywords() : cat.keywords;
  const kw = keywords[Math.floor(Math.random() * keywords.length)];
  return { topic: kw, source: 'keyword-fallback', category, matchedKeyword: kw };
}

// Get current category based on hour rotation
function getCurrentCategory() {
  const hour = new Date().getHours();
  const categories = ['policy', 'benefits', 'lifestyle'];
  return categories[hour % 3];
}

// --- API Routes ---

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', queue: queue.length, completed: completed.length });
});

// Get current Google Trends
app.get('/api/trends', async (req, res) => {
  const trends = await fetchGoogleTrendsKR();
  const category = getCurrentCategory();
  const match = findTopicForCategory(trends, category);
  res.json({ trends: trends.slice(0, 10), currentCategory: category, match, allTrends: trends });
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
    // Determine category (rotate or manual)
    const category = req.body.category || getCurrentCategory();
    const cat = CATEGORIES[category] || CATEGORIES.benefits;

    // Auto-select topic from Google Trends if not provided
    let topicTitle = topic;
    let topicSource = 'manual';

    if (!topicTitle) {
      console.log(`[generate] Category: ${cat.name} (${category})`);
      console.log('[generate] Fetching Google Trends KR...');
      const trends = await fetchGoogleTrendsKR();
      const match = findTopicForCategory(trends, category);
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

    const systemPrompt = `${cat.systemPrompt}
존댓말 사용. 전문용어는 괄호 설명. 표(테이블) 활용. 마크다운 ##부터 시작.
구체적인 수치/날짜/장소 포함. 최대한 길고 상세하게 작성.`;

    // Category-specific part prompts
    const partPrompts = {
      policy: {
        part1: `1. 정책/뉴스의 배경과 맥락 (3문단 이상)
2. 주요 내용 정리 - 핵심 포인트 5가지
3. 국민에게 미치는 영향 - 긍정적/부정적 측면`,
        part2: `1. 전문가 의견 및 분석
2. 향후 전망과 일정
3. 관련 정책 비교 (표로 정리)
4. 시민이 알아야 할 점 5가지
5. 자주 묻는 질문(FAQ) 5개

**FAQ는 반드시 아래 형식으로 작성:**
**Q: 질문내용?**

A: 답변내용.`
      },
      benefits: {
        part1: `1. 제도/정책의 개요와 목적 (3문단 이상)
2. 신청 대상 및 자격 조건 - 표로 정리 (소득기준, 나이, 가구 등)
3. 지원 금액 또는 혜택 상세 - 표로 정리 (항목별 금액)`,
        part2: `1. 신청 방법 - 온라인 (1단계~5단계 상세히) + 오프라인 방법
2. 신청 기간 및 일정 (월별 정리)
3. 주의사항 및 꿀팁 (5개 이상)
4. 자주 묻는 질문(FAQ) 5개

**FAQ는 반드시 아래 형식으로 작성:**
**Q: 질문내용?**

A: 답변내용.`
      },
      lifestyle: {
        part1: `1. 소개 및 왜 지금 가야 하는지 (계절감 있게, 3문단)
2. 추천 명소 TOP 5~7곳 - 각 명소별 (이름, 위치, 특징, 입장료, 운영시간)
3. 명소별 추천 대상 표 (데이트/가족/혼자/친구)`,
        part2: `1. 방문 꿀팁 (주차, 혼잡시간, 준비물 등 5가지 이상)
2. 주변 맛집/카페 추천 3곳
3. 추천 코스 (반나절/하루 코스)
4. 주의사항 (날씨, 예약 등)
5. 자주 묻는 질문(FAQ) 5개

**FAQ는 반드시 아래 형식으로 작성:**
**Q: 질문내용?**

A: 답변내용.`
      }
    };

    const prompts = partPrompts[category] || partPrompts.benefits;

    const part1 = await generateWithGroq(systemPrompt,
      `주제: ${topicTitle}

참고 자료:
${research.text.slice(0, 2500)}

위 자료를 바탕으로 블로그 포스트의 전반부를 작성하세요:
${prompts.part1}

각 섹션을 최대한 상세하게 작성. 프론트매터 없이 본문만.`
    );

    await new Promise(r => setTimeout(r, 3000));

    console.log(`[generate] Writing post part 2...`);
    const part2 = await generateWithGroq(systemPrompt,
      `주제: ${topicTitle}

참고 자료:
${research.text.slice(0, 2500)}

블로그 포스트의 후반부를 작성하세요:
${prompts.part2}

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

    // 5. Telegram notification
    notifyTelegram(`📝 *새 블로그 발행*\n\n제목: ${job.title}\n카테고리: ${job.blogSlug}\n파일: ${job.postFilename}\n시간: ${new Date().toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})}`);

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

    // Notify
    notifyTelegram(`📝 *새 블로그 발행*\n\n제목: ${job.title}\n이미지: ✅ ChatGPT 생성\n시간: ${new Date().toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})}`);

    return true;

  } catch (e) {
    console.error('[cdp] Error:', e.message);
    notifyTelegram(`⚠️ *이미지 생성 실패*\n\n제목: ${job.title}\n에러: ${e.message}\n\n→ Chrome Extension으로 수동 처리 필요`);
    return false;
  }
}

// --- Hourly Scheduler ---

let schedulerRunning = false;

async function hourlyTask() {
  const now = new Date();
  const kstHour = (now.getUTCHours() + 9) % 24;
  const category = getCurrentCategory();
  const catName = CATEGORIES[category]?.name || category;

  console.log(`\n[cron] ===== ${now.toISOString()} (KST ${kstHour}시) [${catName}] 자동 포스트 생성 =====`);

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
  const category = getCurrentCategory();
  const catName = CATEGORIES[category]?.name || category;
  res.json({
    running: schedulerRunning,
    schedule: '24/7 매시간',
    currentCategory: `${catName} (${category})`,
    nextCategories: [0,1,2].map(i => {
      const h = (new Date().getHours() + i) % 24;
      const c = ['policy','benefits','lifestyle'][h % 3];
      return `${h}시: ${CATEGORIES[c].name}`;
    }),
    completed: completed.length
  });
});

// --- Notification endpoint (for Claude Code manager reports) ---
app.post('/api/notify', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  notifyTelegram(message);
  res.json({ success: true });
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
