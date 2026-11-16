# Faster than marked, byte-identical on 720 cases

A dependency-free, Node-only Markdown renderer (`parse.js`) whose
`parse(markdown)` returns exactly the HTML that marked 18.1.3 renders
with default options (GFM on, breaks off), on all 720 competition
cases — and renders them measurably faster than marked.

## Layout

- `parse.js` — the renderer. A dependency-free ES module exporting
  `parse(markdown)`. Block lexer, inline lexer with a delimiter stack
  for emphasis, GFM tables, strikethrough, autolinks and extended
  autolinks, link reference definitions, and raw HTML blocks, composed
  from the CommonMark 0.31.2 + GFM 0.29 specifications and marked's
  documented behaviour.
- `main.ts` — the harness driver. Reads `/input/cases.json`, renders
  every case with `parse`, writes `/output/html.json`. Input/output
  directories can be overridden with `MAKEFUN_INPUT_DIR` and
  `MAKEFUN_OUTPUT_DIR`.
- `package.json` — `{"type": "module"}`.
- `LICENSE` — MIT.

## Running it

```sh
node --experimental-strip-types main.ts
```

or, after the harness copies the entry into the grading container,
through the competition driver. No dependencies, no network access,
no I/O besides the case file and the output file.
