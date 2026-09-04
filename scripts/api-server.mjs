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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { stripAssistantPreamble, validateArticleContent } from './content-quality.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = '\\\\wsl$\\Ubuntu\\home\\netgamer\\.openclaw\\workspace\\code\\wzd-blog-platform';

// --- Telegram Notification ---
const TELEGRAM_BOT_TOKEN = '8714352426:AAEwgv61r2Rb9GM2NqejO14IclpDyBb8MU8';
const TELEGRAM_CHAT_ID = '876899791';

async function notifyTelegram(message) {
  try {
    // Remove markdown formatting, use plain text for reliability
    const cleanMsg = message.replace(/\*/g, '').replace(/_/g, '');
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: cleanMsg
      })
    });
    const data = await res.json();
    if (!data.ok) console.warn('[telegram] Send failed:', data.description);
    else console.log('[telegram] Notification sent');
  } catch (e) {
    console.warn('[telegram] Notification failed:', e.message);
  }
}
const PROJECT_ROOT_WSL = '/home/netgamer/.openclaw/workspace/code/wzd-blog-platform';
const PORT = 3456;

function getKoreaDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getPublishedPostUrl(postFilename) {
  const slug = String(postFilename || '').replace(/\.md$/i, '');
  return `https://news.wzd.kr/posts/${encodeURIComponent(slug)}/`;
}

function findExistingPostByTitle(title) {
  const postsDir = join(PROJECT_ROOT, 'sites', 'tax-yearend', 'content', 'posts');
  if (!existsSync(postsDir)) return null;
  for (const filename of readdirSync(postsDir).filter(name => name.endsWith('.md'))) {
    const text = readFileSync(join(postsDir, filename), 'utf-8');
    if (/^draft:\s*true\s*$/mi.test(text)) continue;
    const match = text.match(/^title:\s*["']?(.*?)["']?\s*$/mi);
    if (match?.[1]?.trim() === title.trim()) return filename;
  }
  return null;
}

function generatedDeployPaths(blogSlug, postFilename, imageFilenames) {
  return [
    `sites/${blogSlug}/content/posts/${postFilename}`,
    ...imageFilenames.map(name => `sites/${blogSlug}/static/images/${name}`)
  ];
}

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

const adminDir = join(PROJECT_ROOT, 'sites', 'tax-yearend', 'static', 'admin');
app.use('/admin', express.static(adminDir));
app.use('/blog-images', express.static(join(PROJECT_ROOT, 'sites', 'tax-yearend', 'static', 'images')));
app.get('/dashboard', (req, res) => {
  res.redirect('/admin/');
});
app.get(['/admin', '/admin/'], (req, res) => {
  res.sendFile('index.html', { root: adminDir });
});

// Image upload storage
const upload = multer({ storage: multer.memoryStorage() });
const MIN_IMAGE_BYTES = 120 * 1024;
const MIN_IMAGE_WIDTH = 900;
const MIN_IMAGE_HEIGHT = 480;

function getImageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;

  const pngSig = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') === pngSig) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), type: 'png' };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), type: 'jpg' };
      }
      offset += 2 + length;
    }
  }

  return null;
}

function validateNewsImage(buffer) {
  const dimensions = getImageDimensions(buffer);
  if (!dimensions) {
    return { ok: false, reason: '이미지 크기를 확인할 수 없습니다.' };
  }
  if (dimensions.width < MIN_IMAGE_WIDTH || dimensions.height < MIN_IMAGE_HEIGHT) {
    return {
      ok: false,
      reason: `이미지가 너무 작습니다. 현재 ${dimensions.width}x${dimensions.height}, 최소 ${MIN_IMAGE_WIDTH}x${MIN_IMAGE_HEIGHT}`
    };
  }
  if (buffer.length < MIN_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `이미지 파일 용량이 너무 작습니다. 현재 ${(buffer.length / 1024).toFixed(0)}KB, 최소 ${MIN_IMAGE_BYTES / 1024}KB`
    };
  }
  return { ok: true, ...dimensions };
}

// --- Queue ---
const queue = [];     // pending image jobs
const textQueue = []; // pending ChatGPT text jobs
const completed = []; // completed jobs
const failed = [];    // failed jobs that must not be published
const imageGroups = new Map();

function removeFromQueue(job) {
  const idx = queue.findIndex(item => item.id === job.id);
  if (idx >= 0) queue.splice(idx, 1);
}

