const PLACEHOLDER_PATTERN = /(?:확인\s*(?:이\s*)?불가|특정\s*(?:장소|명소|상호)?\s*(?:이\s*)?불가|특정할\s*수\s*없|구체적(?:인)?\s*(?:장소|명소|상호|정보).*없|참고\s*자료(?:에서|에는)?.*(?:없|않)|제공된\s*자료(?:에서|에는)?.*(?:없|않))/gi;
const GENERIC_NAME_PATTERN = /^(?:추천\s*)?(?:명소|장소|맛집|카페|코스)\s*\d+$/i;
const ASSISTANT_PREAMBLE_PATTERN = /^(?:요청하신|요청하신\s*조건|아래는|다음은|제공(?:해\s*주신|된)\s*(?:자료|참고\s*자료)|참고\s*자료를\s*바탕으로|조건에\s*맞춰)/i;

export function stripAssistantPreamble(content = '') {
  const clean = String(content).trim();
  const firstHeading = clean.search(/^##\s+/m);
  if (firstHeading <= 0) return clean;
  const prefix = clean.slice(0, firstHeading).replace(/[*_`>#-]/g, '').trim();
  return ASSISTANT_PREAMBLE_PATTERN.test(prefix) ? clean.slice(firstHeading).trim() : clean;
}

function sectionAfterHeading(content, headingPattern) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(line => /^##\s+/.test(line) && headingPattern.test(line));
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex(line => /^##\s+/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join('\n');
}

function concreteNames(section) {
  const names = new Set();

  for (const line of section.split(/\r?\n/)) {
    const heading = line.match(/^###\s+(?:\d+[.)]\s*)?(.+?)\s*$/);
    if (heading) {
      const name = heading[1].replace(/[*_`]/g, '').trim();
      if (name && !GENERIC_NAME_PATTERN.test(name) && !PLACEHOLDER_PATTERN.test(name)) names.add(name);
      PLACEHOLDER_PATTERN.lastIndex = 0;
      continue;
    }

    if (!/^\s*\|/.test(line) || /^\s*\|?\s*:?-{3,}/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(cell => cell.replace(/[*_`]/g, '').trim());
    const name = cells[0] || '';
    if (!name || /^(?:구분|명소|장소명|추천\s*장소|추천\s*명소|상호|맛집|카페)$/i.test(name)) continue;
    const row = cells.join(' ');
    if (GENERIC_NAME_PATTERN.test(name) || PLACEHOLDER_PATTERN.test(row)) {
      PLACEHOLDER_PATTERN.lastIndex = 0;
      continue;
    }
    PLACEHOLDER_PATTERN.lastIndex = 0;
    names.add(name);
  }

  return names;
}

export function validateArticleContent({ category, title = '', content = '' }) {
  if (/CONTENT_QUALITY_BLOCKED/i.test(content)) {
    return { ok: false, reason: '참고 자료가 부족해 작성 단계에서 중단되었습니다.' };
  }

  if (ASSISTANT_PREAMBLE_PATTERN.test(String(content).trim())) {
    return { ok: false, reason: 'AI 답변용 안내 문구가 본문 첫머리에 남아 있습니다.' };
  }

  const placeholderCount = (content.match(PLACEHOLDER_PATTERN) || []).length;
  PLACEHOLDER_PATTERN.lastIndex = 0;
  if (placeholderCount >= 5) {
    return { ok: false, reason: `확인 불가 항목이 지나치게 많습니다 (${placeholderCount}건).` };
  }

  if (category !== 'lifestyle') return { ok: true };

  if (placeholderCount >= 2 || /(?:추천\s*)?(?:명소|맛집|카페)\s*[2-9]/i.test(content)) {
    return { ok: false, reason: `확인 불가 또는 임시 추천 항목이 포함되어 있습니다 (${placeholderCount}건).` };
  }

  const foodFocused = /맛집|카페|디저트|음식/.test(title);
  if (foodFocused) {
    const foodSection = sectionAfterHeading(content, /맛집|카페|먹거리|추천\s*(?:곳|장소)/i);
    const foodNames = concreteNames(foodSection);
    if (foodNames.size < 3) {
      return { ok: false, reason: `검증 가능한 맛집·카페가 부족합니다 (${foodNames.size}/3).` };
    }
    return { ok: true };
  }

  const destinationSection = sectionAfterHeading(content, /추천\s*명소|명소\s*정보|가볼\s*만한\s*곳|추천\s*코스/i);
  const destinationNames = concreteNames(destinationSection);
  if (destinationNames.size < 3) {
    return { ok: false, reason: `검증 가능한 추천 명소가 부족합니다 (${destinationNames.size}/3).` };
  }

  const diningSection = sectionAfterHeading(content, /맛집|카페|먹거리/i);
  const diningNames = concreteNames(diningSection);
  if (diningNames.size < 2) {
    return { ok: false, reason: `검증 가능한 주변 맛집·카페가 부족합니다 (${diningNames.size}/2).` };
  }

  return { ok: true };
}
