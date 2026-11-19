---
name: pdf-modify
description: 'Modify text in PDF files with rules and save each result as a new version in output-pdf. Use when: editing PDF letters, replacing a title or wording in PDFs, changing signature titles (e.g. CEO to Chief Executive Officer), bulk PDF text edits, adding new PDF modification rules.'
argument-hint: 'PDF files or folders to process (default: input)'
---

# PDF Modify

Applies a set of text rules to PDF files and writes every modified file as a **new version** to `output-pdf/`. Originals are never changed.

## Current rules

| Rule | Change |
|---|---|
| `ceo-title` | If the letter is signed by the CEO (a standalone `CEO` line under the signer's name, with a closing such as "Kind regards", "Met vriendelijke groeten" or "Cordialement" in the 6 lines above it), the title becomes `Chief Executive Officer`. |

Rules live in the `RULES` list in [modify_pdf.py](./scripts/modify_pdf.py).

## Procedure

1. **Check prerequisites.** Run `python -c "import fitz"`. If it fails, install PyMuPDF with `pip install pymupdf`.
2. **Preview.** Run the script in dry-run mode to list the matches without writing files:
   ```powershell
   python .github/skills/pdf-modify/scripts/modify_pdf.py <files-or-folders> --dry-run
   ```
   If no inputs are given, the script processes `./input`.
3. **Apply.** Run it again without `--dry-run`. Each changed PDF is saved as `output-pdf/<name>_v<N>.pdf`. The script uses the next free version number, so earlier versions are kept. Add `--include-unchanged` to save a version of files that had no matches too, and `--output-dir <dir>` to choose a different folder.
4. **Verify.** Re-extract the text of the saved files and confirm the new text is present and the old text is gone. For example:
   ```powershell
   python -c "import fitz,sys; print(fitz.open(sys.argv[1])[0].get_text())" output-pdf/<name>_v1.pdf
   ```
   For layout-sensitive changes, render the page to PNG (`page.get_pixmap(dpi=110).save("check.png")`) and inspect it, then delete the image.
5. **Report** the files that were saved, the changes per file, and any files that were skipped (for example, password-protected files).

## How the script handles a PDF

The script uses [PyMuPDF](https://pymupdf.readthedocs.io) (`import fitz`).

**Open.** `fitz.open(path)` loads the document. Password-protected files (`doc.needs_pass`) are skipped.

**Read.** For each page, `page.get_text("dict", sort=True)` returns blocks, then lines, then spans, in reading order. A span is a run of text with one style and carries:
- `text`: the characters
- `bbox`: the bounding rectangle on the page
- `origin`: the baseline start point
- `font`, `size`, `flags` (bold, italic, serif, mono) and `color`

The script joins the spans of each line into a `Line` object. Every rule receives the list of lines of one page.

**Modify.** PDF text can't be edited in place, because a page is a stream of drawing commands rather than a document with flowing text. A change therefore takes three steps:
1. `page.add_redact_annot(rect, fill=False)` marks the old line. The rectangle is shrunk vertically so the lines above and below are not affected.
2. `page.apply_redactions(images=PDF_REDACT_IMAGE_NONE, graphics=PDF_REDACT_LINE_ART_NONE)` removes only the text under that mark. Images, logos and vector lines stay, and with `fill=False` no white box is drawn.
3. `page.insert_text(origin, new_text, fontname, fontsize, color)` writes the new text on the original baseline, at the original size and in the original color. The font is mapped to the closest built-in PDF font (Times, Helvetica or Courier, with bold and italic variants). The original fonts are often not embedded, or embedded only as a subset, so they may not contain the glyphs that the new text needs.

**Save.** `doc.save(target, garbage=3, deflate=True)` writes a new file and cleans up unused objects. `next_version_path` picks `<stem>_v<N>.pdf` with N set to one higher than the highest existing version in the output folder.

## Adding a rule

1. In [modify_pdf.py](./scripts/modify_pdf.py), write a function `def my_rule(lines: list[Line]) -> Iterator[Replacement]` that yields `Replacement(line, "new text", "my-rule")` for each line to replace. You can use the neighboring lines (`lines[i-1]`, `lines[i+1]`) as context, as `ceo_title_rule` does.
2. Register it: `RULES.append(Rule("my-rule", "what it changes", my_rule))`, or add it to the `RULES` list.
3. Add a row to the **Current rules** table above.
4. Run with `--dry-run` on the sample inputs to confirm that the rule matches exactly the intended lines.

## Limitations

- Rules replace whole lines. To change part of a line, yield the full new line text.
- Replacement text is not reflowed. If the new text is longer than the old text, it extends to the right, so make sure there is room (signature titles usually have room).
- Scanned or image-only PDFs have no text layer, so nothing matches. Those files need OCR first.
