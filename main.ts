
// Driver for the markdown-render-speed-02 entry.
// Reads every case from /input/cases.json, renders each markdown string
// with the dependency-free parse() in ./parse.js, and writes the HTML
// for every case to /output/html.json.
//
// Input and output locations follow the harness convention, with the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR environment variables as
// overrides so the driver also runs outside the grading container.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

function main(): void {
  const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const cases: Case[] = JSON.parse(raw) as Case[];
  // The harness expects /output/html.json to be a JSON array of the HTML
  // strings, one per case and in the cases' order.
  const html: string[] = [];
  for (const c of cases) {
    html.push(parse(c.markdown));
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html), 'utf8');
}

main();
