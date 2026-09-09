import { load } from 'cheerio';

export function isOfficialSource(url) {
  try { return /(^|\.)(go\.kr|korea\.kr)$/.test(new URL(url).hostname); }
  catch { return false; }
}

function normalizedSourceKey(value) {
  try {
    const url = new URL(String(value).replace(/[)>.,]+$/, ''));
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.hostname.toLowerCase()}${path}`;
  } catch {
    return '';
  }
}

function extractUrls(content = '') {
  return String(content).match(/https?:\/\/[^\s<>'"\]]+/g) || [];
}

function hasUnresolvedCoreField(content = '') {
  return String(content).split(/\r?\n/).some(rawLine => {
    const line = rawLine.replace(/[*_`|>#-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line || line.length > 120) return false;
    return /(?:지원\s*금액|지원액|신청\s*기간|신청\s*방법|신청\s*대상|자격)\s*(?:은|는|:)?[^.!?]{0,45}(?:확인\s*불가|알\s*수\s*없|확인되지\s*않|자료.{0,12}없)/.test(line);
  });
}

export function extractResearch(html, limit = 7000) {
  const $ = load(html);
  $('script, style, nav, header, footer, aside, form, noscript').remove();
  const main = $('article, main, [role=main], #contents, #content, .board_view, .view_cont').toArray()
    .map(element => $(element)).sort((a, b) => b.text().length - a.text().length)[0] || $('body');
  main.find('tr').each((_, row) => {
    $(row).replaceWith('\n' + $(row).find('th, td').map((_, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get().join(' | ') + '\n');
  });
  main.find('br').replaceWith('\n');
  main.find('p, h1, h2, h3, li, section, div').append('\n');
  const lines = main.text().split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // Reserve room for later eligibility/amount/deadline tables instead of only taking the header.
  const key = lines.filter(line => /신청|지원|구간|금액|만원|기간|마감|대상|학기|202[6-9]/.test(line)).join('\n');
  const intro = lines.join('\n').slice(0, Math.floor(limit * 0.35));
  return `${intro}\n\n[조건·일정·금액 발췌]\n${key}`.slice(0, limit);
}

export function validateOfficialCoverage({ category, content, sources = [], year = new Date().getFullYear() }) {
  if (!['policy', 'benefits'].includes(category)) return { ok: true };
  const official = sources.filter(isOfficialSource);
  if (!official.length) return { ok: false, reason: '확인한 공식 기관 출처가 없어 발행을 보류합니다.' };
  const officialKeys = new Set(official.map(normalizedSourceKey).filter(Boolean));
  const linkedKeys = new Set(extractUrls(content).filter(isOfficialSource).map(normalizedSourceKey).filter(Boolean));
  if (![...linkedKeys].some(key => officialKeys.has(key))) return { ok: false, reason: '본문에 검증한 공식 출처 링크가 없습니다.' };
  if (category === 'benefits') {
    if (!content.includes(String(year))) return { ok: false, reason: '현재 적용 연도가 본문에 없습니다.' };
    if (!/신청/.test(content) || !/대상|자격/.test(content) || !/기간|상시|마감/.test(content)) return { ok: false, reason: '신청 동선·대상·기간을 확인해야 합니다.' };
    if (hasUnresolvedCoreField(content)) return { ok: false, reason: '핵심 신청 정보가 확인 불가 상태입니다.' };
    if (!/\d[\d,.]*\s*(?:만\s*)?원|전액|면제|현물/.test(content)) return { ok: false, reason: '지원 금액 또는 현물 혜택 기준이 없습니다.' };
  }
  return { ok: true };
}