function insertArticleImages(content, slug, title) {
  const clean = content
    .replace(/<figure class="post-mid-image">[\s\S]*?<\/figure>/g, '')
    .replace(/<figure class="post-comic">[\s\S]*?<\/figure>/g, '')
    .trim();
  const lines = clean.split('\n');
  const midpoint = Math.floor(lines.length * 0.45);
  let insertAt = lines.findIndex((line, index) => index >= midpoint && /^##\s/.test(line));
  if (insertAt < 0) insertAt = midpoint;
  const midFigure = `<figure class="post-mid-image">
  <img src="/images/${slug}-mid.png" alt="${title.replace(/"/g, '&quot;')} 인포그래픽" loading="lazy">
</figure>`;
  lines.splice(insertAt, 0, '', midFigure, '');
  const comicFigure = `<figure class="post-comic">
  <figcaption>오늘의 시사 4컷</figcaption>
  <img src="/images/${slug}-comic.png" alt="${title.replace(/"/g, '&quot;')} 4컷만화" loading="lazy">
</figure>`;
  return `${lines.join('\n').trim()}\n\n---\n\n${comicFigure}\n`;
}

function queueThreeImageGroup({ blogId, blogSlug, postFilename, postContent, title, category, categoryName, researchSourceCount = 0, slug, articleContent }) {
  const groupId = `group-${Date.now()}`;
  const coreText = articleContent
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*|`_~\-\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2200);
  const common = { groupId, blogId, blogSlug, postFilename, title, category, categoryName, researchSourceCount, status: 'pending' };
  const jobs = [
    {
      ...common,
      id: `${Date.now()}-main`,
      imageRole: 'main',
      imageFilename: `${slug}.png`,
      imagePrompt: `이미지를 생성해줘. 웹 검색하지 말고 직접 새 이미지를 그려줘.

한국 온라인 뉴스·유튜브 시사 채널의 강렬한 대표 썸네일을 제작해줘.
기사 제목: ${title}
핵심 내용: ${coreText.slice(0, 900)}

필수 스타일:
- 단순 풍경 사진 금지. 기사 핵심 장면을 사진처럼 사실적으로 구성하되 뉴스 썸네일용 역동적인 합성
- 기사 제목 전체를 복사하지 말고 핵심 주제를 4~8자의 짧은 한국어 헤드라인으로 요약해 2~3줄로 배치
- 흰색·노란색·빨간색 대형 글자, 진한 외곽선과 높은 대비
- 핵심 인물·장소·사물을 크게 배치하고 필요하면 화살표, 강조 박스, 핵심 숫자 사용
- 작은 설명문이나 긴 문장 금지, 한눈에 주제가 읽혀야 함
- 가로 16:9, 1200x630 이상 고해상도, 전문 뉴스 썸네일 느낌`
    },
    {
      ...common,
      id: `${Date.now()}-mid`,
      imageRole: 'mid',
      imageFilename: `${slug}-mid.png`,
      imagePrompt: `이미지를 생성해줘. 웹 검색하지 말고 직접 새 이미지를 그려줘.

제목: ${title}
핵심 내용: ${coreText.slice(0, 1500)}

스타일: 핵심 내용을 시각적으로 요약한 전문 인포그래픽. 기사 제목 전체를 쓰지 말고 인포그래픽 제목은 핵심 주제 4~8자로 짧게 작성. 다양한 색상, 핵심 수치와 키워드를 큰 한국어 텍스트로 정확히 표시. 정보 구역을 3~5개로 명확히 나누고 아이콘·도표·비교 요소를 활용. 단순 사진이나 썸네일 형식 금지. 정사각형 1:1, 1200x1200 이상 고해상도.`
    },
    {
      ...common,
      id: `${Date.now()}-comic`,
      imageRole: 'comic',
      imageFilename: `${slug}-comic.png`,
      imagePrompt: `이미지를 생성해줘. 웹 검색하지 말고 직접 새 이미지를 그려줘.

제목: ${title}
핵심 내용: ${coreText.slice(0, 1300)}

4컷 시사 만화를 그려줘:
- 2x2 그리드 4컷, 번호 없이 왼쪽 위부터 순서대로
- 뉴스 내용을 이해하기 쉽게 재치 있게 표현
- 둥근 얼굴과 분명한 표정의 친근한 한국 만화 스타일
- 각 컷에 짧고 자연스러운 한국어 말풍선
- 마지막 컷은 핵심 교훈이나 가벼운 반전
- 밝고 컬러풀한 톤, 정사각형 1:1, 1200x1200 이상 고해상도`
    }
  ];
  imageGroups.set(groupId, { groupId, blogId, blogSlug, postFilename, postContent, title, category, categoryName, researchSourceCount, expectedCount: 3, imageFilenames: jobs.map(job => job.imageFilename), uploadedRoles: new Set(), createdAt: new Date().toISOString() });
  queue.push(...jobs.map((job, index) => ({ ...job, createdAt: new Date(Date.now() + index).toISOString() })));
  console.log(`[queue] Three-image group queued: ${groupId} (main, mid, comic)`);
  return { groupId, jobs };
}

// --- Registry ---
function getRegistry() {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, 'data', 'blog-registry.json'), 'utf-8'));
}

// --- Groq Content Generation ---
async function generateWithGroq(systemPrompt, userPrompt, maxTokens = 4000) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'groq/compound-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: maxTokens
      })
    });

    if (res.status === 429) {
      await new Promise(r => setTimeout(r, (attempt + 1) * 15000));
      continue;
    }
    if (!res.ok) {
      let details = '';
      try {
        details = await res.text();
      } catch {}
      throw new Error(`Groq error: ${res.status}${details ? ` - ${details.slice(0, 300)}` : ''}`);
    }

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

    if (urls.length > 0) {
      console.log(`[research] DuckDuckGo: ${urls.length} URLs`);
      return urls;
    }
    console.warn('[research] DuckDuckGo returned no results; trying Bing News RSS');
  } catch (e) {
    console.warn('[research] Search failed:', e.message);
  }

  try {
    const rssUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=ko-KR`;
    const rssRes = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!rssRes.ok) throw new Error(`Bing RSS ${rssRes.status}`);
    const rss = await rssRes.text();
    const links = [...rss.matchAll(/<link>([\s\S]*?)<\/link>/g)]
      .map(match => match[1].replace(/&amp;/g, '&').trim())
      .map(link => {
        try {
          const parsed = new URL(link);
          return parsed.searchParams.get('url') || link;
        } catch {
          return link;
        }
      })
      .filter(link => link.startsWith('http') && !link.includes('bing.com/news/search'))
      .slice(0, numResults);
    console.log(`[research] Bing News RSS: ${links.length} URLs`);
    return links;
  } catch (e) {
    console.warn('[research] Bing News RSS failed:', e.message);
    return [];
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

async function researchTopic(topic, category) {
  console.log(`[research] Researching: ${topic}`);

  // Search for related articles
  const searchSuffix = CATEGORIES[category]?.searchSuffix || '2026 총정리';
  const focusedUrls = await searchWeb(`${topic} ${searchSuffix}`);
  const broadUrls = focusedUrls.length >= 3 ? [] : await searchWeb(topic);
  const urls = [...new Set([...focusedUrls, ...broadUrls])].slice(0, 5);

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
      '소득공제', '세액공제', '월세공제', '의료비공제', '카드공제',
      '부모급여', '첫만남이용권', '청년내일저축계좌', '국가장학금',
      '한부모가족 지원', '내일배움카드', '문화누리카드', '아이돌봄서비스',
      '노인일자리', '장애인연금', '평생교육바우처', '재난적의료비 지원'
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
- 계절감 있는 생동감 있는 묘사
- 검증 가능한 고유 장소명 3곳과 주변 맛집·카페 2곳을 확보하지 못하면 글을 만들지 말고 CONTENT_QUALITY_BLOCKED로 시작하는 한 줄만 반환`
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

  function unused(topic) {
    return !findExistingPostByTitle(buildArticleTitle(topic, category));
  }

  // 1. Match trends to category keywords
  for (const trend of trends) {
    for (const kw of cat.keywords) {
      if ((trend.includes(kw) || kw.includes(trend)) && unused(trend)) {
        return { topic: trend, source: 'google-trends', category, matchedKeyword: kw };
      }
    }
  }

  // 2. Match trends to general terms
  for (const trend of trends) {
    for (const term of cat.trendTerms) {
      if (trend.includes(term) && unused(trend)) {
        return { topic: trend, source: 'google-trends-related', category, matchedKeyword: term };
      }
    }
  }

  // 3. Fallback to an unused keyword from category
  const keywords = category === 'lifestyle' ? getLifestyleKeywords() : cat.keywords;
  const unusedKeywords = keywords.filter(unused);
  if (!unusedKeywords.length) return null;
  const kw = unusedKeywords[Math.floor(Math.random() * unusedKeywords.length)];
  return { topic: kw, source: 'keyword-fallback', category, matchedKeyword: kw };
}

function buildArticleTitle(topic, category) {
  const categoryTitleSuffix = {
    policy: '핵심 내용과 영향 정리',
    benefits: '신청 조건과 혜택 총정리',
    lifestyle: '추천 코스와 방문 팁'
  };
  return `${topic} ${categoryTitleSuffix[category] || '핵심 정리'}`.slice(0, 45);
}

const SCHEDULE_SLOTS_KST = [
  { hour: 7, minute: 30, mode: 'publish', category: 'benefits', label: '신규 글' },
  { hour: 13, minute: 30, mode: 'refresh', category: null, label: '기존 글 갱신' },
  { hour: 18, minute: 30, mode: 'publish', category: 'policy', label: '신규 글' }
];

const REFRESH_KEYWORDS = [
  'K리그', 'KBO', '삼성 라이온즈', 'LCK', '드라마', '연예',
  '지원금', '월세', '근로장려금', '건강보험', '국민연금', '실업급여'
];

function getKstDateParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes()
  };
}

function getCurrentCategory(date = new Date()) {
  const { hour, minute } = getKstDateParts(date);
  const currentMinutes = hour * 60 + minute;
  const publishSlots = SCHEDULE_SLOTS_KST.filter(slot => slot.mode === 'publish');
  let slot = publishSlots.findLastIndex(item => item.hour * 60 + item.minute <= currentMinutes);
  if (slot < 0) slot = publishSlots.length - 1;
  return publishSlots[slot].category;
}

function getNextPublishRuns(date = new Date(), count = 4) {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const nowMs = date.getTime();
  const { year, month, day } = getKstDateParts(date);
  const runs = [];
  for (let dayOffset = 0; runs.length < count && dayOffset < 3; dayOffset += 1) {
    for (const slot of SCHEDULE_SLOTS_KST) {
      if (runs.length >= count) break;
      const atMs = Date.UTC(year, month, day + dayOffset, slot.hour, slot.minute) - KST_OFFSET_MS;
      if (atMs <= nowMs + 1000) continue;
      runs.push({ at: new Date(atMs), ...slot });
    }
  }
  return runs;
}

function setFrontmatterValue(frontmatter, key, value) {
  const line = `${key}: ${value}`;
  const pattern = new RegExp(`^${key}:.*$`, 'mi');
  if (pattern.test(frontmatter)) return frontmatter.replace(pattern, line);
  return frontmatter.replace(/\n---\s*$/, `\n${line}\n---`);
}

function findRefreshCandidate() {
  const postsDir = join(PROJECT_ROOT, 'sites', 'tax-yearend', 'content', 'posts');
  const candidates = readdirSync(postsDir)
    .filter(name => name.endsWith('.md'))
    .map(filename => {
      const content = readFileSync(join(postsDir, filename), 'utf-8');
      const meta = parseFrontmatter(content);
      if (/^draft:\s*true\s*$/mi.test(content) || /^aliases:/mi.test(content)) return null;
      const title = meta.title || '';
      const priority = REFRESH_KEYWORDS.some(keyword => title.includes(keyword)) ? 1 : 0;
      const freshness = meta.lastmod || meta.date || '1970-01-01';
      return { filename, content, meta, title, priority, freshness };
    })
    .filter(Boolean)
    .filter(item => item.title && item.priority > 0)
    .sort((a, b) => b.priority - a.priority || String(a.freshness).localeCompare(String(b.freshness)));
  return candidates[0] || null;
}

// --- API Routes ---

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', queue: textQueue.length + queue.length, completed: completed.length });
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
      if (!match) throw new Error(`${cat.name} 카테고리의 미발행 주제 후보가 없습니다.`);
      topicTitle = match.topic;
      topicSource = match.source;
      console.log(`[generate] Topic from ${topicSource}: ${topicTitle} (matched: ${match.matchedKeyword})`);
    }

    // 1. Web Research - 관련 기사 5개 검색 + 내용 수집
    console.log(`[generate] Researching: ${topicTitle}`);
    const research = await researchTopic(topicTitle, category);
    console.log(`[generate] Research done: ${research.count} sources collected`);

    if (research.count < 2) {
      throw new Error(`검증 가능한 출처가 부족합니다 (${research.count}/2). 이번 포스트는 발행하지 않습니다.`);
    }

    await new Promise(r => setTimeout(r, 2000));

    // 2. Generate blog post in TWO parts for longer content
    console.log(`[generate] Writing post part 1 with ${research.count} sources...`);

    const systemPrompt = `${cat.systemPrompt}
존댓말 사용. 전문용어는 괄호 설명. 표(테이블) 활용. 마크다운 ##부터 시작.
현재 날짜는 ${getKoreaDateString()}입니다.
참고 자료에 명시된 사실만 사용하고, 확인되지 않은 주소·가격·운영시간·날짜·인물·수치를 만들지 마세요.
확인할 수 없는 항목은 생략하거나 "방문 전 공식 안내 확인"으로 표시하세요.
구체적인 수치/날짜/장소는 참고 자료에서 확인된 경우에만 포함. 최대한 길고 상세하게 작성.`;

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
2. 참고 자료에서 검증된 추천 명소 3~7곳 - 각 명소별 (고유 이름, 위치, 특징, 입장료, 운영시간)
3. 명소별 추천 대상 표 (데이트/가족/혼자/친구)`,
        part2: `1. 방문 꿀팁 (주차, 혼잡시간, 준비물 등 5가지 이상)
2. 참고 자료에서 상호와 위치가 검증된 주변 맛집/카페 2곳 이상
3. 추천 코스 (반나절/하루 코스)
4. 주의사항 (날씨, 예약 등)
5. 자주 묻는 질문(FAQ) 5개

**FAQ는 반드시 아래 형식으로 작성:**
**Q: 질문내용?**

A: 답변내용.`
      }
    };

    const prompts = partPrompts[category] || partPrompts.benefits;

    const cleanTitle = buildArticleTitle(topicTitle, category);
    const existingPost = findExistingPostByTitle(cleanTitle);
    if (existingPost) {
      throw new Error(`동일 제목 글이 이미 발행되어 있습니다: ${existingPost}`);
    }
    const textPrompt = `${systemPrompt}

주제: ${topicTitle}
제목: ${cleanTitle}

참고 자료:
${research.text.slice(0, 7000)}

위 참고 자료만 근거로 완성된 블로그 본문을 작성하세요.
전반부 구성:
${prompts.part1}

후반부 구성:
${prompts.part2}

필수 조건:
- 프론트매터와 제목은 쓰지 말고 본문만 작성
- ## 소제목 구조와 표 포함
- 최소 2500자 이상
- 참고 자료에 없는 주소, 가격, 운영시간, 날짜, 인물, 수치를 추측하거나 만들지 않기
- 생활·명소 글은 고유 명칭이 확인된 추천지 3곳과 주변 맛집·카페 2곳을 확보하지 못하면 표를 임시 항목으로 채우지 말고 CONTENT_QUALITY_BLOCKED: 자료 부족 한 줄만 반환
- "추천 명소 2", "맛집 1", "확인 불가" 같은 자리표시자를 절대 쓰지 않기
- 현재 시점과 맞지 않는 계절·날짜 표현 금지
- 글 마지막에 "## 출처"를 만들고 제공된 출처 URL을 목록으로 표시`;

    const textJob = {
      id: `text-${Date.now()}`,
      type: 'text',
      blogId: blogConfig.id,
      blogSlug: blogConfig.slug,
      topicTitle,
      title: cleanTitle,
      category,
      categoryName: cat.name,
      researchSourceCount: research.count,
      textPrompt,
      minLength: 1800,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    textQueue.push(textJob);
    console.log(`[text-queue] Text job queued: ${textJob.id}`);
    return res.json({ success: true, mode: 'chrome-extension-text', job: textJob, post: { title: cleanTitle } });

    const part1 = await generateWithGroq(systemPrompt,
      `주제: ${topicTitle}

참고 자료:
${research.text.slice(0, 2500)}

위 자료를 바탕으로 블로그 포스트의 전반부를 작성하세요:
${prompts.part1}

각 섹션을 최대한 상세하게 작성. 프론트매터 없이 본문만.`
    , 4000);

    await new Promise(r => setTimeout(r, 3000));

    console.log(`[generate] Writing post part 2...`);
    const part2 = await generateWithGroq(systemPrompt,
      `주제: ${topicTitle}

참고 자료:
${research.text.slice(0, 2500)}

블로그 포스트의 후반부를 작성하세요:
${prompts.part2}

각 섹션을 최대한 상세하게 작성. 프론트매터 없이 본문만.`
    , 4000);

    const content = part1 + '\n\n' + part2;
    console.log(`[generate] Total content: ${content.length} chars`);

    // 3. Build title/excerpt locally. This avoids extra LLM calls that can hang the cron.
    const categoryTitleSuffixLegacy = {
      policy: '핵심 내용과 영향 정리',
      benefits: '신청 조건과 혜택 총정리',
      lifestyle: '추천 코스와 방문 팁'
    };
    const cleanTitleLegacy = `${topicTitle} ${categoryTitleSuffixLegacy[category] || '핵심 정리'}`.slice(0, 45);
    const excerpt = content
      .replace(/^---[\s\S]*?---/m, '')
      .replace(/[#>*|`_~\-\[\]🎯📌💰]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);

    // 2. Create slug and filename
    const date = getKoreaDateString();
    const slug = (cleanTitleLegacy.toLowerCase().replace(/[^\w\s가-힣-]/g, '').replace(/\s+/g, '-').slice(0, 50) || topicTitle.toLowerCase().replace(/[^\w\s가-힣-]/g, '').replace(/\s+/g, '-').slice(0, 50) || `post-${Date.now()}`);
    const filename = `${date}-${slug}.md`;
    const imageFilename = `${slug}.png`;

    // 3. Prepare post content (DO NOT save yet - wait for image)
    const frontmatter = `---
title: "${cleanTitleLegacy.replace(/"/g, '\\"')}"
date: ${date}
description: "${excerpt.trim().replace(/"/g, '\\"')}"
categories: ["${cat.name}"]
tags: ["${topicTitle.replace(/"/g, '\\"')}", "${cat.name}"]
author: "${blogConfig.name}"
image: "/images/${imageFilename}"
---`;

    const postContent = `${frontmatter}\n\n${content}\n`;
    console.log(`[generate] Post prepared (NOT saved yet, waiting for image): ${filename}`);

    // 4. Create image prompt
    const imagePrompt = `한국 ${blogConfig.topic} 관련 "${cleanTitleLegacy}" 주제의 고품질 뉴스 썸네일 이미지를 만들어줘.
단순한 색상 카드나 템플릿 배경은 금지. 기사 내용과 직접 관련된 사람, 장소, 사물, 문서, 현장 장면을 구체적으로 보여줘.
블로그 대표 이미지로 바로 쓸 수 있게 선명하고 풍부한 디테일, 전문 언론 썸네일 느낌. 가로 16:9 비율, 1200x630 이상 고해상도.`;

    // 5. Queue image job (post content stored in memory until image is ready)
    const job = {
      id: Date.now().toString(),
      blogId: blogConfig.id,
      blogSlug: blogConfig.slug,
      postFilename: filename,
      postContent,
      imageFilename,
      imagePrompt,
      title: cleanTitleLegacy,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    queue.push(job);

    console.log(`[queue] Image job queued: ${job.id}`);
    res.json({ success: true, job, post: { filename, title: cleanTitleLegacy } });

  } catch (err) {
    console.error('[generate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/text-queue', (req, res) => {
  const now = Date.now();
  res.json(textQueue.filter(job => job.status === 'pending' && (!job.nextDispatchAt || new Date(job.nextDispatchAt).getTime() <= now)));
});

app.post('/api/refresh', async (req, res) => {
  try {
    const candidate = req.body?.filename
      ? (() => {
          const filename = String(req.body.filename).replace(/[\\/]/g, '');
          const content = readFileSync(safePostPath(filename), 'utf-8');
          const meta = parseFrontmatter(content);
          return { filename, content, meta, title: meta.title || filename.replace(/\.md$/, '') };
        })()
      : findRefreshCandidate();
    if (!candidate) return res.status(404).json({ error: '갱신할 성과 글을 찾지 못했습니다.' });

    const research = await researchTopic(candidate.title, 'policy');
    if (research.count < 2) {
      return res.status(422).json({ error: `갱신용 출처가 부족합니다 (${research.count}/2). 기존 글은 변경하지 않습니다.` });
    }

    const existingBody = candidate.content.replace(/^---[\s\S]*?---/, '').trim();
    const textPrompt = `기존 뉴스 글을 최신 정보로 정밀하게 갱신하세요.

제목: ${candidate.title}
현재 날짜: ${getKoreaDateString()}

기존 본문:
${existingBody.slice(0, 9000)}

최신 참고 자료:
${research.text.slice(0, 7000)}

필수 조건:
- 프론트매터와 제목은 쓰지 말고 완성된 본문만 작성
- 기존 글의 유효한 설명은 살리되, 최신 참고 자료로 달라진 사실과 수치를 보강
- 참고 자료에 없는 사실, 날짜, 금액, 인물, 장소를 만들지 않기
- ## 소제목, 표, FAQ를 포함해 최소 2500자 이상
- 이미지 태그는 쓰지 않기. 기존 대표 이미지·인포그래픽·4컷만화는 서버가 유지함
- 글 마지막에 ## 출처를 만들고 실제로 사용한 URL만 목록으로 표시`;

    const textJob = {
      id: `refresh-${Date.now()}`,
      type: 'text',
      mode: 'refresh',
      blogId: 'policy-guide',
      blogSlug: 'tax-yearend',
      postFilename: candidate.filename,
      originalPostContent: candidate.content,
      topicTitle: candidate.title,
      title: candidate.title,
      category: 'policy',
      categoryName: candidate.meta.categories || '최신뉴스',
      researchSourceCount: research.count,
      textPrompt,
      minLength: 1800,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    textQueue.push(textJob);
    console.log(`[refresh] Text refresh queued: ${candidate.filename}`);
    res.json({ success: true, mode: 'refresh', job: textJob, post: { filename: candidate.filename, title: candidate.title } });
  } catch (err) {
    console.error('[refresh] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/text-complete', (req, res) => {
  const { jobId, text } = req.body || {};
  const idx = textQueue.findIndex(job => String(job.id) === String(jobId));
  if (idx < 0) return res.status(404).json({ error: 'Text job not found' });

  const textJob = textQueue[idx];
  const content = stripAssistantPreamble(String(text || '')
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/i, ''));
  const contentQuality = validateArticleContent({
    category: textJob.category,
    title: textJob.title,
    content
  });
  if (!contentQuality.ok) {
    textQueue.splice(idx, 1);
    textJob.status = 'failed';
    textJob.error = `콘텐츠 품질 미달: ${contentQuality.reason}`;
    textJob.failedAt = new Date().toISOString();
    failed.push(textJob);
    console.warn(`[text-complete] Publication blocked for ${textJob.title}: ${contentQuality.reason}`);
    notifyTelegram(`⚠️ 추천 글 품질 미달로 발행 중단\n\n제목: ${textJob.title}\n사유: ${contentQuality.reason}`);
    return res.status(422).json({ error: textJob.error, blocked: true });
  }
  if (content.length < textJob.minLength || !content.includes('## ')) {
    return res.status(400).json({ error: `본문 품질 미달 (${content.length}자)` });
  }

  if (textJob.mode === 'refresh') {
    const original = textJob.originalPostContent || '';
    const frontmatterMatch = original.match(/^---\s*\n[\s\S]*?\n---/);
    if (!frontmatterMatch) return res.status(409).json({ error: '기존 글의 frontmatter를 읽을 수 없습니다.' });
    const meta = parseFrontmatter(original);
    const slug = (meta.image || '').match(/\/images\/(.+)\.png$/)?.[1]
      || textJob.postFilename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    const excerpt = content.replace(/[#>*|`_~\-\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
    let frontmatter = setFrontmatterValue(frontmatterMatch[0], 'lastmod', getKoreaDateString());
    frontmatter = setFrontmatterValue(frontmatter, 'description', `"${excerpt.replace(/"/g, '\\"')}"`);
    const refreshedContent = `${frontmatter}\n\n${insertArticleImages(content, slug, textJob.title)}`;
    writeFileSync(safePostPath(textJob.postFilename), refreshedContent, 'utf-8');
    textQueue.splice(idx, 1);
    textJob.status = 'completed';
    textJob.completedAt = new Date().toISOString();
    delete textJob.originalPostContent;
    delete textJob.textPrompt;
    completed.push(textJob);
    deployBlog(textJob.blogSlug, generatedDeployPaths(textJob.blogSlug, textJob.postFilename, []));
    notifyTelegram(`♻️ 기존 글 갱신 완료\n\n제목: ${textJob.title}\n기사 보기: ${getPublishedPostUrl(textJob.postFilename)}\n시간: ${new Date().toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})}`);
    console.log(`[text-complete] Existing post refreshed: ${textJob.postFilename}`);
    return res.json({ success: true, mode: 'refresh', postFilename: textJob.postFilename });
  }

  const date = getKoreaDateString();
  const slug = textJob.title.toLowerCase()
    .replace(/[^\w\s가-힣-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50) || `post-${Date.now()}`;
  const postFilename = `${date}-${slug}.md`;
  const imageFilename = `${slug}.png`;
  const excerpt = content
    .replace(/[#>*|`_~\-\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  const frontmatter = `---
title: "${textJob.title.replace(/"/g, '\\"')}"
date: ${date}
description: "${excerpt.replace(/"/g, '\\"')}"
categories: ["${textJob.categoryName}"]
tags: ["${textJob.topicTitle.replace(/"/g, '\\"')}", "${textJob.categoryName}"]
author: "오늘의 트렌드"
image: "/images/${imageFilename}"
---`;

  textQueue.splice(idx, 1);
  const enrichedContent = insertArticleImages(content, slug, textJob.title);
  const group = queueThreeImageGroup({
    blogId: textJob.blogId,
    blogSlug: textJob.blogSlug,
    postFilename,
    postContent: `${frontmatter}\n\n${enrichedContent}`,
    title: textJob.title,
    category: textJob.category,
    categoryName: textJob.categoryName,
    researchSourceCount: textJob.researchSourceCount,
    slug,
    articleContent: content
  });
  console.log(`[text-complete] Text accepted (${content.length} chars), three images queued: ${group.groupId}`);
  res.json({ success: true, groupId: group.groupId, jobs: group.jobs.map(job => ({ id: job.id, imageRole: job.imageRole, imageFilename: job.imageFilename })) });
});

app.post('/api/text-error', (req, res) => {
  const { jobId, error } = req.body || {};
  const idx = textQueue.findIndex(job => String(job.id) === String(jobId));
  const retryableWindowError = /No current window|Could not establish connection|Receiving end does not exist/i.test(String(error || ''));
  if (idx >= 0 && retryableWindowError) {
    const job = textQueue[idx];
    job.dispatchRetries = (job.dispatchRetries || 0) + 1;
    job.lastDispatchError = error;
    job.nextDispatchAt = new Date(Date.now() + 60 * 1000).toISOString();
    console.warn(`[text-error] Keeping job pending for dispatch retry ${job.dispatchRetries}: ${job.id} ${error}`);
    return res.json({ success: true, retry: true, retryCount: job.dispatchRetries, nextDispatchAt: job.nextDispatchAt, job });
  }
  const job = idx >= 0 ? textQueue.splice(idx, 1)[0] : { id: jobId, title: 'unknown' };
  job.status = 'failed';
  job.error = error || 'text-error';
  job.failedAt = new Date().toISOString();
  failed.push(job);
  console.warn('[text-error] Extension reported:', jobId, job.error);
  res.json({ success: true, job });
});

// Chrome Extension polls this for pending image jobs
app.get('/api/queue', (req, res) => {
  const pending = queue.filter(j => j.status === 'pending');
  res.json(pending);
});

app.post('/api/queue/process', async (req, res) => {
  const job = queue.find(j => j.status === 'pending');
  if (!job) return res.status(404).json({ error: 'No pending image job' });

  try {
    const ok = await generateImageViaCDP(job);
    res.json({ success: ok, jobId: job.id, status: job.status, error: job.error || '' });
  } catch (err) {
    console.error('[queue/process] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Chrome Extension uploads completed image
app.post('/api/upload', upload.single('image'), (req, res) => {
  const { jobId } = req.body;
  const job = queue.find(j => j.id === jobId);

  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!req.file) return res.status(400).json({ error: 'No image file' });

  try {
    const imageCheck = validateNewsImage(req.file.buffer);
    if (!imageCheck.ok) {
      job.status = 'image-rejected';
      job.error = imageCheck.reason;
      console.warn(`[upload] Image rejected for ${job.title}: ${imageCheck.reason}`);
      notifyTelegram(`⚠️ 이미지 품질 미달로 발행 중단\n\n제목: ${job.title}\n사유: ${imageCheck.reason}`);
      return res.status(400).json({ error: imageCheck.reason });
    }

    const aspectRatio = imageCheck.width / imageCheck.height;
    const roleAspectInvalid = job.imageRole === 'main'
      ? aspectRatio < 1.45
      : ['mid', 'comic'].includes(job.imageRole) && (aspectRatio < 0.85 || aspectRatio > 1.18);
    if (roleAspectInvalid) {
      const expected = job.imageRole === 'main' ? '16:9 landscape' : '1:1 square';
      const reason = `${job.imageRole} image must be ${expected}; received ${imageCheck.width}x${imageCheck.height}`;
      console.warn(`[upload] Role mismatch, keeping job pending: ${reason}`);
      return res.status(422).json({ error: reason, retry: true });
    }

    // 1. Save image
    const imagesDir = join(PROJECT_ROOT, 'sites', job.blogSlug, 'static', 'images');
    mkdirSync(imagesDir, { recursive: true });
    const imagePath = join(imagesDir, job.imageFilename);
    writeFileSync(imagePath, req.file.buffer);
    console.log(`[upload] Image saved: ${imagePath} (${imageCheck.width}x${imageCheck.height}, ${(req.file.buffer.length / 1024).toFixed(0)}KB)`);

    if (job.groupId) {
      const group = imageGroups.get(job.groupId);
      if (!group) return res.status(409).json({ error: 'Image group not found; retry the article image generation' });

      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      group.uploadedRoles.add(job.imageRole);
      removeFromQueue(job);

      const remaining = queue.filter(item => item.groupId === job.groupId && item.status === 'pending').length;
      const expectedCount = group.expectedCount || 3;
      console.log(`[upload] Image group ${job.groupId}: ${group.uploadedRoles.size}/${expectedCount} ready`);
      if (remaining > 0 || group.uploadedRoles.size < expectedCount) {
        return res.json({ success: true, message: `${job.imageRole} image saved; ${remaining} image(s) remaining`, remaining });
      }

      const postsDir = join(PROJECT_ROOT, 'sites', group.blogSlug, 'content', 'posts');
      mkdirSync(postsDir, { recursive: true });
      writeFileSync(join(postsDir, group.postFilename), group.postContent, 'utf-8');
      console.log(`[upload] All ${expectedCount} expected image(s) ready. Post saved: ${group.postFilename}`);

      const completedGroup = {
        id: group.groupId,
        blogId: group.blogId,
        blogSlug: group.blogSlug,
        postFilename: group.postFilename,
        title: group.title,
        category: group.category,
        categoryName: group.categoryName,
        researchSourceCount: group.researchSourceCount,
        imageCount: expectedCount,
        status: 'completed',
        createdAt: group.createdAt,
        completedAt: new Date().toISOString()
      };
      completed.push(completedGroup);
      imageGroups.delete(group.groupId);

      console.log('[upload] Deploying post + all three images together...');
      deployBlog(group.blogSlug, generatedDeployPaths(group.blogSlug, group.postFilename, group.imageFilenames));
      notifyTelegram(`📝 *새 블로그 발행*\n\n제목: ${group.title}\n이미지: ${expectedCount}장 검수 완료\n기사 보기: ${getPublishedPostUrl(group.postFilename)}\n시간: ${new Date().toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})}`);
      return res.json({ success: true, message: 'Post + all three images saved and deployed' });
    }

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
    removeFromQueue(job);

    // 4. Deploy (post + image together)
    console.log(`[upload] Deploying post + image together...`);
    deployBlog(job.blogSlug, generatedDeployPaths(job.blogSlug, job.postFilename, [job.imageFilename]));

    // 5. Telegram notification
    notifyTelegram(`📝 *새 블로그 발행*\n\n제목: ${job.title}\n카테고리: ${job.blogSlug}\n기사 보기: ${getPublishedPostUrl(job.postFilename)}\n시간: ${new Date().toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})}`);

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

app.post('/api/posts/repair-images', (req, res) => {
  try {
    const { filename } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const postPath = safePostPath(filename);
    if (!existsSync(postPath)) return res.status(404).json({ error: 'Post not found' });

    const original = readFileSync(postPath, 'utf-8');
    const frontmatterMatch = original.match(/^---\s*\n[\s\S]*?\n---/);
    if (!frontmatterMatch) return res.status(400).json({ error: 'Post frontmatter missing' });
    const meta = parseFrontmatter(original);
    const title = meta.title || filename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    const slug = (meta.image || '').match(/\/images\/(.+)\.png$/)?.[1]
      || filename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    const body = original.slice(frontmatterMatch[0].length).trim();
    const enrichedBody = insertArticleImages(body, slug, title);
    const group = queueThreeImageGroup({
      blogId: 'policy-guide',
      blogSlug: 'tax-yearend',
      postFilename: filename,
      postContent: `${frontmatterMatch[0]}\n\n${enrichedBody}`,
      title,
      category: meta.categories || 'lifestyle',
      categoryName: meta.categories || '생활·명소',
      researchSourceCount: 0,
      slug,
      articleContent: body
    });
    res.json({ success: true, groupId: group.groupId, queued: group.jobs.length });
  } catch (err) {
    console.error('[repair-images] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/repair-headline-images', (req, res) => {
  try {
    const { filename, headline } = req.body || {};
    if (!filename || !headline) return res.status(400).json({ error: 'filename and headline required' });
    const postPath = safePostPath(filename);
    if (!existsSync(postPath)) return res.status(404).json({ error: 'Post not found' });
    const postContent = readFileSync(postPath, 'utf-8');
    const meta = parseFrontmatter(postContent);
    const title = meta.title || headline;
    const slug = (meta.image || '').match(/\/images\/(.+)\.png$/)?.[1]
      || filename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    const articleText = postContent
      .replace(/^---[\s\S]*?---/, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[#>*|`_~\-\[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1800);
    const groupId = `headline-${Date.now()}`;
    const common = {
      groupId,
      blogId: 'policy-guide',
      blogSlug: 'tax-yearend',
      postFilename: filename,
      title,
      category: meta.categories || 'lifestyle',
      categoryName: meta.categories || '생활·명소',
      researchSourceCount: 0,
      status: 'pending'
    };
    const jobs = [
      {
        ...common,
        id: `${Date.now()}-main`,
        imageRole: 'main',
        imageFilename: `${slug}.png`,
        imagePrompt: `한국 온라인 뉴스·유튜브 시사 채널의 강렬한 대표 썸네일 이미지를 생성해줘.
기사 주제: ${title}
이미지 안의 메인 헤드라인은 정확히 "${headline}"만 사용해. 다른 긴 제목은 넣지 마.
기사 핵심 장면을 사실적인 사진처럼 역동적으로 합성하고, 메인 헤드라인은 굵은 흰색·노란색 대형 한글과 진한 외곽선으로 표현해.
단순 풍경 사진 금지. 핵심 장소와 인물을 크게 배치하고 화살표와 짧은 핵심 키워드를 활용해.
메인 헤드라인 외에는 연도, 퍼센트, 금액, 통계 수치를 절대 넣지 마. 제공되지 않은 정책명이나 수치를 추정하거나 창작하지 마.
가로 16:9, 1200x630 이상 고해상도.`
      },
      {
        ...common,
        id: `${Date.now()}-mid`,
        imageRole: 'mid',
        imageFilename: `${slug}-mid.png`,
        imagePrompt: `전문적인 한국어 인포그래픽 이미지를 생성해줘.
인포그래픽 제목은 정확히 "${headline}"만 사용해. "방문 팁"이나 긴 기사 제목은 이미지에 넣지 마.
기사 핵심 내용: ${articleText}
핵심 정보를 3~5개 구역으로 나누고 큰 한국어 키워드, 아이콘, 체크리스트, 비교 요소로 시각화해. 작은 장문은 피하고 정확한 정보만 사용해.
정사각형 1:1, 1200x1200 이상 고해상도.`
      }
    ];
    imageGroups.set(groupId, {
      groupId,
      blogId: 'policy-guide',
      blogSlug: 'tax-yearend',
      postFilename: filename,
      postContent,
      title,
      category: common.category,
      categoryName: common.categoryName,
      researchSourceCount: 0,
      expectedCount: 2,
      uploadedRoles: new Set(),
      createdAt: new Date().toISOString()
    });
    queue.push(...jobs.map((job, index) => ({ ...job, createdAt: new Date(Date.now() + index).toISOString() })));
    console.log(`[queue] Headline image repair queued: ${groupId} (main, mid)`);
    res.json({ success: true, groupId, queued: jobs.length });
  } catch (err) {
    console.error('[repair-headline-images] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/repair-mid-image', (req, res) => {
  try {
    const { filename } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const postPath = safePostPath(filename);
    if (!existsSync(postPath)) return res.status(404).json({ error: 'Post not found' });

    const postContent = readFileSync(postPath, 'utf-8');
    const meta = parseFrontmatter(postContent);
    const title = meta.title || filename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    const slug = (meta.image || '').match(/\/images\/(.+)\.png$/)?.[1]
      || filename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    const articleText = postContent
      .replace(/^---[\s\S]*?---/, '')
      .replace(/<figure[\s\S]*?<\/figure>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[#>*|`_~\-\[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1800);
    const groupId = `mid-repair-${Date.now()}`;
    const job = {
      groupId,
      blogId: 'policy-guide',
      blogSlug: 'tax-yearend',
      postFilename: filename,
      title,
      category: meta.categories || 'lifestyle',
      categoryName: meta.categories || '생활·명소',
      researchSourceCount: 0,
      status: 'pending',
      id: `${Date.now()}-mid`,
      imageRole: 'mid',
      imageFilename: `${slug}-mid.png`,
      imagePrompt: `이미지를 생성해줘. 웹 검색하지 말고 직접 새 이미지를 그려줘.

기사 제목: ${title}
기사 핵심 내용: ${articleText}

반드시 정사각형 한국어 인포그래픽으로 제작해줘.
- 유튜브 썸네일, 실사 인물 중심 사진, 거대한 한 줄 헤드라인 형식은 절대 금지
- 핵심 정보를 신청 대상, 지원 금액, 지원 기간, 신청 방법, 주의사항 등 4~5개 정보 구역으로 분리
- 각 구역에 짧고 정확한 한국어 키워드, 아이콘, 체크리스트, 숫자를 사용
- 기사에 없는 수치나 조건은 만들지 말 것
- 밝고 전문적인 공공정책 안내 디자인
- 정사각형 1:1, 1200x1200 이상 고해상도`
    };

    imageGroups.set(groupId, {
      groupId,
      blogId: job.blogId,
      blogSlug: job.blogSlug,
      postFilename: filename,
      postContent,
      title,
      category: job.category,
      categoryName: job.categoryName,
      researchSourceCount: 0,
      expectedCount: 1,
      uploadedRoles: new Set(),
      createdAt: new Date().toISOString()
    });
    queue.push({ ...job, createdAt: new Date().toISOString() });
    console.log(`[queue] Mid infographic repair queued: ${groupId}`);
    res.json({ success: true, groupId, queued: 1, jobId: job.id });
  } catch (err) {
    console.error('[repair-mid-image] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get job status
app.get('/api/jobs', (req, res) => {
  res.json({
    pendingTexts: textQueue.filter(j => j.status === 'pending'),
    pending: queue.filter(j => j.status === 'pending'),
    completed,
    failed
  });
});

app.post('/api/image-error', (req, res) => {
  const { jobId, error, resetAt, stopScheduler } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const idx = queue.findIndex(j => String(j.id) === String(jobId));
  const job = idx >= 0 ? queue.splice(idx, 1)[0] : { id: jobId, title: 'unknown' };
  if (job.groupId) {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].groupId === job.groupId) queue.splice(i, 1);
    }
    imageGroups.delete(job.groupId);
  }
  job.status = 'failed';
  job.error = error || 'image-error';
  job.resetAt = resetAt || null;
  job.failedAt = new Date().toISOString();
  failed.push(job);

  if (stopScheduler) stopSchedulerNow();

  console.log(`[image-error] ${job.id} ${job.title}: ${job.error}${job.resetAt ? ` resetAt=${job.resetAt}` : ''}`);
  notifyTelegram(`⏸️ *자동 포스팅 중지*\n\n사유: ${job.error}\n제목: ${job.title}\n${job.resetAt ? `재개 가능 시간: ${job.resetAt}` : ''}\n\n이미지 없는 글은 발행하지 않고 대기 작업을 내렸습니다.`);
  res.json({ success: true, stopped: Boolean(stopScheduler), job });
});

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD || process.env.ADMIN_PW || '';
  const provided = req.get('X-Admin-Password') || req.query.pw || '';
  if (expected && provided !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function parseFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  const data = {};
  if (!match) return data;
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    value = value.replace(/^["']|["']$/g, '');
    data[key] = value;
  }
  return data;
}

function safePostPath(filename) {
  const clean = filename.replace(/[\\/]/g, '');
  if (!clean.endsWith('.md')) throw new Error('Invalid filename');
  return join(PROJECT_ROOT, 'sites', 'tax-yearend', 'content', 'posts', clean);
}

app.get('/api/dashboard', (req, res) => {
  const category = getCurrentCategory();
  const pending = queue.filter(j => j.status === 'pending');
  const pendingTexts = textQueue.filter(j => j.status === 'pending');
  const latestFinished = [...failed, ...completed]
    .sort((a, b) => new Date(b.completedAt || b.createdAt) - new Date(a.completedAt || a.createdAt))[0];
  const latest = pendingTexts[0] || pending[0] || latestFinished || null;
  const latestStatus = latest?.status || '';
  res.json({
    health: { status: 'ok', queue: textQueue.length + queue.length, completed: completed.length },
    cron: { running: schedulerRunning },
    counts: { pendingTexts: pendingTexts.length, pendingImages: pending.length },
    currentRun: latest ? {
      status: latestStatus === 'completed' ? 'completed' : latestStatus === 'failed' ? 'failed' : 'running',
      phase: latestStatus === 'completed' ? 'published' : latestStatus === 'failed' ? 'generation-error' : latest.type === 'text' ? 'waiting-extension-text' : 'waiting-extension-image',
      topicTitle: latest.title,
      category: latest.category || category,
      categoryName: latest.categoryName || CATEGORIES[category]?.name || category,
      title: latest.title,
      researchSourceCount: latest.researchSourceCount || 0,
      postFilename: latest.postFilename,
      startedAt: latest.createdAt,
      error: latest.error || ''
    } : {
      status: schedulerRunning ? 'idle' : 'stopped',
      phase: schedulerRunning ? 'waiting-next-run' : '',
      category,
      categoryName: CATEGORIES[category]?.name || category
    },
    recentEvents: [
      ...pendingTexts.map(j => ({ time: j.createdAt, type: 'text-queued', message: `본문 대기: ${j.title}` })),
      ...pending.map(j => ({ time: j.createdAt, type: 'image-queued', message: `이미지 대기: ${j.title}` })),
      ...failed.slice(-15).map(j => ({ time: j.failedAt || j.createdAt, type: 'failed', message: `발행 중지: ${j.title} (${j.error || 'image-error'})` })),
      ...completed.slice(-15).map(j => ({ time: j.completedAt || j.createdAt, type: 'published', message: `발행 완료: ${j.title}` }))
    ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 20)
  });
});

app.get('/api/admin/posts', requireAdmin, (req, res) => {
  const postsDir = join(PROJECT_ROOT, 'sites', 'tax-yearend', 'content', 'posts');
  const posts = readdirSync(postsDir)
    .filter(name => name.endsWith('.md'))
    .map(filename => {
      const full = join(postsDir, filename);
      const text = readFileSync(full, 'utf-8');
      const fm = parseFrontmatter(text);
      return {
        filename,
        title: fm.title || filename.replace(/\.md$/, ''),
        date: fm.date || '',
        category: fm.categories || '',
        image: fm.image || '',
        size: statSync(full).size
      };
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.filename.localeCompare(a.filename));
  res.json(posts);
});

app.post('/api/admin/delete', requireAdmin, (req, res) => {
  const postPath = safePostPath(req.body.filename || '');
  if (!existsSync(postPath)) return res.status(404).json({ error: 'Post not found' });
  const fm = parseFrontmatter(readFileSync(postPath, 'utf-8'));
  rmSync(postPath, { force: true });
  if (fm.image) {
    const imageName = fm.image.replace('/images/', '').replace(/[\\/]/g, '');
    rmSync(join(PROJECT_ROOT, 'sites', 'tax-yearend', 'static', 'images', imageName), { force: true });
  }
  res.json({ success: true });
});

app.post('/api/admin/deploy', requireAdmin, (req, res) => {
  deployBlog('tax-yearend');
  res.json({ success: true });
});

// --- Deploy ---
function deployBlog(blogSlug, changedPaths = null) {
  console.log(`[deploy] Building and pushing ${blogSlug}...`);
  try {
    const commitMessage = `post: auto-generated for ${blogSlug}`;
    const pathArgs = changedPaths?.length
      ? ` -- ${changedPaths.map(path => `"${path.replace(/"/g, '\\"')}"`).join(' ')}`
      : ' -A';
    const command = process.platform === 'win32'
      ? `git -C "${PROJECT_ROOT}" add${pathArgs} && git -C "${PROJECT_ROOT}" commit -m "${commitMessage}" && git -C "${PROJECT_ROOT}" push origin main`
      : `git add${pathArgs} && git commit -m "${commitMessage}" && git push origin main`;
    execSync(command, { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 120000 });
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
    const imageCheck = validateNewsImage(buf);
    if (!imageCheck.ok) {
      console.log(`[cdp] Image rejected: ${imageCheck.reason}`);
      job.status = 'image-rejected';
      job.error = imageCheck.reason;
      notifyTelegram(`⚠️ 이미지 품질 미달로 발행 중단\n\n제목: ${job.title}\n사유: ${imageCheck.reason}`);
      return false;
    }

    const imagesDir = join(PROJECT_ROOT, 'sites', job.blogSlug, 'static', 'images');
    mkdirSync(imagesDir, { recursive: true });
    writeFileSync(join(imagesDir, job.imageFilename), buf);
    console.log(`[cdp] Image saved: ${job.imageFilename} (${imageCheck.width}x${imageCheck.height}, ${(buf.length / 1024).toFixed(0)}KB)`);

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
    removeFromQueue(job);

    // Deploy
    deployBlog(job.blogSlug, generatedDeployPaths(job.blogSlug, job.postFilename, [job.imageFilename]));

    // Notify
    notifyTelegram(`📝 *새 블로그 발행*\n\n제목: ${job.title}\n이미지: ✅ ChatGPT 생성\n기사 보기: ${getPublishedPostUrl(job.postFilename)}\n시간: ${new Date().toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})}`);

    return true;

  } catch (e) {
    console.error('[cdp] Error:', e.message);
    notifyTelegram(`⚠️ *이미지 생성 실패*\n\n제목: ${job.title}\n에러: ${e.message}\n\n→ Chrome Extension으로 수동 처리 필요`);
    return false;
  }
}

// --- Daily publish and refresh scheduler ---

let schedulerRunning = false;
let schedulerTimeout = null;

function stopSchedulerNow() {
  schedulerRunning = false;
  if (schedulerTimeout) clearTimeout(schedulerTimeout);
  schedulerTimeout = null;
}

async function hourlyTask(options = {}) {
  if (!schedulerRunning) {
    console.log('[cron] Skipped because scheduler is stopped');
    return;
  }

  const now = new Date();
  const kstHour = (now.getUTCHours() + 9) % 24;
  const category = options.category || getCurrentCategory();
  const catName = CATEGORIES[category]?.name || category;

  console.log(`\n[cron] ===== ${now.toISOString()} (KST ${kstHour}시) [${catName}] 자동 포스트 생성 =====`);

  try {
    // 1. Generate post
    const genRes = await fetch(`http://localhost:${PORT}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category })
    });
    const genData = await genRes.json();

    if (!genData.success) {
      console.error('[cron] Post generation failed:', genData.error);
      return;
    }

    console.log(`[cron] Text generation queued in Chrome Extension: "${genData.post.title}"`);

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

async function refreshTask() {
  if (!schedulerRunning) {
    console.log('[cron] Refresh skipped because scheduler is stopped');
    return;
  }
  console.log(`\n[cron] ===== ${new Date().toISOString()} 기존 성과 글 갱신 =====`);
  try {
    const response = await fetch(`http://localhost:${PORT}/api/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await response.json();
    if (!data.success) console.error('[cron] Refresh queue failed:', data.error);
    else console.log(`[cron] Refresh queued in Chrome Extension: "${data.post.title}"`);
  } catch (err) {
    console.error('[cron] Refresh error:', err.message);
  }
  console.log('[cron] ===== 갱신 대기 =====\n');
}

function scheduleNextPublish() {
  if (!schedulerRunning) return null;
  const nextRun = getNextPublishRuns(new Date(), 1)[0];
  if (!nextRun) return null;
  const delay = Math.max(1000, nextRun.at.getTime() - Date.now());
  schedulerTimeout = setTimeout(async () => {
    if (nextRun.mode === 'refresh') await refreshTask();
    else await hourlyTask({ category: nextRun.category });
    scheduleNextPublish();
  }, delay);
  const detail = nextRun.mode === 'refresh' ? nextRun.label : `${nextRun.label} · ${CATEGORIES[nextRun.category].name}`;
  console.log(`[cron] Next task: ${nextRun.at.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (${detail})`);
  return { ...nextRun, delay };
}

// Cron control endpoints
app.post('/api/cron/start', (req, res) => {
  if (schedulerRunning) return res.json({ message: 'Already running' });
  schedulerRunning = true;
  const nextRun = scheduleNextPublish();
  const minutes = Math.max(1, Math.ceil(nextRun.delay / 60000));
  res.json({ success: true, message: `Scheduler started. Next run in ${minutes} min`, nextRun: nextRun.at.toISOString() });
});

app.post('/api/cron/stop', (req, res) => {
  stopSchedulerNow();
  res.json({ success: true, message: 'Scheduler stopped' });
});

app.post('/api/cron/run', async (req, res) => {
  res.json({ success: true, message: 'Running now...' });
  hourlyTask({ category: req.body?.category || getCurrentCategory() });
});

app.get('/api/cron/status', (req, res) => {
  const category = getCurrentCategory();
  const catName = CATEGORIES[category]?.name || category;
  const nextRuns = getNextPublishRuns(new Date(), 5);
  res.json({
    running: schedulerRunning,
    schedule: '신규 글 2회 (KST 07:30·18:30) + 기존 글 갱신 1회 (13:30)',
    currentCategory: `${catName} (${category})`,
    nextCategories: nextRuns.map(run => {
      const time = `${String(run.hour).padStart(2, '0')}:${String(run.minute).padStart(2, '0')}`;
      const task = run.mode === 'refresh' ? run.label : `${run.label} · ${CATEGORIES[run.category].name}`;
      return `${run.at.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })} ${time}: ${task}`;
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
  console.log(`  POST /api/cron/start   - Start daily scheduler`);
  console.log(`  POST /api/cron/stop    - Stop scheduler`);
  console.log(`  POST /api/cron/run     - Run now (manual trigger)`);
  console.log(`  GET  /api/cron/status  - Scheduler status`);
  console.log(`\n⏰ 신규 글 2회 + 기존 글 갱신 1회 자동: POST /api/cron/start`);
  console.log(`🔥 즉시 실행: POST /api/cron/run`);
});
