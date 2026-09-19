---
name: document-processing-and-graphics
display-name: Document Processing, Visualizations, and Graphics
description: Create, read, edit, and redline Word and other documents; create diagrams, charts, data visualizations, and standalone graphics.
user-invocable: false
---

## Document Processing, Visualizations, and Graphics

When editing an existing document, change only what's needed for the request. Keep the rest of the content and styling intact.

Before overwriting an Office file, check for signs it is open, like a nearby `~$` lock file. Warn that Word may not refresh an already-open document until it is reopened.

Check for overlapping elements, clipped content, poor spacing, and other visual issues. Refine the document until it looks intentional and polished.

### Style

Do not overly use gradients and shadows. Do not use pale, low opacity, low vibrancy colors that look "calm". Make text and shapes legible, use clean colors. When text is on background, check contrast and adjust text color if needed.

If there are patterns in user's existing documents, follow them.

#### Typography

For boring documents, use the default font. For creative work like diagrams or PowerPoint, choose a font based on context:
* on macOS: San Francisco (SFNS.ttf), HelveticaNeue.ttc, Futura.ttc, Georgia.ttf, etc.
* on Windows/Linux: Arial, Trebuchet MS, Verdana, Georgia, etc.

If you need to use fonts in Pillow, stage the font files first. NEVER use Arial over Helvetica. NEVER set a negative letter-spacing.

#### Color Palette

For documents and diagrams, start with one of these palettes:
* Formal: `#F6F7F8`, `#18212B`, `#0868E0`, `#9CBFDF`, `#C66A36`
* Casual 1: `#F5F1E8`, `#26332F`, `#F48067`, `#00B49B`, `#FFEFAE`
* Casual 2: `#EDF2EF`, `#24312D`, `#217F73`, `#A5CBB4`, `#E46146`
* Modernist: `#F2F0E9`, `#181817`, `#E33B2E`, `#1458C0`, `#F0BB24`

### Redlining

For redlining, review, or comment requests in Word documents, use Office's tracked changes feature. Understand the context, and do not overdo it if the user asked for casual comments.

Match tracked changes to the edit: if only one word changes, track only that word, not the whole sentence. If you're rewriting a phrase or clause, keep it together as one deletion and one insertion rather than splitting it word by word, even if some words stay the same. Leave surrounding text alone and keep separate edits separate. Add a brief comment only when helpful. Do not specify the optional `w:date` attribute on comments and tracked changes unless the user asks for a specific date.

When editing DOCX XML directly:
* Use a namespace-aware XML parser, not regex or string replacement.
* A `w:p` has at most one leading `w:pPr`; inside `w:del`, use `w:delText`, not `w:t`.
* A single `w:del` or `w:ins` can contain multiple formatted runs. Don't split a revision just because the formatting changes, or merge across existing revisions or structural boundaries.
* Preserve non-text markup and keep comments, relationships, and content types synchronized.

### Filling Forms / Templates

When asked to fill forms or templates, do only what the user asked. Do not make unnecessary content or appearance changes.

### Diagrams

When asked to create graphs or diagrams, hand-generate them in SVG format unless the user explicitly asks otherwise.

Inspect every rendered diagram. Treat the initial layout and container bounds as provisional. Check every label, especially right and bottom padding; no text may overlap or overflow. Resize containers and position their icon/text content as one balanced group with consistent gaps. Check connectors and make sure arrowheads are sized correctly. Keep refining until the diagram looks intentional and 100% perfect.

### PDF

Visually inspect every PDF you create or modify before delivering it. Check page breaks, clipping, margins, overlaps, blank pages, inconsistent spacing, and text or images crossing page bounds. Keep refining until the PDF looks intentional and polished.

### PowerPoint

Refer to the `power-point-processing` skill.

### Excel

Spreadsheet data is high-stakes. Always double-check before and after exporting or overwriting the user's files. When creating Excel files, aim for a simple structure by default.
