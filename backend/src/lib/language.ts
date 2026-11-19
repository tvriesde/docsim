/** ISO 639-1 code for "could not determine". */
export const UNKNOWN_LANGUAGE = 'und';

// Frequent function words; distinctive enough between these languages for whole documents.
const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'for', 'with', 'are', 'this', 'be', 'on', 'by', 'or', 'not', 'which', 'will', 'from', 'shall'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'op', 'te', 'voor', 'met', 'zijn', 'niet', 'aan', 'worden', 'wordt', 'bij', 'ook', 'naar', 'deze'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'mit', 'den', 'von', 'zu', 'auf', 'für', 'ein', 'eine', 'des', 'dem', 'wird', 'werden', 'sich', 'auch'],
  fr: ['le', 'la', 'les', 'et', 'des', 'est', 'une', 'du', 'que', 'pour', 'dans', 'qui', 'pas', 'sur', 'par', 'au', 'sont', 'avec', 'ou', 'ce'],
  es: ['el', 'la', 'los', 'las', 'y', 'que', 'del', 'en', 'por', 'con', 'para', 'una', 'es', 'se', 'no', 'al', 'lo', 'como', 'más', 'su'],
  it: ['il', 'di', 'che', 'e', 'la', 'per', 'non', 'una', 'sono', 'della', 'del', 'con', 'gli', 'le', 'dei', 'nel', 'alla', 'anche', 'questo', 'essere'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'do', 'da', 'em', 'um', 'uma', 'para', 'com', 'não', 'por', 'mais', 'dos', 'das', 'são'],
};
const SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v)]));

/** Heuristic language detection by stop-word frequency. Returns an ISO 639-1 code or 'und'. */
export function detectLanguage(text: string): string {
  const words = text.toLowerCase().slice(0, 50_000).match(/\p{L}+/gu) ?? [];
  if (words.length < 20) return UNKNOWN_LANGUAGE;
  const scores = Object.keys(SETS).map((lang) => {
    let n = 0;
    for (const w of words) if (SETS[lang].has(w)) n++;
    return { lang, n };
  });
  scores.sort((a, b) => b.n - a.n);
  const [best, second] = scores;
  // Need a meaningful share of stop words and a clear margin over the runner-up.
  if (best.n < Math.max(5, words.length * 0.05) || best.n < second.n * 1.2) return UNKNOWN_LANGUAGE;
  return best.lang;
}

/** Normalizes an LLM-reported language to a lowercase ISO 639-1 code, or undefined if it isn't one. */
export function normalizeLanguage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toLowerCase().slice(0, 2);
  return /^[a-z]{2}$/.test(code) && value.trim().length <= 3 ? code : undefined;
}
