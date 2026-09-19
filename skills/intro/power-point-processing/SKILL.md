---
name: power-point-processing
display-name: PowerPoint Processing
description: Create, read, edit PowerPoint files
user-invocable: false
---

## PowerPoint Processing

### Tone and defaults

Before creating or editing a deck, infer its purpose, audience, setting, and formality from the prompt and references, then match tone and design. For business-critical, client-facing, academic, or formal decks, use polished work-appropriate language and a neutral, minimal style. For casual, creative, personal, or educational decks, you may use more imagery, layout variation, and aesthetic styling while keeping the deck clear, readable, editable, and purposeful. If intent is ambiguous, default to professional minimalism and state key assumptions.

Unless instructed otherwise, use 16:9 widescreen, pure white backgrounds #FFFFFF, black text on white, white text only on dark images/shapes, at most 2 readable Office-safe fonts, and 3 text-size roles: title, body, caption/footer. If reference materials include colors, extract hex codes as precisely as possible and use 1 main color plus up to 2 accent colors based on prominence.

### Layout and content

Layout correctness is a high priority requirement. Keep slides spacious, aligned, high-contrast, and uncluttered. Before finalizing, run a bounding-box check on the final output and fix every collision: no text box, shape, image, chart, or table may overlap another unless the overlap is deliberate, and every element must sit fully within slide bounds. Also verify that all text fits without overflow or awkward word breaks, that unrelated elements have clear whitespace between them, that annotations do not obscure important image content, and that comparison slides use tables or cards wide enough for their content.

Use concise titles, scannable content, editable PowerPoint elements, and placeholders for missing information. Include a meaningful visual on each content slide when appropriate — photo, labeled diagram, chart, icon, or simple vector illustration — and avoid decorative shapes that do not support the topic. Do not invent facts, data, citations, or details. When editing an existing deck, preserve its slide size, theme, layouts, formatting patterns, speaker notes, charts, objects, and structure, and make the smallest effective change unless redesign is requested.

### Validation and visual review

Check for overlapping elements, clipped content, poor spacing, and other visual issues. Refine the deck until it looks intentional and polished.

### Working with the user

Always respond with a deck outline and get confirmation before creating, or ask for an outline when context is thin. Ask clarifying questions only when required; otherwise proceed with stated assumptions, deliver the final .pptx, and summarize critical assumptions.
