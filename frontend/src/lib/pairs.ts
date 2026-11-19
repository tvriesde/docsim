import { useState } from 'react'
import type { Pair, PairDoc } from './api'

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

export type Band = 'identical' | 'very' | 'similar'

export const BANDS: Record<Band, { label: string; min: number; color: string; tone: 'danger' | 'warning' | 'info' }> = {
  identical: { label: 'Near-identical', min: 0.97, color: '#fb7185', tone: 'danger' },
  very: { label: 'Very similar', min: 0.93, color: '#fbbf24', tone: 'warning' },
  similar: { label: 'Similar', min: 0, color: '#38bdf8', tone: 'info' },
}

export function bandOf(score: number): Band {
  if (score >= BANDS.identical.min) return 'identical'
  if (score >= BANDS.very.min) return 'very'
  return 'similar'
}

const THRESHOLD_KEY = 'docsim.dupThreshold'
export const DEFAULT_THRESHOLD = 0.92

/** Duplicate threshold shared by the Near-duplicates page and the map overlay. */
export function useDupThreshold(): [number, (v: number) => void] {
  const [value, setValue] = useState(() => {
    const v = Number.parseFloat(localStorage.getItem(THRESHOLD_KEY) ?? '')
    return Number.isFinite(v) ? v : DEFAULT_THRESHOLD
  })
  return [
    value,
    (v: number) => {
      localStorage.setItem(THRESHOLD_KEY, String(v))
      setValue(v)
    },
  ]
}

const SAME_LANG_KEY = 'docsim.dupSameLanguage'

/** "Same language only" filter shared by the Near-duplicates page and the map overlay. */
export function useSameLanguage(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => localStorage.getItem(SAME_LANG_KEY) === '1')
  return [
    value,
    (v: boolean) => {
      localStorage.setItem(SAME_LANG_KEY, v ? '1' : '0')
      setValue(v)
    },
  ]
}

const known = (lang?: string) => (lang && lang !== 'und' ? lang : undefined)

/** True when both documents have a known language and it differs. Unknown languages never exclude a pair. */
export function differentLanguage(p: Pair, docs: Record<string, PairDoc>): boolean {
  const a = known(docs[p.a]?.language)
  const b = known(docs[p.b]?.language)
  return Boolean(a && b && a !== b)
}

const LANGUAGE_NAMES = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'language' }) : null

/** Human-readable language name for an ISO 639-1 code. */
export function languageName(code?: string): string {
  if (!known(code)) return 'Unknown'
  try {
    return LANGUAGE_NAMES?.of(code!) ?? code!.toUpperCase()
  } catch {
    return code!.toUpperCase()
  }
}

/**
 * Complete-linkage groups: every member of a group is linked (score >= threshold, not dismissed) to every other
 * member, so A~B and B~C never chain A and C together unless A~C as well.
 */
export function groupPairs(pairs: Pair[]): string[][] {
  const linked = new Set(pairs.map((p) => pairKey(p.a, p.b)))
  const groupOf = new Map<string, Set<string>>()
  const allLinked = (xs: Iterable<string>, ys: Iterable<string>) => {
    const ylist = [...ys]
    for (const x of xs) for (const y of ylist) if (x !== y && !linked.has(pairKey(x, y))) return false
    return true
  }
  for (const p of [...pairs].sort((x, y) => y.score - x.score)) {
    const ga = groupOf.get(p.a)
    const gb = groupOf.get(p.b)
    if (ga && ga === gb) continue
    if (!ga && !gb) {
      const g = new Set([p.a, p.b])
      groupOf.set(p.a, g)
      groupOf.set(p.b, g)
    } else if (ga && !gb) {
      if (allLinked(ga, [p.b])) {
        ga.add(p.b)
        groupOf.set(p.b, ga)
      }
    } else if (!ga && gb) {
      if (allLinked(gb, [p.a])) {
        gb.add(p.a)
        groupOf.set(p.a, gb)
      }
    } else if (ga && gb && allLinked(ga, gb)) {
      for (const id of gb) {
        ga.add(id)
        groupOf.set(id, ga)
      }
    }
  }
  return [...new Set(groupOf.values())].map((g) => [...g])
}

/** Suggested document to keep: the most recently updated, then the longest. */
export function canonicalOf(ids: string[], docs: Record<string, PairDoc>): string {
  return [...ids].sort((x, y) => {
    const dx = docs[x]
    const dy = docs[y]
    return (dy?.updatedAt ?? '').localeCompare(dx?.updatedAt ?? '') || (dy?.bodyChars ?? 0) - (dx?.bodyChars ?? 0)
  })[0]
}
