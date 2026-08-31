const ALLOWED_ORIGIN = 'https://news.wzd.kr';
const BOT_PATTERN = /bot|crawler|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless/i;

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
});

function getKoreanDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isSameOrigin(request) {
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  return (!origin || origin === ALLOWED_ORIGIN) && (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none');
}

export class DailyStats {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.method === 'GET') {
      const values = await this.ctx.storage.get(['views', 'visitors']);
      return json({ views: values.get('views') || 0, visitors: values.get('visitors') || 0 });
    }

    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    const { visitorHash } = await request.json();
    if (!visitorHash || typeof visitorHash !== 'string') return json({ error: 'invalid visitor' }, 400);

    const result = await this.ctx.storage.transaction(async (tx) => {
      const visitorKey = `visitor:${visitorHash}`;
      const values = await tx.get(['views', 'visitors', visitorKey]);
      const views = (values.get('views') || 0) + 1;
      let visitors = values.get('visitors') || 0;

      await tx.put('views', views);
      if (!values.get(visitorKey)) {
        visitors += 1;
        await tx.put({ visitors, [visitorKey]: true });
      }
      return { views, visitors };
    });

    return json(result);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/stats') return json({ error: 'not found' }, 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!isSameOrigin(request)) return json({ error: 'forbidden' }, 403);

    const date = getKoreanDate();
    const id = env.STATS.idFromName(date);
    const counter = env.STATS.get(id);

    if (request.method === 'GET') {
      const response = await counter.fetch('https://stats.internal/');
      const stats = await response.json();
      return json({ date, ...stats });
    }

    const userAgent = request.headers.get('User-Agent') || '';
    const isVerifiedBot = request.cf && request.cf.botManagement && request.cf.botManagement.verifiedBot;
    if (!userAgent || BOT_PATTERN.test(userAgent) || isVerifiedBot) {
      const response = await counter.fetch('https://stats.internal/');
      const stats = await response.json();
      return json({ date, ...stats, counted: false });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid json' }, 400);
    }
    if (typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.length > 300) {
      return json({ error: 'invalid path' }, 400);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const salt = env.VISITOR_SALT;
    if (!salt) return json({ error: 'server configuration error' }, 503);
    const visitorHash = await sha256(`${date}:${salt}:${ip}:${userAgent}`);
    const response = await counter.fetch('https://stats.internal/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorHash })
    });
    const stats = await response.json();
    return json({ date, ...stats, counted: true });
  }
};
