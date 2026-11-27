/** Unicode-safe player-name and chat normalization. */

const CONFUSABLES = new Map(Object.entries({
  // Common Greek lookalikes.
  'Α': 'a', 'α': 'a', 'Β': 'b', 'β': 'b', 'Ε': 'e', 'ε': 'e', 'Ζ': 'z', 'ζ': 'z',
  'Η': 'h', 'η': 'h', 'Ι': 'i', 'ι': 'i', 'Κ': 'k', 'κ': 'k', 'Μ': 'm', 'μ': 'm',
  'Ν': 'n', 'ν': 'v', 'Ο': 'o', 'ο': 'o', 'Ρ': 'p', 'ρ': 'p', 'Τ': 't', 'τ': 't',
  'Υ': 'y', 'υ': 'y', 'Χ': 'x', 'χ': 'x', 'ϲ': 'c',
  // Common Cyrillic lookalikes.
  'А': 'a', 'а': 'a', 'В': 'b', 'в': 'b', 'Е': 'e', 'е': 'e', 'Ё': 'e', 'ё': 'e',
  'К': 'k', 'к': 'k', 'М': 'm', 'м': 'm', 'Н': 'h', 'н': 'h', 'О': 'o', 'о': 'o',
  'Р': 'p', 'р': 'p', 'С': 'c', 'с': 'c', 'Т': 't', 'т': 't', 'У': 'y', 'у': 'y',
  'Х': 'x', 'х': 'x', 'І': 'i', 'і': 'i', 'Ј': 'j', 'ј': 'j', 'Ӏ': 'l', 'ӏ': 'l',
}));

function normalizeVisibleText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[<>]/g, '')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
    .slice(0, maxLength);
}

export function cleanDisplayName(value) {
  return normalizeVisibleText(value, 18);
}

export function cleanChatText(value) {
  return normalizeVisibleText(value, 350);
}

/**
 * A conservative confusable skeleton for table-local uniqueness checks.
 * This intentionally supplements, rather than replaces, NFKC normalization.
 */
export function displayNameSkeleton(value) {
  const normalized = cleanDisplayName(value).toLowerCase();
  return [...normalized].map((character) => CONFUSABLES.get(character) ?? character).join('');
}
