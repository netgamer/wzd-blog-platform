#!/usr/bin/env node
/**
 * Blog Post Image Generator
 * Uses Gemini Imagen 3 (free) or Pollinations.ai (free fallback)
 *
 * Usage: node scripts/image-generate.mjs <blog_id> [post_filename]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- Image Generation Methods ---

// Method 1: Pollinations.ai (completely free, no API key)
async function generateWithPollinations(prompt, outputPath) {
  const encodedPrompt = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1200&height=630&nologo=true&model=flux`;

  console.log('Using Pollinations.ai...');
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });

  if (!res.ok) throw new Error(`Pollinations error: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(outputPath, buffer);
  console.log(`Image saved: ${outputPath} (${(buffer.length / 1024).toFixed(0)}KB)`);
  return outputPath;
}

// Method 2: Gemini Imagen 3 (free tier)
async function generateWithGemini(prompt, outputPath) {
  if (!GEMINI_API_KEY) throw new Error('No GEMINI_API_KEY');

  console.log('Using Gemini Imagen 3...');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: '16:9',
        safetyFilterLevel: 'BLOCK_ONLY_HIGH'
      }
    }),
    signal: AbortSignal.timeout(60000)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.predictions?.[0]?.bytesBase64Encoded) {
    const buffer = Buffer.from(data.predictions[0].bytesBase64Encoded, 'base64');
    writeFileSync(outputPath, buffer);
    console.log(`Image saved: ${outputPath} (${(buffer.length / 1024).toFixed(0)}KB)`);
    return outputPath;
  }

  throw new Error('No image in Gemini response');
}

// Try Gemini first, fallback to Pollinations
async function generateImage(prompt, outputPath) {
  // Try Gemini Imagen 3 first
  if (GEMINI_API_KEY) {
    try {
      return await generateWithGemini(prompt, outputPath);
    } catch (err) {
      console.warn('Gemini failed:', err.message);
      console.log('Falling back to Pollinations.ai...');
    }
  }

  // Fallback: Pollinations.ai
  return await generateWithPollinations(prompt, outputPath);
}

// Create image prompt from post content
function createImagePrompt(title, topic) {
  const topicStyles = {
    '연말정산': 'tax documents, calculator, Korean won coins being refunded, receipt papers, government building',
    '실업급여': 'job search documents, employment office interior, supportive hands, briefcase, resume',
    '청년정책': 'young Korean professionals, city skyline Seoul, graduation cap, modern apartment, hopeful',
    '근로장려금': 'Korean working family, paycheck envelope, government support, growing savings chart',
    '주택청약': 'modern Korean apartment buildings, house keys, savings passbook, residential area',
  };

  const visual = topicStyles[topic] || 'government policy documents, professional office setting';

  return `Clean modern professional blog hero image. Subject: ${title}. Visual elements: ${visual}. Style: bright clean photography-like illustration, blue and white color palette, trustworthy informational feel. NO text or letters or words in the image. Horizontal 16:9 layout.`;
}

// --- Main ---

async function main() {
  const blogId = process.argv[2];
  if (!blogId) {
    console.error('Usage: node scripts/image-generate.mjs <blog_id> [post_filename]');
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

  // Get posts to process
  let postFiles;
  if (process.argv[3]) {
    postFiles = [process.argv[3]];
  } else {
    postFiles = readdirSync(postsDir).filter(f => f.endsWith('.md'));
  }

  for (const filename of postFiles) {
    const filepath = join(postsDir, filename);
    let content = readFileSync(filepath, 'utf-8');

    // Extract frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    const fm = fmMatch[1];
    const titleMatch = fm.match(/title:\s*"(.+?)"/);
    const imageMatch = fm.match(/image:\s*"(.+?)"/);
    const title = titleMatch?.[1] || filename;
    const currentImage = imageMatch?.[1] || '';

    // Skip if already has a local image
    if (currentImage.startsWith('/images/')) {
      console.log(`Skipping ${filename} - already has local image`);
      continue;
    }

    const slug = filename.replace('.md', '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
    const imgFilename = `${slug}.png`;
    const imgPath = join(imagesDir, imgFilename);

    const prompt = createImagePrompt(title, blogConfig.topic);

    try {
      await generateImage(prompt, imgPath);

      // Update frontmatter to use local image
      const newImage = `/images/${imgFilename}`;
      content = content.replace(
        /image:\s*".*?"/,
        `image: "${newImage}"`
      );
      writeFileSync(filepath, content, 'utf-8');
      console.log(`Updated ${filename} -> image: ${newImage}\n`);
    } catch (err) {
      console.error(`Failed for ${filename}:`, err.message);
    }

    // Rate limit between requests
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log('All done!');
}

main();
