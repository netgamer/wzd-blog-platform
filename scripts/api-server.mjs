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
const PROJECT_ROOT = dirname(__dirname);
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
        max_tokens: 3000
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

// --- API Routes ---

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', queue: queue.length, completed: completed.length });
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
  const blogConfig = registry.blogs.find(b => b.id === (blogId || 'tax-yearend'));

  if (!blogConfig) return res.status(404).json({ error: 'Blog not found' });

  try {
    const topicTitle = topic || blogConfig.keywords[Math.floor(Math.random() * blogConfig.keywords.length)];

    // 1. Generate blog post
    console.log(`[generate] Creating post for ${blogConfig.id}: ${topicTitle}`);

    const content = await generateWithGroq(
      `한국 정부 정책을 쉽고 친근하게 설명하는 블로그 작가. 존댓말 사용. 전문용어 괄호 설명. 표 활용. 마크다운 ##부터 시작. 1500-2500자.`,
      `주제: ${topicTitle}\n키워드: ${blogConfig.keywords.join(', ')}\n\n${blogConfig.topic} 관련 블로그 포스트 작성. 프론트매터 없이 본문만.`
    );

    await new Promise(r => setTimeout(r, 2000));

    const title = await generateWithGroq(
      'SEO 제목 생성기. 제목만 출력.',
      `다음 글의 SEO 제목 1개 (30-50자): ${content.slice(0, 300)}`
    );
    const cleanTitle = title.trim().replace(/^["']|["']$/g, '').replace(/^\d+\.\s*/, '');

    await new Promise(r => setTimeout(r, 2000));

    const excerpt = await generateWithGroq(
      '요약 생성기. 요약만 출력.',
      `2-3문장으로 요약: ${content.slice(0, 800)}`
    );

    // 2. Create slug and filename
    const date = new Date().toISOString().split('T')[0];
    const slug = cleanTitle.toLowerCase().replace(/[^\w\s가-힣-]/g, '').replace(/\s+/g, '-').slice(0, 50);
    const filename = `${date}-${slug}.md`;
    const imageFilename = `${slug}.png`;

    // 3. Save post (with placeholder image)
    const postsDir = join(PROJECT_ROOT, 'sites', blogConfig.slug, 'content', 'posts');
    mkdirSync(postsDir, { recursive: true });

    const frontmatter = `---
title: "${cleanTitle.replace(/"/g, '\\"')}"
date: ${date}
description: "${excerpt.trim().replace(/"/g, '\\"')}"
categories: ["${blogConfig.topic}"]
tags: [${blogConfig.keywords.slice(0, 5).map(t => `"${t}"`).join(', ')}]
author: "${blogConfig.name}"
image: "/images/${imageFilename}"
---`;

    writeFileSync(join(postsDir, filename), `${frontmatter}\n\n${content}\n`, 'utf-8');
    console.log(`[generate] Post saved: ${filename}`);

    // 4. Create image prompt
    const imagePrompt = `한국 ${blogConfig.topic} 관련 "${cleanTitle}" 주제의 인포그래픽 이미지를 만들어줘.
깔끔하고 현대적인 카드뉴스 스타일, 파란색과 흰색 중심의 컬러 팔레트.
핵심 내용을 3-4개 카드/단계로 시각화. 각 단계에 아이콘 포함.
한국 정부 정책 안내 인포그래픽 느낌. 가로 16:9 비율. 1200x630 사이즈.`;

    // 5. Queue image job
    const job = {
      id: Date.now().toString(),
      blogId: blogConfig.id,
      blogSlug: blogConfig.slug,
      postFilename: filename,
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
    // Save image to Hugo static dir
    const imagesDir = join(PROJECT_ROOT, 'sites', job.blogSlug, 'static', 'images');
    mkdirSync(imagesDir, { recursive: true });
    const imagePath = join(imagesDir, job.imageFilename);
    writeFileSync(imagePath, req.file.buffer);

    console.log(`[upload] Image saved: ${imagePath} (${(req.file.buffer.length / 1024).toFixed(0)}KB)`);

    // Update job status
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    completed.push(job);

    // Auto-deploy
    deployBlog(job.blogSlug);

    res.json({ success: true, message: 'Image saved and deploy triggered' });
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
    execSync(`cd ${PROJECT_ROOT} && git add -A && git commit -m "post: auto-generated for ${blogSlug}" && git push`, {
      stdio: 'pipe',
      timeout: 30000
    });
    console.log(`[deploy] Pushed to GitHub. GitHub Actions will build and deploy.`);
  } catch (err) {
    console.log(`[deploy] Git push result:`, err.stdout?.toString().slice(0, 200) || err.message);
  }
}

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Blog API Server running at http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /api/health    - Health check`);
  console.log(`  GET  /api/blogs     - List blogs`);
  console.log(`  POST /api/generate  - Generate post + queue image`);
  console.log(`  GET  /api/queue     - Get pending image jobs`);
  console.log(`  POST /api/upload    - Upload completed image`);
  console.log(`  GET  /api/jobs      - All jobs status`);
  console.log(`\nChrome Extension polls /api/queue for image generation tasks`);
});
