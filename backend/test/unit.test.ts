import { describe, expect, it } from 'vitest';
import { detectRepeatedEdgeLines, isPageNumber, pageEdges, removeHeaderFooter } from '../src/ingest/body.js';
import { chunkText } from '../src/ingest/embed.js';
import { detectKind, extractPages, itemsToLines } from '../src/ingest/extract.js';
import { hdbscan } from '../src/clustering/hdbscan.js';
import { computeLayout } from '../src/clustering/layout.js';
import { PROJ_DIMS, projectEmbedding } from '../src/lib/projection.js';
import { distinctiveKeywords, normalizeLine } from '../src/lib/text.js';
import { cosine, meanPool, normalize, seededRandom } from '../src/lib/vector.js';
import { makePdf, paragraphs } from '../scripts/generate-samples.js';

describe('extraction', () => {
  it('detects supported kinds', () => {
    expect(detectKind('a.PDF')).toBe('pdf');
    expect(detectKind('b.docx')).toBe('docx');
    expect(detectKind('c.txt')).toBe('text');
    expect(detectKind('d.exe')).toBeUndefined();
  });

  it('rebuilds lines from positioned items', () => {
    const lines = itemsToLines([
      { str: 'world', x: 60, y: 700, width: 30, height: 10 },
      { str: 'Hello', x: 20, y: 700.5, width: 30, height: 10 },
      { str: 'Second line', x: 20, y: 680, width: 60, height: 10 },
      { str: '  ', x: 20, y: 660, width: 5, height: 10 },
    ]);
    expect(lines).toEqual(['Hello world', 'Second line']);
  });

  it('extracts PDF pages and strips running headers/footers', async () => {
    const pdf = await makePdf('Test Title', paragraphs('contracts', 7, 9), 'DOC-X-1', 3);
    const pages = await extractPages(Buffer.from(pdf), 'pdf');
    expect(pages).toHaveLength(3);
    expect(pages[0][0]).toContain('ACME Holdings');
    const hf = detectRepeatedEdgeLines(pageEdges(pages));
    const { body, removed } = removeHeaderFooter(pages, hf);
    expect(removed).toBe(6);
    expect(body).not.toContain('ACME Holdings');
    expect(body).not.toContain('Page 2 of 3');
    expect(body.startsWith('Test Title')).toBe(true);
  });

  it('splits plain text pages on form feeds', async () => {
    const pages = await extractPages(Buffer.from('\uFEFFa\r\nb\fc'), 'text');
    expect(pages).toEqual([['a', 'b'], ['c']]);
  });
});

describe('header/footer heuristics', () => {
  it('recognizes page numbers', () => {
    for (const s of ['3', 'Page 4', 'page 2 of 10', '- 5 -', 'iv', '7/12']) expect(isPageNumber(s)).toBe(true);
    for (const s of ['Introduction', 'Page layout rules', '2024 annual report']) expect(isPageNumber(s)).toBe(false);
  });

  it('only removes matching lines at page edges', () => {
    const pages = [
      ['Header', 'Body Header mention', 'Header', 'Text one', 'x', 'y', 'z', 'w', 'Footer 1'],
      ['Header', 'Text two', 'a', 'b', 'c', 'd', 'e', 'Footer 2'],
    ];
    const { body } = removeHeaderFooter(pages, ['Header', 'Footer 9']);
    expect(body).toContain('Body Header mention');
    expect(body).not.toMatch(/Footer/);
    expect(body.split('\n').filter((l) => l === 'Header')).toHaveLength(0);
  });

  it('normalizes digits', () => {
    expect(normalizeLine('  Page 12 of 30 ')).toBe(normalizeLine('page 3 of 4'));
  });
});

describe('vectors and chunking', () => {
  it('mean-pools to a unit vector', () => {
    const v = meanPool([normalize([1, 0]), normalize([0, 1])], [1, 1]);
    expect(Math.hypot(...v)).toBeCloseTo(1);
    expect(cosine(v, [1, 1])).toBeCloseTo(1);
  });

  it('chunks long text within limits', () => {
    const text = Array.from({ length: 5000 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkText(text, 2000, 10);
    expect(chunks.length).toBe(10);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(chunkText('short')).toEqual(['short']);
  });

  it('projection preserves similarity ordering', () => {
    const rand = seededRandom(3);
    const base = normalize(Array.from({ length: 3072 }, () => rand() - 0.5));
    const near = normalize(base.map((v) => v + (rand() - 0.5) * 0.005));
    const far = normalize(Array.from({ length: 3072 }, () => rand() - 0.5));
    const [pb, pn, pf] = [base, near, far].map(projectEmbedding);
    expect(pb).toHaveLength(PROJ_DIMS);
    expect(cosine(pb, pn)).toBeGreaterThan(cosine(pb, pf));
  });

  it('extracts distinctive keywords', () => {
    const group = ['wafer stage calibration', 'wafer alignment sensor'];
    const all = [...group, 'payment invoice terms', 'supplier invoice'];
    expect(distinctiveKeywords(group, all, 3)).toContain('wafer');
  });
});

function blobs(centers: number[][], perCluster: number, spread: number, seed = 1): number[][] {
  const rand = seededRandom(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
  return centers.flatMap((c) => Array.from({ length: perCluster }, () => c.map((v) => v + gauss() * spread)));
}

describe('clustering', () => {
  it('HDBSCAN finds well-separated blobs and marks outliers as noise', () => {
    const pts = blobs([[0, 0], [20, 0], [0, 20]], 30, 1);
    pts.push([100, 100]);
    const { labels, clusterCount } = hdbscan(pts, { minClusterSize: 5 });
    expect(clusterCount).toBe(3);
    expect(labels[pts.length - 1]).toBe(-1);
    for (let b = 0; b < 3; b++) {
      const group = new Set(Array.from(labels.slice(b * 30, b * 30 + 30)).filter((l) => l >= 0));
      expect(group.size).toBe(1);
    }
  });

  it('layout clusters high-dimensional groups', () => {
    const dims = 64;
    const centers = Array.from({ length: 4 }, (_, i) => Array.from({ length: dims }, (_, d) => (d % 4 === i ? 5 : 0)));
    const vectors = blobs(centers, 15, 0.3, 9);
    const result = computeLayout(vectors);
    expect(result.coords).toHaveLength(60);
    const clusterCount = Math.max(...result.labels) + 1;
    expect(clusterCount).toBeGreaterThanOrEqual(3);
    expect(clusterCount).toBeLessThanOrEqual(6);
    // each generated group should be dominated by one cluster label
    for (let g = 0; g < 4; g++) {
      const ls = result.labels.slice(g * 15, g * 15 + 15).filter((l) => l >= 0);
      const top = Math.max(...[...new Set(ls)].map((l) => ls.filter((x) => x === l).length));
      expect(top).toBeGreaterThanOrEqual(10);
    }
  });

  it('layout handles tiny corpora', () => {
    const r = computeLayout([[1, 0], [0, 1]]);
    expect(r.coords).toHaveLength(2);
    expect(r.labels).toEqual([-1, -1]);
  });
});
