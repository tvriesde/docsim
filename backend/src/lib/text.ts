const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
    'may more most must no not of on or our out over shall she should so such than that the their them then there these ' +
    'they this those through to under up upon us was we were what when where which while who whom why will with would ' +
    'you your also any all each other only same some very about after again against before being below between both ' +
    'during few further here just nor now off once own too until above down per via within without page de het een van ' +
    'en der die das und le la les et document section'
  ).split(/\s+/),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}][\p{L}\p{N}'-]{1,}/gu) ?? []).filter((t) => !STOPWORDS.has(t) && t.length > 2);
}

/** Top keywords of a group of texts relative to a background corpus (simple TF-IDF style scoring). */
export function distinctiveKeywords(groupTexts: string[], allTexts: string[], top = 6): string[] {
  const df = new Map<string, number>();
  for (const t of allTexts) for (const w of new Set(tokenize(t))) df.set(w, (df.get(w) ?? 0) + 1);
  const tf = new Map<string, number>();
  for (const t of groupTexts) for (const w of new Set(tokenize(t))) tf.set(w, (tf.get(w) ?? 0) + 1);
  const n = Math.max(allTexts.length, 1);
  return [...tf.entries()]
    .map(([w, c]) => [w, (c / groupTexts.length) * Math.log(1 + n / (df.get(w) ?? 1))] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([w]) => w);
}

/** Normalizes a header/footer line so page numbers and dates match across pages. */
export function normalizeLine(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
