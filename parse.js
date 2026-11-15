// parse.js — a fast drop-in for marked 18.1.3 (default options: gfm on,
// breaks off, pedantic off, async off). Returns exactly the HTML marked
// renders, for every input. Written from the CommonMark/GFM spec behaviour
// of marked; dependency-free, stateless per call, no I/O, no clock.
//
// Layout: (1) small string helpers, (2) regex tables, (3) block tokenizer,
// (4) inline tokenizer, (5) lexer, (6) renderer + parser, (7) parse().

// ---------------------------------------------------------------- helpers

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escChar = (ch) => ESC[ch];
const RE_ESC_TEST = /[&<>"']/;
const RE_ESC_REPLACE = /[&<>"']/g;
const RE_ESC_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RE_ESC_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML text. When `encode` is true every & < > " ' is escaped;
// otherwise already-valid entities are left alone.
function escapeHtml(s, encode) {
  if (encode) {
    if (RE_ESC_TEST.test(s)) return s.replace(RE_ESC_REPLACE, escChar);
  } else if (RE_ESC_TEST_NO_ENCODE.test(s)) {
    return s.replace(RE_ESC_REPLACE_NO_ENCODE, escChar);
  }
  return s;
}

const RE_NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RE_NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Turn numeric character references into characters; a bare & that is not
// part of a valid reference becomes &amp;.
function unescapeEntities(s) {
  if (!RE_NUM_REF.test(s)) return s;
  return s.replace(RE_NUM_REF_OR_AMP, (_m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Encode a link/image URL the way marked does; null when it cannot encode.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Split one table row on unescaped pipes, honouring a column count.
function splitCells(row, count) {
  const markedPipe = row.replace(/\|/g, (ch, off, str) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = markedPipe.split(/ \|/);
  let i = 0;
  if (cells[0].trim() || cells.shift()) {
    // first cell was empty because the row started with a pipe: dropped above
  }
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Strip trailing copies of `ch` (or, when `invert`, trailing chars != ch).
function rtrimChar(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !invert) k++;
    else if (c !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Drop trailing blank lines, keeping at most one trailing blank line.
function trimTrailingBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Normalise a link label for lookup: collapse whitespace, fold case.
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing paren that unbalances `pair` in `s`:
// -1 balanced/absent, -2 an opener is left unclosed.
function findUnbalancedParen(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, counting columns from `start`.
function expandTabs(s, start = 0) {
  let col = start;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// A fenced block whose opening fence was indented gets its content
// de-indented by that much (only lines starting with spaces).
function fenceIndentCompensation(raw, text) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return text;
  const indent = m[1];
  return text.split('\n').map((line) => {
    const sp = line.match(/^\s+/);
    if (sp === null) return line;
    const [w] = sp;
    return line.slice(Math.min(w.length, indent.length));
  }).join('\n');
}

// Does the link text contain a raw '<' that starts a tag/autolink? If so
// the '[' is not a link opener.
function linkTextHasRawHtml(full, label, bangOffset, rules) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = rules.inline.code.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = full.slice(bangOffset + i);
    const tag = rules.inline.tag.exec(rest) || rules.inline.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

// Build a link/image token from a matched opener and a resolved target.
function makeLinkToken(match, target, raw, lexer, rules) {
  const href = target.href;
  const title = target.title || null;
  const text = match[1].replace(/\\([\[\]])/g, '$1');
  const isImage = match[0].charAt(0) === '!';
  const wasInLink = lexer.state.inLink;
  const wasEmitted = lexer.state.linkEmitted;
  const wasRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const inner = lexer.inlineTokens(text);
  const emittedInside = lexer.state.linkEmitted;
  lexer.state.linkEmitted = wasEmitted;
  lexer.state.inLink = wasInLink;
  if (!isImage) {
    if (emittedInside) {
      lexer.state.inRawBlock = wasRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens: inner };
}

// ------------------------------------------------------- regex construction

// Tiny template helper: start from a regex/string, substitute named parts
// (a name is replaced by the part's source, with a leading ^ stripped),
// and compile the result.
function rxBuilder(source, flags = '') {
  let src = typeof source === 'string' ? source : source.source;
  const api = {
    replace(name, part) {
      let sub = typeof part === 'string' ? part : part.source;
      sub = sub.replace(/(^|[^\[])\^/g, '$1');
      src = src.replace(name, sub);
      return api;
    },
    getRegex() {
      return new RegExp(src, flags);
    },
  };
  return api;
}

// Cache a regex factory by indent level 1..4 (clamped), as marked does.
function byIndent(factory) {
  const cache = [];
  return (level) => {
    const n = Math.max(0, Math.min(3, level - 1));
    return cache[n] || (cache[n] = factory(n));
  };
}

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// ---------------------------------------------------------- other regexes

const RX = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  carriageReturn: /\r\n|\r/g,
  listItemRegex: (bullet) => new RegExp(`^( {0,3}${bullet})((?:[ \t][^\n]*)?(?:\n|$))`),
  nextBulletRegex: byIndent((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: byIndent((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`)),
  fencesBeginRegex: byIndent((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: byIndent((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: byIndent((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: byIndent((n) => new RegExp(`^ {0,${n}}>`)),
};

// ------------------------------------------------------------ block grammar

const HR_SRC = String.raw`^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)`;
const HR_RE = new RegExp(HR_SRC);
const BULLET_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const BULLET_RE = new RegExp(BULLET_SRC);
const HEADING_START_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_START_SRC = ' {0,3}(?:`{3,}|~{3,})';
const BLOCKQUOTE_START_SRC = ' {0,3}>';
const HTML_START_SRC = ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`;

// A paragraph is a run of lines, stopping before a line that opens another
// block (hr, heading, setext underline, blockquote, fence, list, html,
// table, or a blank line followed by indented content).
const PARA_SRC = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

function buildParagraph(listSrc) {
  return rxBuilder(PARA_SRC)
    .replace('hr', HR_RE)
    .replace('heading', HEADING_START_SRC)
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', BLOCKQUOTE_START_SRC)
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listSrc)
    .replace('html', HTML_START_SRC)
    .replace('tag', BLOCK_TAGS)
    .getRegex();
}

// Setext heading: text lines followed by === or ---, with the same
// stop-before-block lookaheads as a paragraph.
const SETEXT_SRC = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;

function buildSetext(tableSrc) {
  const b = rxBuilder(SETEXT_SRC)
    .replace(/bull/g, BULLET_RE)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/);
  // GFM keeps the '|' separator and swaps the word for the delimiter-row
  // pattern; without tables the whole alternative is dropped.
  if (tableSrc) b.replace(/table/g, tableSrc);
  else b.replace(/\|table/g, '');
  return b.getRegex();
}

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: HR_RE,
  text: /^[^\n]+/,
  listStart: rxBuilder(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULLET_RE).getRegex(),
  def: (() => {
    const label = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
    const title = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)/;
    return rxBuilder(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
      .replace('label', label)
      .replace('title', title)
      .getRegex();
  })(),
  html: rxBuilder(String.raw`^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:</\1>[^\n]*\n*|$)|comment[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|</?(tag)(?:[ \t]+|\n|/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|</[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))`, 'i')
    .replace('comment', HTML_COMMENT)
    .replace('tag', BLOCK_TAGS)
    .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
    .getRegex(),
  table: rxBuilder(String.raw`^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|hr|heading|blockquote|code|fences|list|html).*(?:\n|$))*)|$)`)
    .replace('hr', HR_RE)
    .replace('heading', HEADING_START_SRC)
    .replace('blockquote', BLOCKQUOTE_START_SRC)
    .replace('code', /(?: {4}| {0,3}\t)[^\n]/)
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .replace('html', HTML_START_SRC)
    .replace('tag', BLOCK_TAGS)
    .getRegex(),
};

// Cheap necessary conditions that let blockTokens skip the expensive
// block regexes when they cannot match (the regex still decides):
// a block may start with at most 3 spaces, so the first non-space
// character decides html ('<') and link definitions ('['); a table needs
// its second line to hold a '-' and no letters.
function startsAfterSpaces(src, ch) {
  let i = 0;
  while (i < 3 && src.charCodeAt(i) === 32) i++;
  return src.charCodeAt(i) === ch;
}
const RE_TABLE_DELIM_LINE = /^[^\n]*\n[^a-zA-Z\n]*-[^a-zA-Z\n]*(?:\n|$)/;

// Does `s` end with a blank line followed by another blank line
// (/\n[ \t]*\n[ \t]*$/), checked from the tail instead of by regex.
function endsWithDoubleBlank(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return i > 0 && s[i - 1] === '\n';
}

// GFM variants: setext headings may not swallow a table delimiter row,
// and paragraphs stop before tables.
BLOCK.lheading = buildSetext(' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n');
BLOCK.paragraph = (() => {
  const tableSrc = BLOCK.table.source;
  return rxBuilder(PARA_SRC)
    .replace('hr', HR_RE)
    .replace('heading', HEADING_START_SRC)
    .replace('|lheading', '')
    .replace('table', new RegExp(tableSrc))
    .replace('blockquote', BLOCKQUOTE_START_SRC)
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
    .replace('html', HTML_START_SRC)
    .replace('tag', BLOCK_TAGS)
    .getRegex();
})();
// Blockquote lines: a paragraph inside a quote stops at a list marker.
BLOCK.blockquote = rxBuilder(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', buildParagraph(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)'))
  .getRegex();

// ----------------------------------------------------------- inline grammar

const PUNCT = /[\p{P}\p{S}]/u;                 // any punctuation / symbol
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;         // punctuation or whitespace
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;    // anything else
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+/;
const EMAIL_DOMAIN = /[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const EMAIL_RE = new RegExp(EMAIL_LOCAL.source + '(@)' + EMAIL_DOMAIN.source);
const SCHEME_RE = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
const PROTOCOL_RE = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;

// [text](href "title") — label may nest brackets, code spans and escapes.
const LABEL_INNER = rxBuilder(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', /\[(?:\\[\s\S]|[^\[\]\\])*\]/)
  .getRegex();
const LINK_RE = rxBuilder(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', LABEL_INNER)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const REFLINK_RE = rxBuilder(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', LABEL_INNER)
  .replace('ref', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/)
  .getRegex();
const NOLINK_RE = rxBuilder(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/)
  .getRegex();

// The wide reflink search used to mask link text before emphasis runs.
const REFLINK_SEARCH = (() => {
  const refText = /(?:\\[\s\S]|[^\[\]\\]){1,999}/;
  const labelWide = rxBuilder(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
    .replace('brackets', /\[(?:\\[\s\S]|[^\[\]\\])*\]/)
    .getRegex();
  const rl = rxBuilder(/^!?\[(label)\]\[(ref)\]/).replace('label', labelWide).replace('ref', refText).getRegex();
  const nl = rxBuilder(/^!?\[(ref)\](?:\[\])?/).replace('ref', refText).getRegex();
  return rxBuilder('reflink|nolink(?!\\()', 'g')
    .replace('reflink', rl)
    .replace('nolink', nl)
    .getRegex();
})();

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  autolink: rxBuilder(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
    .replace('scheme', SCHEME_RE)
    .replace('email', EMAIL_RE)
    .getRegex(),
  tag: rxBuilder(String.raw`^comment|^</[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\s*/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>`)
    .replace('comment', rxBuilder(HTML_COMMENT).replace('(?:-->|$)', '-->').getRegex())
    .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
    .getRegex(),
  link: LINK_RE,
  reflink: REFLINK_RE,
  nolink: NOLINK_RE,
  reflinkSearch: REFLINK_SEARCH,
  punctuation: rxBuilder(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_SPACE).getRegex(),
  anyPunctuation: rxBuilder(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex(),
  anyPunctuationOutsideCode: rxBuilder(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex(),
  // Skip over links, code spans and tags when masking for emphasis.
  blockSkip: rxBuilder(/link|precode-code|html/, 'g')
    .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
    .replace('precode-', '(?<!`)()')
    .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
    .replace('html', /<(?! )[^<>]*?>/)
    .getRegex(),
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  // Emphasis/strong delimiter runs, GFM flavour: a '~' counts as punctuation
  // for '*' runs but not for '_' runs, and vice versa.
  emStrongLDelim: rxBuilder(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
    .replace(/punct/g, PUNCT_NO_TILDE)
    .getRegex(),
  emStrongRDelimAst: rxBuilder(String.raw`^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)punct(\*+)(?=[\s]|$)|notPunctSpace(\*+)(?!\*)(?=punctSpace|$)|(?!\*)punctSpace(\*+)(?=notPunctSpace)|[\s](\*+)(?!\*)(?=punct)|(?!\*)punct(\*+)(?!\*)(?=punct)|notPunctSpace(\*+)(?=notPunctSpace)`, 'gu')
    .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_TILDE)
    .replace(/punctSpace/g, PUNCT_SPACE_NO_TILDE)
    .replace(/punct/g, PUNCT_NO_TILDE)
    .getRegex(),
  emStrongRDelimUnd: rxBuilder(String.raw`^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)`, 'gu')
    .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
    .replace(/punctSpace/g, PUNCT_SPACE)
    .replace(/punct/g, PUNCT)
    .getRegex(),
  delLDelim: rxBuilder(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
    .replace(/punct/g, PUNCT)
    .getRegex(),
  delRDelim: rxBuilder(String.raw`^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)`, 'gu')
    .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
    .replace(/punctSpace/g, PUNCT_SPACE)
    .replace(/punct/g, PUNCT)
    .getRegex(),
  url: (() => {
    const emailProto = rxBuilder(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
      .replace(/email/g, /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
      .getRegex();
    return rxBuilder(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
      .replace('emailProtocol', emailProto)
      .replace('protocol', PROTOCOL_RE)
      .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
      .getRegex();
  })(),
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  // A plain-text run ends where the next token could start: before a
  // delimiter or tag opener, before a hard break, before an autolinkable
  // URL/e-mail, or at the end. This scanner reproduces the GFM text
  // pattern's stops exactly, one code unit at a time.
  text: rxBuilder(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
    .replace('protocol', PROTOCOL_RE)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
    .getRegex(),
};

// ------------------------------------------- emphasis masking (delimiters)

// Scan `src` for the last delimiter run that could close emphasis/strong
// (a run whose preceding character is not blank) and the last '~' run.
function scanDelimiters(src) {
  const closer = { '*': -1, '_': -1 };
  let delCloser = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < n && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') delCloser = i;
      else closer[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEmStrong: closer, lastDel: delCloser };
}

// The mask stack: while inline-tokenizing one string, nested calls (inside
// emphasis, links, ...) push their own masked source; the top of the stack
// is what a delimiter search consults. Scanning is deferred until a
// delimiter search actually needs it.
const maskStack = new WeakMap();
function maskPush(tokenizer, maskedSrc) {
  const entry = { maskedSrc, lastEmStrong: null, lastDel: null };
  const stack = maskStack.get(tokenizer);
  if (stack) stack.push(entry);
  else maskStack.set(tokenizer, [entry]);
}
function maskPop(tokenizer) {
  const stack = maskStack.get(tokenizer);
  if (stack) {
    stack.pop();
    if (stack.length === 0) maskStack.delete(tokenizer);
  }
}
function scanEntry(entry) {
  if (entry.lastEmStrong === null) {
    const scanned = scanDelimiters(entry.maskedSrc);
    entry.lastEmStrong = scanned.lastEmStrong;
    entry.lastDel = scanned.lastDel;
  }
}
function lastEmStrongCloser(tokenizer, maskedSrc, delim) {
  const top = maskStack.get(tokenizer)?.at(-1);
  if (top && top.maskedSrc === maskedSrc) { scanEntry(top); return top.lastEmStrong[delim]; }
  return scanDelimiters(maskedSrc).lastEmStrong[delim];
}
function lastDelCloser(tokenizer, maskedSrc) {
  const top = maskStack.get(tokenizer)?.at(-1);
  if (top && top.maskedSrc === maskedSrc) { scanEntry(top); return top.lastDel; }
  return scanDelimiters(maskedSrc).lastDel;
}

// ------------------------------------------------------------ block lexer

class Tokenizer {
  constructor(lexer) {
    this.lexer = lexer;
  }

  space(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
    return undefined;
  }

  code(src) {
    const m = BLOCK.code.exec(src);
    if (!m) return undefined;
    const raw = trimTrailingBlanks(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RX.codeRemoveIndent, '') };
  }

  fences(src) {
    const m = BLOCK.fences.exec(src);
    if (!m) return undefined;
    const lang = m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2];
    return { type: 'code', raw: m[0], lang, text: fenceIndentCompensation(m[0], m[3] || '') };
  }

  heading(src) {
    const m = BLOCK.heading.exec(src);
    if (!m) return undefined;
    let text = m[2].trim();
    if (RX.endingHash.test(text)) {
      const stripped = rtrimChar(text, '#');
      if (!stripped || RX.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: rtrimChar(m[0], '\n'), depth: m[1].length, text, tokens: this.lexer.inline(text) };
  }

  hr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: rtrimChar(m[0], '\n') };
    return undefined;
  }

  blockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return undefined;
    const lines = rtrimChar(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inQuote = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (RX.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); inQuote = true; }
        else if (!inQuote) chunk.push(lines[p]);
        else break;
      }
      lines.splice(0, p);
      const chunkSrc = chunk.join('\n');
      const inner = chunkSrc
        .replace(RX.blockquoteMarkerWhitespace, (g, marker, ws) => marker + expandTabs(ws, marker.length))
        .replace(RX.blockquoteSetextReplace, '\n    $1')
        .replace(RX.blockquoteSetextReplace2, '');
      raw = raw ? raw + '\n' + chunkSrc : chunkSrc;
      text = text ? text + '\n' + inner : inner;
      const savedTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(inner, tokens, true);
      this.lexer.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
      if (last?.type === 'blockquote') {
        const prev = last;
        const rest = lines.join('\n');
        const merged = prev.raw + '\n' + rest.replace(RX.blockquoteSetextReplace2, '');
        const reparsed = this.blockquote(merged);
        tokens[tokens.length - 1] = reparsed;
        const leftover = merged.substring(reparsed.raw.length).replace(/^\n/, '');
        const leftoverLines = leftover ? leftover.split('\n').length : 0;
        const taken = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
        if (taken.length > 0) raw = raw + '\n' + taken.join('\n');
        text = text.substring(0, text.length - prev.text.length) + reparsed.text;
        lines.splice(0, taken.length);
        if (lines.length > 0 && RX.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const prev = last;
        const joined = prev.raw + '\n' + lines.join('\n');
        const reparsed = this.list(joined);
        tokens[tokens.length - 1] = reparsed;
        const extra = reparsed.raw.length > prev.raw.length
          ? joined.slice(prev.raw.length + 1, reparsed.raw.length).split('\n').length
          : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          raw = raw + '\n' + taken;
          text = text + '\n' + taken;
        }
        lines.splice(0, extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  list(src) {
    const m = BLOCK.listStart.exec(src);
    if (!m) return undefined;
    const input = src;
    let rest = src;
    const consumed = () => input.length - rest.length;
    const marker = m[1].trim();
    const ordered = marker.length > 1;
    const list = { type: 'list', raw: '', ordered, start: ordered ? +marker.slice(0, -1) : '', loose: false, items: [] };
    const bulletPat = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRe = RX.listItemRegex(bulletPat);
    let prevHadBlank = false;
    while (rest) {
      let isEmptyItem = false;
      let itemText = '';
      const hit = itemRe.exec(rest);
      if (!hit || BLOCK.hr.test(rest)) break;
      const startAt = consumed();
      rest = rest.substring(hit[0].length);
      const markerLineEnd = hit[2].indexOf('\n');
      const firstLine = markerLineEnd === -1 ? hit[2] : hit[2].slice(0, markerLineEnd);
      const markerLen = hit[1].length;
      let content = firstLine.replace(RX.leadingSpaceTab, (ws) => expandTabs(ws, markerLen));
      const nextNl = rest.indexOf('\n');
      let nextLine = nextNl === -1 ? rest : rest.slice(0, nextNl);
      let emptyFirst = !content.trim();
      let indent;
      if (emptyFirst) {
        indent = markerLen + 1;
      } else {
        indent = content.search(RX.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemText = content.slice(indent);
        indent += markerLen;
      }
      if (emptyFirst && RX.blankLine.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        isEmptyItem = true;
      }
      if (!isEmptyItem) {
        const nextBullet = RX.nextBulletRegex(indent);
        const hrAt = RX.hrRegex(indent);
        const fenceAt = RX.fencesBeginRegex(indent);
        const headingAt = RX.headingBeginRegex(indent);
        const htmlAt = RX.htmlBeginRegex(indent);
        const quoteAt = RX.blockquoteBeginRegex(indent);
        while (rest) {
          const nlAt = rest.indexOf('\n');
          const line = nlAt === -1 ? rest : rest.slice(0, nlAt);
          const expanded = line.replace(RX.leadingSpaceTab, (ws) => expandTabs(ws));
          if (fenceAt.test(line) || headingAt.test(line) || htmlAt.test(line) || quoteAt.test(line) || nextBullet.test(line) || hrAt.test(line)) break;
          if (expanded.search(RX.nonSpaceChar) >= indent || !line.trim()) {
            itemText += '\n' + expanded.slice(indent);
          } else {
            if (emptyFirst || content.replace(RX.tabCharGlobal, '    ').search(RX.nonSpaceChar) >= 4 || fenceAt.test(content) || headingAt.test(content) || htmlAt.test(content) || hrAt.test(content)) break;
            const setextLine = /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(content + '\n' + line)
              ? '    ' + expanded.replace(/^ {0,3}/, '')
              : line;
            itemText += '\n' + setextLine;
          }
          emptyFirst = !line.trim();
          rest = rest.substring(line.length + 1);
          content = expanded.slice(indent);
        }
      }
      const itemRaw = input.slice(startAt, consumed());
      if (!list.loose) {
        if (prevHadBlank) list.loose = true;
        else if (endsWithDoubleBlank(itemRaw)) prevHadBlank = true;
      }
      list.items.push({
        type: 'list_item', raw: itemRaw,
        task: RX.listIsTask.test(itemText), loose: false, text: itemText, tokens: [],
      });
    }
    const lastItem = list.items.at(-1);
    if (!lastItem) return undefined;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = input.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        list.loose = spaces.length > 0 && spaces.some((t) => RX.anyLine.test(t.raw));
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(RX.listReplaceTask, '');
        first.raw = first.raw.replace(RX.listReplaceTask, '');
        first.text = first.text.replace(RX.listReplaceTask, '');
        for (let q = this.lexer.inlineQueue.length - 1; q >= 0; q--) {
          if (RX.listIsTask.test(this.lexer.inlineQueue[q].src)) {
            this.lexer.inlineQueue[q].src = this.lexer.inlineQueue[q].src.replace(RX.listReplaceTask, '');
            break;
          }
        }
        const box = RX.listTaskCheckbox.exec(item.raw);
        if (box) {
          const checkbox = { type: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
          item.checked = checkbox.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
              item.tokens[0].text = checkbox.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return list;
  }

  html(src) {
    const m = BLOCK.html.exec(src);
    if (!m) return undefined;
    const raw = trimTrailingBlanks(m[0]);
    return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
  }

  def(src) {
    const m = BLOCK.def.exec(src);
    if (!m) return undefined;
    if (!RX.startAngleBracket.test(m[2]) && findUnbalancedParen(m[2], '()') !== -1) return undefined;
    const tag = normalizeLabel(m[1]);
    const href = m[2] ? m[2].replace(RX.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1') : m[3];
    return { type: 'def', tag, raw: rtrimChar(m[0], '\n'), href, title };
  }

  table(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !RX.tableDelimiter.test(m[2])) return undefined;
    const headerCells = splitCells(m[1]);
    const delimCells = m[2].replace(RX.tableAlignChars, '').split('|');
    const bodyLines = m[3]?.trim() ? m[3].replace(RX.tableRowBlankLine, '').split('\n') : [];
    const table = { type: 'table', raw: rtrimChar(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length !== delimCells.length) return undefined;
    for (const cell of delimCells) {
      if (RX.tableAlignRight.test(cell)) table.align.push('right');
      else if (RX.tableAlignCenter.test(cell)) table.align.push('center');
      else if (RX.tableAlignLeft.test(cell)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      table.header.push({ text: headerCells[i], tokens: this.lexer.inline(headerCells[i]), header: true, align: table.align[i] });
    }
    for (const line of bodyLines) {
      table.rows.push(splitCells(line, table.header.length).map((cell, i) => ({
        text: cell, tokens: this.lexer.inline(cell), header: false, align: table.align[i],
      })));
    }
    return table;
  }

  lheading(src) {
    const m = BLOCK.lheading.exec(src);
    if (!m) return undefined;
    const text = m[1].trim();
    return { type: 'heading', raw: rtrimChar(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.lexer.inline(text) };
  }

  paragraph(src) {
    const m = BLOCK.paragraph.exec(src);
    if (!m) return undefined;
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
  }

  text(src) {
    const m = BLOCK.text.exec(src);
    if (!m) return undefined;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }
}

// ---------------------------------------------------------- inline tokenizer
// These methods live on the same Tokenizer class; they run while the lexer
// walks one paragraph/heading/cell of text.

Object.assign(Tokenizer.prototype, {
  escape(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
    return undefined;
  },

  tag(src) {
    const m = INLINE.tag.exec(src);
    if (!m) return undefined;
    const st = this.lexer.state;
    if (!st.inLink && RX.startATag.test(m[0])) st.inLink = true;
    else if (st.inLink && RX.endATag.test(m[0])) st.inLink = false;
    if (!st.inRawBlock && RX.startPreScriptTag.test(m[0])) st.inRawBlock = true;
    else if (st.inRawBlock && RX.endPreScriptTag.test(m[0])) st.inRawBlock = false;
    return { type: 'html', raw: m[0], inLink: st.inLink, inRawBlock: st.inRawBlock, block: false, text: m[0] };
  },

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return undefined;
    const m = INLINE.link.exec(src);
    if (!m) return undefined;
    const bangOff = m[0].charAt(0) === '!' ? 2 : 1;
    if (linkTextHasRawHtml(src, m[1], bangOff, { inline: INLINE })) return undefined;
    const hrefPart = m[2].trim();
    if (RX.startAngleBracket.test(hrefPart)) {
      if (!RX.endAngleBracket.test(hrefPart)) return undefined;
      const unesc = rtrimChar(hrefPart.slice(0, -1), '\\');
      if ((hrefPart.length - unesc.length) % 2 === 0) return undefined;
    } else {
      const close = findUnbalancedParen(m[2], '()');
      if (close === -2) return undefined;
      if (close > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
        m[2] = m[2].substring(0, close);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const rtrimmed = rtrimChar(m[0].slice(0, -1), '\\');
    if ((m[0].length - rtrimmed.length) % 2 === 0) return undefined;
    let href = m[2];
    const title = m[3] ? m[3].slice(1, -1) : '';
    href = href.trim();
    if (RX.startAngleBracket.test(href)) href = href.slice(1, -1);
    return makeLinkToken(m, {
      href: href && href.replace(INLINE.anyPunctuation, '$1'),
      title: title && title.replace(INLINE.anyPunctuation, '$1'),
    }, m[0], this.lexer, { inline: INLINE });
  },

  reflink(src, links) {
    let m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (!m) return undefined;
    const bangOff = m[0].charAt(0) === '!' ? 2 : 1;
    if (linkTextHasRawHtml(src, m[1], bangOff, { inline: INLINE })) return undefined;
    const target = links[normalizeLabel(m[2] || m[1])];
    if (!target) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return makeLinkToken(m, target, m[0], this.lexer, { inline: INLINE });
  },

  emStrong(src, masked, prevChar = '') {
    const open = INLINE.emStrongLDelim.exec(src);
    if (!open || (!open[1] && !open[2] && !open[3] && !open[4])) return undefined;
    const delim = open[0][0];
    const sameAsPrev = prevChar === delim;
    const offset = masked.length - src.length;
    let runStart = offset;
    while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
    const charsBefore = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const beforeIsDelimOrPunct = charsBefore === '*' || charsBefore === '_' || !!INLINE.punctuation.exec(charsBefore);
    let prev = prevChar;
    if (runStart < offset) prev = charsBefore;
    const prevIsPunct = runStart < offset ? beforeIsDelimOrPunct : !!INLINE.punctuation.exec(prev);
    if (open[4] && RX.unicodeAlphaNumeric.test(prev)) return undefined;
    const afterPunct = open[1] || open[3] || '';
    if (!afterPunct || !prev || prevIsPunct) {
      const runLen = [...open[0]].length - 1;
      let openLeft = runLen;
      let skipped = 0;
      const totalRun = offset - runStart + runLen;
      const canCloseAsStrong = !!charsBefore.trim() && (!!afterPunct || (delim === '*' && !beforeIsDelimOrPunct));
      if (delim !== '*' && delim !== '_') return undefined;
      const closerRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = lastEmStrongCloser(this, masked, delim);
      const openerEnd = masked.length - src.length + runLen;
      if (lastCloser < openerEnd) return undefined;
      const afterOpen = masked.slice(masked.length - src.length + runLen);
      const maxIdx = lastCloser - openerEnd;
      for (closerRe.lastIndex = 0; ;) {
        const hit = closerRe.exec(afterOpen);
        if (hit === null || hit.index > maxIdx) break;
        const run = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
        if (!run) continue;
        const len = [...run].length;
        if (hit[3] || hit[4]) { openLeft += len; continue; }
        if (hit[5] || hit[6] || canCloseAsStrong) {
          if (sameAsPrev && (hit[5] || hit[6])) break;
          if (totalRun % 3 && !((totalRun + len) % 3)) { skipped += len; continue; }
        }
        openLeft -= len;
        if (openLeft > 0) continue;
        const used = Math.min(len, len + openLeft + skipped);
        const firstLen = [...hit[0]][0].length;
        const raw = src.slice(0, runLen + hit.index + firstLen + used);
        if (Math.min(runLen, used) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
    return undefined;
  },

  codespan(src) {
    const m = INLINE.code.exec(src);
    if (!m) return undefined;
    let text = m[2].replace(RX.newLineCharGlobal, ' ');
    const hasNonSpace = RX.nonSpaceChar.test(text);
    const padded = RX.startingSpaceChar.test(text) && RX.endingSpaceChar.test(text);
    if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  },

  br(src) {
    const m = INLINE.br.exec(src);
    if (m) return { type: 'br', raw: m[0] };
    return undefined;
  },

  del(src, masked, prevChar = '') {
    const open = INLINE.delLDelim.exec(src);
    if (!open) return undefined;
    if (!((open[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar))) return undefined;
    const runLen = [...open[0]].length - 1;
    let openLeft = runLen;
    const closerRe = INLINE.delRDelim;
    const lastCloser = lastDelCloser(this, masked);
    const openerEnd = masked.length - src.length + runLen;
    if (lastCloser < openerEnd) return undefined;
    const afterOpen = masked.slice(masked.length - src.length + runLen);
    const maxIdx = lastCloser - openerEnd;
    for (closerRe.lastIndex = 0; ;) {
      const hit = closerRe.exec(afterOpen);
      if (hit === null || hit.index > maxIdx) break;
      const run = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
      if (!run) continue;
      const len = [...run].length;
      if (len !== runLen) continue;
      if (hit[3] || hit[4]) { openLeft += len; continue; }
      openLeft -= len;
      if (openLeft > 0) continue;
      const used = Math.min(len, len + openLeft);
      const firstLen = [...hit[0]][0].length;
      const raw = src.slice(0, runLen + hit.index + firstLen + used);
      const inner = raw.slice(runLen, -runLen);
      return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
    }
    return undefined;
  },

  autolink(src) {
    const m = INLINE.autolink.exec(src);
    if (!m) return undefined;
    let text, href;
    if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
    else { text = m[1]; href = text; }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  },

  url(src) {
    const m = INLINE.url.exec(src);
    if (!m) return undefined;
    let text, href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let cur = m[0];
      let prev;
      do {
        prev = cur;
        cur = INLINE._backpedal.exec(cur)?.[0] ?? '';
      } while (prev !== cur);
      text = cur;
      href = m[1] === 'www.' ? 'http://' + cur : cur;
      // The returned raw is the backpedaled text, not the original match.
      m[0] = cur;
    }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  },

  inlineText(src) {
    const m = INLINE.text.exec(src);
    if (!m) return undefined;
    const inRaw = this.lexer.state.inRawBlock;
    return { type: 'text', raw: m[0], text: inRaw ? m[0] : unescapeEntities(m[0]), escaped: inRaw };
  },
});

// ------------------------------------------------------------------- lexer

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.tokenizer = new Tokenizer(this);
    this.inlineQueue = [];
    this.hasLinkDefs = false;
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }

  // Reset all per-input state so one Lexer can serve every parse() call.
  reset() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.inlineQueue = [];
    this.hasLinkDefs = false;
    this.state.inLink = false;
    this.state.inRawBlock = false;
    this.state.linkEmitted = false;
    this.state.linkParenPossible = true;
    this.state.top = true;
  }

  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  linkInText(src) {
    if (!src.includes('[')) return false;
    const linkRe = INLINE.link;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (linkRe.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const s = m[0];
      const o = s.lastIndexOf('[');
      if (!(s.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeLabel(s.slice(o + 1, -1)))) &&
          !(o > 1 && this.linkInText(s.slice(1, o - 1)))) return true;
    }
    return false;
  }

  // Mask link text, code spans and tags so emphasis scanning cannot see
  // delimiters inside them; masked positions keep their length. Each of
  // the three replacements runs only when its trigger characters occur:
  // with no '[', backtick, '<' or backslash, the source is unchanged.
  maskSource(src) {
    let t = src;
    const hasBracket = src.indexOf('[') !== -1;
    const hasBacktick = src.indexOf('`') !== -1;
    if (hasBracket && this.hasLinkDefs) {
      const search = INLINE.reflinkSearch;
      const maskLink = (r) => {
        const o = r.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(r.slice(o + 1, -1)))) return r;
        if (o > 1 && r.charAt(0) !== '!') {
          const inner = r.slice(1, o - 1);
          if (this.linkInText(inner)) return '[' + inner.replace(search, maskLink) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
        return '[' + 'a'.repeat(r.length - 2) + ']';
      };
      t = t.replace(search, maskLink);
    }
    if (hasBacktick || src.indexOf('\\') !== -1) {
      t = t.replace(INLINE.anyPunctuationOutsideCode, (n, s, r) =>
        r ? '+'.repeat(n.length)
          : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s
          : n);
    }
    if (hasBracket || hasBacktick || src.indexOf('<') !== -1) {
      t = t.replace(INLINE.blockSkip, (n, _s, r) => {
        const keep = r ? r.length : 0;
        return n.slice(0, keep) + '[' + 'a'.repeat(n.length - keep - 2) + ']';
      });
    }
    return t;
  }

  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      return this.inlineMasked(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  inlineMasked(src, tokens) {
    const masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? this.maskSource(src) : src;
    maskPush(this.tokenizer, masked);
    try {
      return this.inlineLoop(src, masked, tokens);
    } finally {
      maskPop(this.tokenizer);
    }
  }

  inlineLoop(src, masked, tokens) {
    let wasText = false;
    let prevChar = '';
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else { this.infiniteLoopError(src.charCodeAt(0)); break; }
      if (!wasText) prevChar = '';
      wasText = false;
      const ch = src.charCodeAt(0);
      let tok;
      // Dispatch on the first character: only the tokenizers whose
      // pattern can start with it are attempted, in marked's order.
      // Every other tokenizer's pattern is anchored to a different
      // first character, so skipping it cannot change the result.
      if (ch === 92) { // backslash: escape, hard break
        if ((tok = this.tokenizer.escape(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.tokenizer.br(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (ch === 60) { // <: tag, autolink
        if ((tok = this.tokenizer.tag(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.tokenizer.autolink(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (ch === 91 || ch === 33) { // [ or !: link, reflink
        if ((tok = this.tokenizer.link(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.tokenizer.reflink(src, this.tokens.links))) {
          src = src.substring(tok.raw.length);
          const last = tokens.at(-1);
          if (tok.type === 'text' && last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
          else tokens.push(tok);
          continue;
        }
      } else if (ch === 42 || ch === 95) { // * or _: emphasis
        if ((tok = this.tokenizer.emStrong(src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (ch === 96) { // backtick: code span
        if ((tok = this.tokenizer.codespan(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (ch === 126) { // ~: strikethrough
        if ((tok = this.tokenizer.del(src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (ch === 32) { // space: hard break (two spaces + newline)
        if ((tok = this.tokenizer.br(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (!this.state.inLink && (tok = this.tokenizer.url(src))) {
        src = src.substring(tok.raw.length); tokens.push(tok); continue;
      }
      if ((tok = this.tokenizer.inlineText(src))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        wasText = true;
        const last = tokens.at(-1);
        if (last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if (src) { this.infiniteLoopError(src.charCodeAt(0)); break; }
    }
    return tokens;
  }

  blockTokens(src, tokens = [], inside = false) {
    this.tokenizer.lexer = this;
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else { this.infiniteLoopError(src.charCodeAt(0)); break; }
      let tok;
      if ((tok = this.tokenizer.space(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.code(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.at(-1).src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.fences(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.heading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.hr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.blockquote(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.list(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (startsAfterSpaces(src, 60) && (tok = this.tokenizer.html(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (startsAfterSpaces(src, 91) && (tok = this.tokenizer.def(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          this.inlineQueue.at(-1).src = last.text;
        } else {
          if (!this.tokens.links[tok.tag]) {
            this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
            this.hasLinkDefs = true;
          }
          tokens.push(tok);
        }
        continue;
      }
      if (RE_TABLE_DELIM_LINE.test(src) && (tok = this.tokenizer.table(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.lheading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      let chunk = src;
      if (this.state.top && (tok = this.tokenizer.paragraph(chunk))) {
        const last = tokens.at(-1);
        if (inside && last?.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = last.text;
        } else tokens.push(tok);
        inside = chunk.length !== src.length;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokenizer.text(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) { this.infiniteLoopError(src.charCodeAt(0)); break; }
    }
    this.state.top = true;
    return tokens;
  }

  lex(src) {
    src = src.replace(RX.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const item = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  infiniteLoopError(byte) {
    throw new Error('Infinite loop on byte: ' + byte + '\nPlease report this to https://github.com/markedjs/marked.');
  }
}

// ---------------------------------------------------------------- renderer

class Renderer {
  constructor() { this.parser = null; }
  space() { return ''; }
  code({ text, lang, escaped }) {
    const firstWord = (lang || '').match(RX.notSpaceStart)?.[0];
    const body = text ? text.replace(RX.endingNewline, '') + '\n' : '';
    if (firstWord) return '<pre><code class="language-' + escapeHtml(firstWord) + '">' + (escaped ? body : escapeHtml(body, true)) + '</code></pre>\n';
    return '<pre><code>' + (escaped ? body : escapeHtml(body, true)) + '</code></pre>\n';
  }
  blockquote({ tokens }) {
    return '<blockquote>\n' + this.parser.parse(tokens) + '</blockquote>\n';
  }
  html({ text }) { return text; }
  def() { return ''; }
  heading({ tokens, depth }) {
    return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
  }
  hr() { return '<hr>\n'; }
  list({ ordered, start, items }) {
    let out = '';
    for (const item of items) out += this.listitem(item);
    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && start !== 1 ? ' start="' + start + '"' : '';
    return '<' + tag + startAttr + '>\n' + out + '</' + tag + '>\n';
  }
  listitem(item) {
    return '<li>' + this.parser.parse(item.tokens) + '</li>\n';
  }
  checkbox({ checked }) {
    return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
  }
  paragraph({ tokens }) {
    return '<p>' + this.parser.parseInline(tokens) + '</p>\n';
  }
  table({ header, rows }) {
    let head = '';
    for (const cell of header) head += this.tablecell(cell);
    head = this.tablerow({ text: head });
    let body = '';
    for (const row of rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = '<tbody>' + body + '</tbody>';
    return '<table>\n<thead>\n' + head + '</thead>\n' + body + '</table>\n';
  }
  tablerow({ text }) {
    return '<tr>\n' + text + '</tr>\n';
  }
  tablecell(cell) {
    const inner = this.parser.parseInline(cell.tokens);
    const tag = cell.header ? 'th' : 'td';
    return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
  }
  strong({ tokens }) { return '<strong>' + this.parser.parseInline(tokens) + '</strong>'; }
  em({ tokens }) { return '<em>' + this.parser.parseInline(tokens) + '</em>'; }
  codespan({ text }) { return '<code>' + escapeHtml(text, true) + '</code>'; }
  br() { return '<br>'; }
  del({ tokens }) { return '<del>' + this.parser.parseInline(tokens) + '</del>'; }
  link({ href, title, text, tokens, autolink }) {
    const inner = autolink ? escapeHtml(text, true) : this.parser.parseInline(tokens);
    const cleaned = cleanUrl(href);
    if (cleaned === null) return inner;
    const safeHref = escapeHtml(cleaned, autolink);
    let out = '<a href="' + safeHref + '"';
    if (title) out += ' title="' + escapeHtml(title) + '"';
    return out + '>' + inner + '</a>';
  }
  image({ href, title, text, tokens }) {
    if (tokens) text = this.parser.parseInline(tokens, this.parser.textRenderer);
    const cleaned = cleanUrl(href);
    if (cleaned === null) return escapeHtml(text);
    const safeHref = cleaned;
    let out = `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    return out + '>';
  }
  text(token) {
    if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
    if ('escaped' in token && token.escaped) return token.text;
    return escapeHtml(token.text);
  }
}

// Renders tokens to plain text (used for image alt text).
class TextRenderer {
  constructor() { this.parser = null; }
  strong({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  em({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  codespan({ text }) { return text; }
  del({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  html({ text }) { return text; }
  text({ text }) { return text; }
  link({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  image({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  br() { return ''; }
  checkbox({ raw }) { return raw; }
}

// ------------------------------------------------------------------- parser

class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }

  parse(tokens) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'space': out += this.renderer.space(token); break;
        case 'hr': out += this.renderer.hr(token); break;
        case 'heading': out += this.renderer.heading(token); break;
        case 'code': out += this.renderer.code(token); break;
        case 'table': out += this.renderer.table(token); break;
        case 'blockquote': out += this.renderer.blockquote(token); break;
        case 'list': out += this.renderer.list(token); break;
        case 'checkbox': out += this.renderer.checkbox(token); break;
        case 'html': out += this.renderer.html(token); break;
        case 'def': out += this.renderer.def(token); break;
        case 'paragraph': out += this.renderer.paragraph(token); break;
        case 'text': out += this.renderer.text(token); break;
        default: throw new Error('Token with "' + token.type + '" type was not found.\nPlease report this to https://github.com/markedjs/marked.');
      }
    }
    return out;
  }

  parseInline(tokens, renderer = this.renderer) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'escape': out += renderer.text(token); break;
        case 'html': out += renderer.html(token); break;
        case 'link': out += renderer.link(token); break;
        case 'image': out += renderer.image(token); break;
        case 'checkbox': out += renderer.checkbox(token); break;
        case 'strong': out += renderer.strong(token); break;
        case 'em': out += renderer.em(token); break;
        case 'codespan': out += renderer.codespan(token); break;
        case 'br': out += renderer.br(token); break;
        case 'del': out += renderer.del(token); break;
        case 'text': out += renderer.text(token); break;
        default: throw new Error('Token with "' + token.type + '" type was not found.\nPlease report this to https://github.com/markedjs/marked.');
      }
    }
    return out;
  }
}

// -------------------------------------------------------------------- entry

// One Lexer/Parser pair serves every call; parse() resets the lexer's
// per-input state first, so each case is still rendered entirely alone.
/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
const sharedLexer = new Lexer();
const sharedParser = new Parser();
export function parse(markdown) {
  if (typeof markdown === 'undefined' || markdown === null) {
    throw new Error('marked(): input parameter is undefined or null\nPlease report this to https://github.com/markedjs/marked.');
  }
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected\nPlease report this to https://github.com/markedjs/marked.');
  }
  sharedLexer.reset();
  const tokens = sharedLexer.lex(markdown);
  return sharedParser.parse(tokens);
}
