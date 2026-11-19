import mammoth from 'mammoth';
import { extractTextItems } from 'unpdf';

export type DocKind = 'pdf' | 'docx' | 'text';

const EXT_KIND: Record<string, DocKind> = {
  pdf: 'pdf',
  docx: 'docx',
  txt: 'text',
  md: 'text',
  text: 'text',
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXT_KIND);

export function detectKind(fileName: string): DocKind | undefined {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return EXT_KIND[ext];
}

export function mimeFor(kind: DocKind): string {
  switch (kind) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default:
      return 'text/plain';
  }
}

interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rebuilds visual lines from positioned PDF text items (top to bottom, left to right). */
export function itemsToLines(items: PositionedItem[]): string[] {
  const visible = items.filter((i) => i.str.trim().length > 0);
  visible.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PositionedItem[][] = [];
  for (const item of visible) {
    const current = lines[lines.length - 1];
    const tolerance = Math.max(2, (item.height || 10) * 0.5);
    if (current && Math.abs(current[0].y - item.y) <= tolerance) current.push(item);
    else lines.push([item]);
  }
  return lines.map((line) => {
    line.sort((a, b) => a.x - b.x);
    let out = '';
    let prevEnd = Number.NEGATIVE_INFINITY;
    for (const it of line) {
      const gap = it.x - prevEnd;
      if (out && gap > (it.height || 10) * 0.15 && !out.endsWith(' ') && !it.str.startsWith(' ')) out += ' ';
      out += it.str;
      prevEnd = it.x + it.width;
    }
    return out.replace(/\s+/g, ' ').trim();
  });
}

/** Returns the document text as pages of lines. DOCX and text files are a single page unless split by form feeds. */
export async function extractPages(data: Buffer, kind: DocKind): Promise<string[][]> {
  if (kind === 'pdf') {
    const { items } = await extractTextItems(new Uint8Array(data));
    return items.map((pageItems) => itemsToLines(pageItems as PositionedItem[]));
  }
  let text: string;
  if (kind === 'docx') {
    text = (await mammoth.extractRawText({ buffer: data })).value;
  } else {
    text = data.toString('utf8').replace(/^\uFEFF/, '');
  }
  return text
    .replace(/\r\n?/g, '\n')
    .split('\f')
    .map((page) => page.split('\n').map((l) => l.trimEnd()));
}
