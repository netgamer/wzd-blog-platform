import test from 'node:test';
import assert from 'node:assert/strict';
import { extractResearch, isOfficialSource, validateOfficialCoverage } from '../scripts/research-quality.mjs';
import { validateArticleContent, stripAssistantPreamble } from '../scripts/content-quality.mjs';

const official = 'https://www.kosaf.go.kr/ko/notice.do?seqNo=21169';
const body = `2026년 지원 대상 대학생의 신청 기간은 9월 9일까지, 지원액 600만원. [공식 신청](${official})`;
test('official host check does not accept lookalike hosts', () => {
  assert.ok(isOfficialSource(official)); assert.ok(!isOfficialSource('https://kosaf.go.kr.attacker.test/'));
});
test('benefits with missing official material cannot publish', () => {
  assert.equal(validateOfficialCoverage({ category: 'benefits', content: body, sources: [] }).ok, false);
  assert.equal(validateOfficialCoverage({ category: 'benefits', content: body, sources: [official], year: 2026 }).ok, true);
});
test('official coverage accepts tracking parameters on the same verified path', () => {
  const source = 'https://www.korea.kr/news/policyNewsView.do?newsId=1';
  const content = '2026년 신청 대상과 기간, 지원 금액 30만원. [공식 출처](https://www.korea.kr/news/policyNewsView.do?newsId=1&utm_source=chatgpt.com)';
  assert.equal(validateOfficialCoverage({ category: 'benefits', content, sources: [source], year: 2026 }).ok, true);
});
test('placeholder amounts and past-year-only content are blocked', () => {
  assert.equal(validateOfficialCoverage({ category: 'benefits', content: body + '\n지원 금액은 확인 불가', sources: [official], year: 2026 }).ok, false);
  assert.equal(validateOfficialCoverage({ category: 'benefits', content: body.replace('2026', '2024'), sources: [official], year: 2026 }).ok, false);
});
test('a caveat about an unknown office address does not block verified core fields', () => {
  const content = `${body}\n방문 신청은 가능하지만 행정복지센터의 개별 주소나 운영시간은 제공 자료에 명시돼 있지 않습니다.`;
  assert.equal(validateOfficialCoverage({ category: 'benefits', content, sources: [official], year: 2026 }).ok, true);
});
test('research preserves late eligibility tables and drops navigation', () => {
  const text = extractResearch('<nav>MENU</nav><main><p>' + '소개 '.repeat(1200) + '</p><table><tr><td>2026년 지원액</td><td>600만원</td></tr></table></main>');
  assert.ok(text.includes('2026년 지원액 | 600만원')); assert.ok(!text.includes('MENU'));
});
test('preambles are removed and empty recommended venues remain blocked', () => {
  assert.equal(stripAssistantPreamble('요청하신 글입니다.\n## 제목\n본문'), '## 제목\n본문');
  assert.equal(validateArticleContent({ category: 'lifestyle', title: '계곡 추천', content: '## 추천 명소\n추천 명소 2 확인 불가' }).ok, false);
});
