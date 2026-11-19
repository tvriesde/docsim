"""Apply text-modification rules to PDFs and save each result as a new version.

Usage:
    python modify_pdf.py [inputs ...] [--output-dir output-pdf] [--dry-run] [--include-unchanged]

Inputs can be PDF files or folders (searched recursively). Defaults to ./input.
Each modified file is written to <output-dir>/<stem>_v<N>.pdf, where N is one higher
than the highest version already present, so earlier versions are never overwritten.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

import fitz  # PyMuPDF


@dataclass
class Line:
    page: fitz.Page
    index: int  # position of the line in reading order on the page
    text: str
    spans: list[dict]

    @property
    def bbox(self) -> fitz.Rect:
        r = fitz.Rect(self.spans[0]["bbox"])
        for s in self.spans[1:]:
            r |= fitz.Rect(s["bbox"])
        return r


@dataclass
class Replacement:
    line: Line
    new_text: str
    rule: str


@dataclass
class Rule:
    name: str
    description: str
    find: Callable[[list[Line]], Iterator[Replacement]]


# --------------------------------------------------------------------------- rules
# Add new rules below and register them in RULES. A rule receives all lines of one
# page (in reading order) and yields Replacement objects for whole lines.

CLOSING_RE = re.compile(
    r"(?i)\b(kind regards|best regards|regards|sincerely|yours faithfully|"
    r"met vriendelijke groet(en)?|hoogachtend|cordialement|salutations|mit freundlichen grüßen)\b"
)
CEO_TITLE_RE = re.compile(r"^\s*CEO\s*$")


def ceo_title_rule(lines: list[Line]) -> Iterator[Replacement]:
    """A standalone 'CEO' line in a signature block -> 'Chief Executive Officer'.

    A signature block is detected when a closing salutation appears within the 6 lines
    above the title line. The signer's name sits between the closing and the title.
    """
    for i, line in enumerate(lines):
        if not CEO_TITLE_RE.match(line.text):
            continue
        context = lines[max(0, i - 6):i]
        if any(CLOSING_RE.search(l.text) for l in context):
            yield Replacement(line, "Chief Executive Officer", "ceo-title")


RULES: list[Rule] = [
    Rule("ceo-title", "Signed by the CEO: replace title 'CEO' with 'Chief Executive Officer'", ceo_title_rule),
]

# --------------------------------------------------------------------------- PDF helpers


def page_lines(page: fitz.Page) -> list[Line]:
    lines: list[Line] = []
    for block in page.get_text("dict", sort=True)["blocks"]:
        for l in block.get("lines", []):
            spans = [s for s in l["spans"] if s["text"]]
            if spans:
                text = "".join(s["text"] for s in spans)
                lines.append(Line(page, len(lines), text, spans))
    return lines


def base14_font(span: dict) -> str:
    """Map the original font to a built-in PDF font with a similar look.

    Original fonts are often non-embedded or subset, so they may not contain the
    glyphs for the new text; a base-14 font always works.
    """
    name = span["font"].lower()
    flags = span["flags"]
    bold = bool(flags & 16) or "bold" in name
    italic = bool(flags & 2) or "italic" in name or "oblique" in name
    if "courier" in name or "mono" in name or flags & 8:
        family = ("cour", "cobo", "coit", "cobi")
    elif "sans" not in name and ("times" in name or "serif" in name or flags & 4):
        family = ("tiro", "tibo", "tiit", "tibi")
    else:
        family = ("helv", "hebo", "heit", "hebi")
    return family[int(bold) + 2 * int(italic)]


def apply_replacements(page: fitz.Page, reps: list[Replacement]) -> None:
    # 1. Mark the old text for removal. Shrink vertically so neighbouring lines are untouched.
    for rep in reps:
        r = rep.line.bbox
        h = r.height * 0.2
        page.add_redact_annot(fitz.Rect(r.x0, r.y0 + h, r.x1, r.y1 - h), fill=False)
    # 2. Remove only text; keep images and vector graphics (logos, lines) intact.
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
    # 3. Write the new text at the original baseline with matching size and colour.
    for rep in reps:
        span = rep.line.spans[0]
        c = span["color"]
        color = ((c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255)
        page.insert_text(span["origin"], rep.new_text, fontname=base14_font(span),
                         fontsize=span["size"], color=color)


def next_version_path(out_dir: Path, stem: str) -> Path:
    pattern = re.compile(rf"^{re.escape(stem)}_v(\d+)\.pdf$", re.IGNORECASE)
    versions = [int(m.group(1)) for p in out_dir.glob(f"{stem}_v*.pdf") if (m := pattern.match(p.name))]
    return out_dir / f"{stem}_v{max(versions, default=0) + 1}.pdf"


def process(path: Path, out_dir: Path, dry_run: bool, include_unchanged: bool) -> int:
    doc = fitz.open(path)
    if doc.needs_pass:
        print(f"SKIP  {path} (password protected)")
        return 0
    changes = 0
    for page in doc:
        lines = page_lines(page)
        reps = [rep for rule in RULES for rep in rule.find(lines)]
        for rep in reps:
            print(f"  p{page.number + 1} [{rep.rule}] {rep.line.text.strip()!r} -> {rep.new_text!r}")
        if reps and not dry_run:
            apply_replacements(page, reps)
        changes += len(reps)

    if dry_run or (changes == 0 and not include_unchanged):
        print(f"{'DRY ' if dry_run else 'SAME'}  {path} ({changes} change(s))")
        return changes

    out_dir.mkdir(parents=True, exist_ok=True)
    target = next_version_path(out_dir, path.stem)
    doc.save(target, garbage=3, deflate=True)
    print(f"SAVED {path} -> {target} ({changes} change(s))")
    return changes


def collect(inputs: list[str]) -> list[Path]:
    files: list[Path] = []
    for item in inputs:
        p = Path(item)
        files += sorted(p.rglob("*.pdf")) if p.is_dir() else [p]
    return files


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="*", default=["input"], help="PDF files or folders (default: input)")
    ap.add_argument("--output-dir", default="output-pdf")
    ap.add_argument("--dry-run", action="store_true", help="report changes without writing files")
    ap.add_argument("--include-unchanged", action="store_true", help="also save files without changes")
    args = ap.parse_args()

    files = collect(args.inputs)
    if not files:
        print("No PDF files found.", file=sys.stderr)
        return 1
    out_dir = Path(args.output_dir)
    total = sum(process(f, out_dir, args.dry_run, args.include_unchanged) for f in files)
    print(f"\n{len(files)} file(s) processed, {total} change(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
