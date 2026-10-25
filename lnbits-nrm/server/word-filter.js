// Literal matching only: operator entries are never treated as regular expressions.
export function normalizeText(value) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

const wordCharacters = '[\\p{L}\\p{N}\\p{M}\\p{Pc}]';
function pattern(terms) {
  const alternatives = [...new Set(terms.map(normalizeText))].filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!alternatives.length) return null;
  // A lookahead preserves overlapping phrases. The longest valid phrase at a
  // given position covers all shorter matches starting at that position.
  return new RegExp(`(?<!${wordCharacters})(?=(${alternatives.join('|')})(?!${wordCharacters}))`, 'gu');
}

export function compileWordFilter(filter) {
  const blocked = pattern(filter.block), allowed = pattern(filter.allow);
  return content => matches(content, blocked, allowed);
}

export function blockedByWords(content, filter) { return compileWordFilter(filter)(content); }

function matches(content, blocked, allowed) {
  if (!blocked) return false;
  const text = normalizeText(content);
  const exemptions = allowed ? [...text.matchAll(allowed)].map(match => [match.index, match.index + match[1].length]) : [];
  let next = 0, allowedUntil = -1;
  for (const match of text.matchAll(blocked)) {
    while (next < exemptions.length && exemptions[next][0] <= match.index) {
      allowedUntil = Math.max(allowedUntil, exemptions[next++][1]);
    }
    // Only an allowed phrase containing this entire blocked occurrence exempts
    // it; an unrelated allowed word elsewhere cannot permit the whole event.
    if (allowedUntil < match.index + match[1].length) return true;
  }
  return false;
}
