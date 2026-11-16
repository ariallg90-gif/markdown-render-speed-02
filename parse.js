// A fast drop-in for marked 18.1.3 (default options, GFM on): parse(markdown)
// returns exactly the HTML marked renders, byte for byte.
//
// Written from scratch from the CommonMark 0.31.2 and GFM 0.29 specifications
// and marked's documented behaviour. Block lexer -> token tree -> inline
// lexer (run after the whole block pass, so link reference definitions
// anywhere in the document apply) -> renderer. No state is kept between
// parse() calls.

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_RE_NO_ENCODE = /[<>"']|&(?!\w+;)/g;
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML special characters. With encode=true every & is escaped;
// otherwise an & that already starts a character reference is left alone.
function escape(html, encode) {
  if (encode) {
    return ESCAPE_RE.test(html) ? html.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]) : html;
  }
  return ESCAPE_RE_NO_ENCODE.test(html) ? html.replace(ESCAPE_RE_NO_ENCODE, (c) => ESCAPE_MAP[c]) : html;
}

// Decode character references as marked does for link destinations and
// titles: numeric references decode (see decodeNumericRefs); named
// references are preserved verbatim.
function unescape(html) {
  return decodeNumericRefs(html);
}

// Decode numeric character references in text: &#65; and &#x41; (1-7
// decimal or 1-6 hex digits). Code point 0, surrogates, and values above
// U+10FFFF become U+FFFD. Malformed references are left untouched (their
// & is escaped later). Named references are NOT decoded here; they are
// preserved verbatim by the no-encode escape.
const NUMERIC_REF_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g;
function decodeNumericRefs(str) {
  if (!str.includes('&#')) return str;
  return str.replace(NUMERIC_REF_RE, (_, dec, hex) => {
    const n = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || (n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff) return '�';
    return String.fromCodePoint(n);
  });
}

// Percent-encode a link destination the way marked's cleanUrl does.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// Remove backslash escapes (a backslash before an ASCII punctuation char
// yields that char). Used for link destinations and titles, which are
// unescaped before they are percent-encoded; entities are left alone.
const BACKSLASH_ESCAPE = /\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g;
function unescapeBackslash(str) {
  return str.replace(BACKSLASH_ESCAPE, '$1');
}

// Columns of leading whitespace (spaces/tabs) in `str`, starting at column
// `col`. Tabs advance to the next multiple of 4.
function leadingWhitespaceColumns(str, col) {
  let i = 0;
  let c = col;
  while (i < str.length) {
    if (str[i] === ' ') { i++; c++; }
    else if (str[i] === '\t') { c += 4 - (c % 4); i++; }
    else break;
  }
  return { index: i, columns: c - col };
}

// Remove `n` columns of leading whitespace from `str` (which starts at
// column `col`). A tab that the removal cuts through leaves its remainder
// as spaces in `prefix`. Returns null when there is not enough whitespace.
function stripColumns(str, n, col) {
  let i = 0;
  let c = col;
  let remaining = n;
  let pending = '';
  while (remaining > 0 && i < str.length) {
    if (str[i] === ' ') { i++; c++; remaining--; }
    else if (str[i] === '\t') {
      const w = 4 - (c % 4);
      if (w <= remaining) { i++; c += w; remaining -= w; }
      else {
        pending = ' '.repeat(w - remaining);
        i++;
        c += w;
        remaining = 0;
      }
    } else {
      return null;
    }
  }
  if (remaining > 0) return null;
  return { rest: str.slice(i), prefix: pending, endCol: c };
}

// Expand the leading whitespace (spaces/tabs) of `line` to spaces,
// starting at column `col`. Tabs after the first non-whitespace character
// are left alone.
function expandLeadingWhitespace(line, col) {
  let i = 0;
  let c = col;
  let out = '';
  while (i < line.length) {
    if (line[i] === ' ') { out += ' '; i++; c++; }
    else if (line[i] === '\t') { const w = 4 - (c % 4); out += ' '.repeat(w); i++; c += w; }
    else break;
  }
  return out + line.slice(i);
}

// Strip a block quote marker (up to 3 spaces, '>', one optional space)
// from `line`. A tab in place of the optional space is partially consumed.
// Returns the inner line (leading tabs expanded to spaces, so a re-lex
// sees the right columns) and the column at which it starts, or null.
function stripBlockquoteMarker(line) {
  let i = 0;
  let col = 0;
  while (i < line.length && line[i] === ' ' && col < 3) { i++; col++; }
  if (i >= line.length || line[i] !== '>') return null;
  i++;
  col++;
  if (i < line.length && line[i] === ' ') { i++; col++; }
  else if (i < line.length && line[i] === '\t') {
    const w = 4 - (col % 4);
    // The optional space consumes one column of the tab; the rest stays.
    const rest = ' '.repeat(w - 1) + line.slice(i + 1);
    return { rest: expandLeadingWhitespace(rest, col + 1), col: col + 1 };
  }
  return { rest: expandLeadingWhitespace(line.slice(i), col), col };
}

// Parse a list marker line (tab-aware). Returns null when the line is not
// a list item start. `content` is the line after the marker and its
// following whitespace, with a partially consumed tab left as spaces.
function parseListMarker(line) {
  const lw = leadingWhitespaceColumns(line, 0);
  if (lw.columns > 3) return null;
  const rest = line.slice(lw.index);
  const m = /^([*+-]|\d{1,9}[.)])/.exec(rest);
  if (!m) return null;
  const marker = m[1];
  const ordered = marker.charCodeAt(0) >= 48 && marker.charCodeAt(0) <= 57;
  const markerEndCol = lw.columns + marker.length;
  const after = rest.slice(marker.length);
  const info = {
    marker,
    ordered,
    delim: ordered ? marker[marker.length - 1] : null,
    startNum: ordered ? parseInt(marker.slice(0, -1), 10) : 0,
    indentCols: lw.columns,
    contentIndent: markerEndCol + 1,
    content: '',
  };
  if (after.length === 0) return info;
  const ws = leadingWhitespaceColumns(after, markerEndCol);
  if (ws.index === 0) return null;
  const wsCols = ws.columns;
  if (ws.index >= after.length) {
    // Empty item (only whitespace after the marker): the content
    // indent is just past the marker.
    info.contentIndent = markerEndCol + 1;
    return info;
  }
  if (wsCols >= 5) {
    info.contentIndent = markerEndCol + 1;
    const s = stripColumns(after, 1, markerEndCol);
    info.content = expandLeadingWhitespace(s.prefix + s.rest, s.endCol - s.prefix.length);
  } else {
    info.contentIndent = markerEndCol + wsCols;
    info.content = after.slice(ws.index);
  }
  return info;
}

// A link label, normalised the way link reference definitions are looked up:
// case-folded, internal runs of whitespace collapsed to one space.
function normalizeLabel(label) {
  // Unicode case folding: sharp S (ß, ẞ) folds to "ss".
  return label.toLowerCase().replace(/ß|ẞ/g, 'ss').replace(/\s+/g, ' ').trim();
}

function rtrim(str, c) {
  let i = str.length;
  while (i > 0 && str[i - 1] === c) i--;
  return str.slice(0, i);
}

// Split a table row on unescaped pipes, honouring code spans (a pipe inside
// backticks does not split) and backslash escapes. The row's outer pipes
// are stripped first, so a leading or trailing pipe makes no empty cell.
function splitCells(row) {
  let s = row;
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
  const cells = [];
  let start = 0;
  // Split on every | that is not escaped (\|). A | inside a code span is
  // still a separator in marked's tables; only \| is literal.
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '|') {
      cells.push(s.slice(start, i));
      start = i + 1;
    }
  }
  cells.push(s.slice(start));
  // An escaped pipe in a cell is a literal pipe, not a separator; the
  // backslash is removed before inline parsing so a code span sees `|`.
  return cells.map(c => c.replace(/\\\|/g, '|'));
}

// ---------- block rules ----------
// edit() builds a regex from a template by substituting other rules'
// sources (with their ^ anchors stripped), the way marked assembles its
// paragraph and list rules.
function edit(regex, opt) {
  let src = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(/(^|[^\[])\^/g, '$1');
      src = src.replace(name, () => v);
      return obj;
    },
    getRegex() {
      return new RegExp(src, opt);
    },
  };
  return obj;
}

const BULLET_SRC = '(?:[*+-]|\\d{1,9}[.)])';

// Block-level tag names (CommonMark HTML block type 6).
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

const BLOCK_NEWLINE = /^\n+/;
const BLOCK_CODE = /^( {4}[^\n]+\n*)+/;
const BLOCK_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?:\n+|$)|$)/;
const BLOCK_HR = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})(?:\n+|$)/;
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLOCK_BLOCKQUOTE = /^( {0,3}> ?(.)*(?:\n|$))+/;
const BLOCK_HTML_START = new RegExp('^ {0,3}(?:<(script|pre|style|textarea)(?:\\s|>|$)|<!--|<\\?|<!\\[CDATA\\[|<!\\[[A-Za-z]|<!DOCTYPE|<\\/?(?:' + [...BLOCK_TAGS].join('|') + ')(?=[\\s>\\/]|$)|<[A-Za-z][A-Za-z0-9-]*(?:\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s\"\\x27=<>\\x60]+|\\x27[^\\x27]*\\x27|\"[^\"]*\"))?)*\\s*\\/?>|<\\/[A-Za-z][A-Za-z0-9-]*\\s*>)', 'i');
const BLOCK_HTML_INTERRUPT = new RegExp('^ {0,3}(?:<(script|pre|style|textarea)(?:\\s|>|$)|<!--|<\\?|<!\\[CDATA\\[|<!\\[[A-Za-z]|<!DOCTYPE|<\\/?(?:' + [...BLOCK_TAGS].join('|') + ')(?=[\\s>\\/]|$))', 'i');
const BLOCK_DEF = /^ {0,3}\[((?:\\.|[^\[\]])+)\]: *\n? *(?:<((?:\\.|[^<>\\\n])*)>|([^\s>]+))(?:(?: +| *\n *)((?:\"(?:\\.|[^\"\\\n]|\n(?!\n))*\"|'(?:\\.|[^'\\\n]|\n(?!\n))*'|\((?:\\.|[^)\\\n]|\n(?!\n))*\))) *(?:\n+|$)| *(?:\n+|$)| *$)/;
const BLOCK_TABLE = /^ {0,3}(.+)\n {0,3}(\|? *?:?-+:? *(?:\| *?:?-+:? *)*(?:\| *)?)(?:\n|$)/;
const BLOCK_LHEADING = /^((?:[^\n]+\n)+?) {0,3}(=+|-+) *(?:\n+|$)/;
// A paragraph: lines that do not start a block construct. The lookahead
// lists the block starts (with their ^ anchors stripped) that interrupt it.
// Fences and lists use start-only patterns: a fence opener, and a list
// marker that begins a non-empty item (ordered lists only from 1).
const BLOCK_PARA = edit(/^([^\n]+(?:\n(?![ \t]*(?:\n|$))(?!hr|heading|blockquote|fences|list|html|table)[^\n]+)*)/)
  .replace('hr', BLOCK_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', BLOCK_BLOCKQUOTE)
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~{3,})')
  .replace('list', ' {0,3}(?:[*+-] +(?=\\S)|1[.)] +(?=\\S))')
  .replace('html', BLOCK_HTML_INTERRUPT)
  .replace('table', BLOCK_TABLE)
  .replace('def', BLOCK_DEF)
  .getRegex();
// Paragraph inside a list item: any ordered list marker interrupts it,
// not just 1. (At the top level, and inside blockquotes, only 1 does.)
const BLOCK_PARA_LIST = edit(/^([^\n]+(?:\n(?![ \t]*(?:\n|$))(?!hr|heading|blockquote|fences|list|html|table)[^\n]+)*)/)
  .replace('hr', BLOCK_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', BLOCK_BLOCKQUOTE)
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~{3,})')
  .replace('list', ' {0,3}(?:[*+-] +(?=\\S)|\\d{1,9}[.)] +(?=\\S))')
  .replace('html', BLOCK_HTML_INTERRUPT)
  .replace('table', BLOCK_TABLE)
  .replace('def', BLOCK_DEF)
  .getRegex();

// A list: up to 3 spaces, a bullet, a space (or the end of the line for an
// empty item), then content. It ends at an hr, a link definition, two
// blank lines (unless the next line is indented or another item of this
// list), or the end of the input.
const BLOCK_LIST = edit(/^( {0,3})(bull)(?: +|(?=\n|$))[\s\S]*?(?:hr|def|\n{2,}(?! )(?!\1bull\n)|\s*$)/)
  .replace(/bull/g, BULLET_SRC)
  .replace('hr', '\\n+ {0,3}(?:(?:\\* *){3,}|(?:- *){3,}|(?:_ *){3,})(?:\\n+|$)')
  .replace('def', '\\n+(?= {0,3}\\[(?:[^\\]]*)\\]:)')
  .getRegex();

// ---------- inline rules ----------
const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-.\/:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_TAG = /^<!--(?:>|->|[\s\S]*?-->)|^<\?[\s\S]*?\?>|^<!\[CDATA\[[\s\S]*?\]\]>|^<![A-Z][\s\S]*?>|^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)*\s*\/?>|^<\/[A-Za-z][A-Za-z0-9-]*\s*>/;
const INLINE_LINK = /^!?\[((?:\[(?:\\[\s\S]|[^\[\]]|\[(?:\\[\s\S]|[^\[\]])*\])*\]|\\[\s\S]|[^\[\]])*)\]\([ \t\r\n]*(<(?:\\.|[^<>\\\n])*?>|(?:\\.|[^ \t\r\n()<>\\]|\((?:\\.|[^ \t\r\n()<>\\]|\((?:\\.|[^ \t\r\n()<>\\])*\))*\))*)(?:[ \t\n]+((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\))))?[ \t\n]*\)/;
const INLINE_REFLINK = /^!?\[((?:\[(?:\\[\s\S]|[^\[\]]|\[(?:\\[\s\S]|[^\[\]])*\])*\]|\\[\s\S]|[^\[\]])*)\]\[((?:\\.|[^\[\]])*)\]/;
const INLINE_NOLINK = /^!?\[((?:\[(?:\\[\s\S]|[^\[\]]|\[(?:\\[\s\S]|[^\[\]])*\])*\]|\\[\s\S]|[^\[\]])*)\]/;
const INLINE_REFLINK_SEARCH = /\[((?:\[(?:\\[\s\S]|[^\[\]]|\[(?:\\[\s\S]|[^\[\]])*\])*\]|\\[\s\S]|[^\[\]])*)\]/g;
const INLINE_CODE = /^(`+)([\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^(?: {2,}|\\)\n(?!\s*$)/;
const INLINE_DEL = /^~~(?=\S)((?:[^~]|~(?!~))*?[^~\s])~~(?!~)|^~(?=\S)([^~]*?[^~\s])~(?!~)/;
const INLINE_AUTOLINK = /^<(?:([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)|([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*))>/;
// GFM extended autolinks: scheme/www URLs and email addresses.
const INLINE_URL = /^((?:[Ff][Tt][Pp]|[Hh][Tt][Tt][Pp][Ss]?):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)|^([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(\/[^\\s\/<]+)?)/;
const INLINE_BACKPEDAL = /(?:[^?!.,:;*_~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_~)]+(?:(?=[a-zA-Z0-9]))|\)+(?:(?=[a-zA-Z0-9])))+$/;
// Plain text: runs until a character that can start another inline
// construct, a hard-break run, a www. autolink, an email address, or the end.
const INLINE_TEXT = /^[\s\S]+?(?=[\\<!\[_*`~$]|[Hh][Tt][Tt][Pp][Ss]?:\/\/|[Ff][Tt][Pp]:\/\/| {2,}\n|www\.|(?=[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9])|(?=[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9])|$)/;

// Find the index just past the closing ~~ (double) or ~ (single) for a
// strikethrough starting at rest[0]. Nested pairs of the same kind are
// counted, so ~~a ~~b~~ c~~ closes at the last ~~. Returns -1 if none.
function findDelClose(rest, double) {
  const openLen = double ? 2 : 1;
  if (openLen >= rest.length || /\s/.test(rest[openLen])) return -1;
  // A ~~ opener followed by another ~ is a ~~~ run, not a del opener.
  if (double && rest[openLen] === '~') return -1;
  let depth = 0;
  let i = openLen;
  while (i < rest.length) {
    // An escaped \~ is literal content, never a run boundary (as in
    // ~~run \~~~ -> <del>run ~</del>, where the closer is the ~~ after
    // the escaped ~). Skip a backslash and whatever it escapes.
    if (rest[i] === '\\') { i += 2; continue; }
    if (rest[i] !== '~') { i++; continue; }
    let j = i;
    while (j < rest.length && rest[j] === '~') j++;
    const run = j - i;
    const prevCh = i > openLen ? rest[i - 1] : '';
    // The closer is exactly 2 tildes (double) or 1 (single); the char
    // after it must not be ~ (so ~~~ does not close a ~~ del, and an
    // unescaped ~~run ~~~ stays literal).
    const afterClose = double ? i + 2 : j;
    const nextCh = afterClose < rest.length ? rest[afterClose] : '';
    // prevCh can only be ~ when that ~ is escaped (runs are maximal),
    // which is content, so it does not block the closer.
    const canClose = prevCh !== '' && !/\s/.test(prevCh) && nextCh !== '~';
    if (double) {
      if (run === 2) {
        if (canClose) {
          if (depth === 0) return j;
          depth--;
        } else {
          depth++;
        }
        i = j;
        continue;
      }
      // A run of 1 or 3+ tildes is content here (an opener for the
      // nesting count when it cannot close).
      if (run !== 1) depth++;
      i = j;
      continue;
    }
    if (run === 1) {
      if (canClose) {
        if (depth === 0) return j;
        depth--;
      } else {
        depth++;
      }
      i = j;
      continue;
    }
    i = j;
  }
  return -1;
}

// ---------- block lexer ----------

// Read the line starting at pos: { text (without \n), next (start of the
// following line), hasNl }.
function lineAt(src, pos) {
  const nl = src.indexOf('\n', pos);
  if (nl === -1) return { text: src.slice(pos), next: src.length, hasNl: false };
  return { text: src.slice(pos, nl), next: nl + 1, hasNl: true };
}

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

// Does this line start a block construct that interrupts a paragraph?
function interruptsParagraph(line, nextLine) {
  if (/^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,}) *$/.test(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return true;
  if (/^ {0,3}(?:[*+-] +(?=\S)|1[.)] +(?=\S))/.test(line)) return true;
  if (BLOCK_HTML_INTERRUPT.test(line)) return true;
  // A table delimiter row following this line makes a table of it.
  if (nextLine !== undefined && /^ {0,3}\|? *?:?-+:? *(?:\| *?:?-+:? *)*(?:\| *)?$/.test(nextLine) && /[|:]/.test(nextLine)) return true;
  return false;
}

// Whether the last block of these tokens is a paragraph (recursing into
// block quotes and lists), so a lazy continuation line may follow it.
function endsWithParagraph(tokens) {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.type === 'space') continue;
    if (t.type === 'paragraph') return true;
    if (t.type === 'blockquote') return endsWithParagraph(t.tokens);
    if (t.type === 'list') {
      const last = t.items[t.items.length - 1];
      return last ? endsWithParagraph(last.tokens) : false;
    }
    return false;
  }
  return false;
}

// Strip 4 columns from recorded lazy lines inside paragraph texts.
// `lazyLines` is a queue of original lazy-line texts (in order); each
// matching paragraph-text line loses 4 leading columns.
// Append trailing whitespace to the last paragraph token (the one
// that ends the token list), for a blockquote trailing-whitespace line.
function appendTrailingWs(tokens, ws, inlineQueue) {
  function lastPara(ts) {
    for (let i = ts.length - 1; i >= 0; i--) {
      const t = ts[i];
      if (t.type === 'space') continue;
      if (t.type === 'paragraph') return t;
      if (t.type === 'blockquote') return lastPara(t.tokens);
      if (t.type === 'list' && t.items && t.items.length) {
        return lastPara(t.items[t.items.length - 1].tokens);
      }
      return null;
    }
    return null;
  }
  const p = lastPara(tokens);
  if (!p) return;
  const newText = p.text + '\n' + ws;
  p.text = newText;
  if (inlineQueue) {
    for (const q of inlineQueue) {
      if (q.tokens === p.tokens) { q.src = newText; break; }
    }
  }
}

function stripLazyIndent(tokens, lazyLines, inlineQueue) {
  let qi = 0;
  function walk(ts) {
    for (const t of ts) {
      if (t.type === 'paragraph' && qi < lazyLines.length) {
        const lines = t.text.split('\n');
        for (let k = 0; k < lines.length && qi < lazyLines.length; k++) {
          if (lines[k] === lazyLines[qi]) {
            const s = stripColumns(lines[k], 4, 0);
            lines[k] = s ? s.prefix + s.rest : lines[k];
            qi++;
          }
        }
        const newText = lines.join('\n');
        if (newText !== t.text) {
          t.text = newText;
          // Inline tokens are parsed later from the queued source string,
          // so update that too.
          if (inlineQueue) {
            for (const q of inlineQueue) {
              if (q.tokens === t.tokens) { q.src = newText; break; }
            }
          }
        }
      }
      if (t.tokens) walk(t.tokens);
      if (t.items) for (const it of t.items) walk(it.tokens);
    }
  }
  walk(tokens);
}

class Lexer {
  constructor() {
    this.links = Object.create(null);
    this.inlineQueue = [];
    // While true, queueInline returns a throwaway array without enqueueing
    // (used by throwaway probe lexes, e.g. the lazy-line check).
    this.suppressQueue = false;
    // An unclosed inline <a> leaves GFM URLs/emails suppressed in all
    // later blocks (marked's lexer state persists); a </a> clears it.
    this.htmlAOpen = false;
  }

  lex(src) {
    src = src.replace(/\r\n|\r/g, '\n');
    const tokens = [];
    this.blockTokens(src, tokens);
    // Process the inline queue in token-tree (document) order, not
    // insertion order: nested-list builds and lazy-line probes can
    // enqueue entries out of document order, and the htmlAOpen flag
    // (unclosed <a> suppressing later GFM urls) depends on order.
    const byTokens = new Map();
    for (const q of this.inlineQueue) byTokens.set(q.tokens, q.src);
    const walk = (toks) => {
      for (const t of toks) {
        if ((t.type === 'paragraph' || t.type === 'heading') && byTokens.has(t.tokens)) {
          const src = byTokens.get(t.tokens);
          byTokens.delete(t.tokens);
          t.tokens.push(...this.inlineTokens(src));
        } else if (t.type === 'blockquote') {
          walk(t.tokens);
        } else if (t.type === 'list') {
          for (const it of t.items) walk(it.tokens);
        } else if (t.type === 'table') {
          for (const c of t.header) {
            if (byTokens.has(c.tokens)) { const src = byTokens.get(c.tokens); byTokens.delete(c.tokens); c.tokens.push(...this.inlineTokens(src)); }
          }
          for (const row of t.rows) for (const c of row) {
            if (byTokens.has(c.tokens)) { const src = byTokens.get(c.tokens); byTokens.delete(c.tokens); c.tokens.push(...this.inlineTokens(src)); }
          }
        }
      }
    };
    walk(tokens);
    // Any entry not reachable from the tree (should not happen) falls
    // back to insertion order.
    for (const q of this.inlineQueue) {
      if (byTokens.has(q.tokens)) { byTokens.delete(q.tokens); q.tokens.push(...this.inlineTokens(q.src)); }
    }
    this.inlineQueue = [];
    return tokens;
  }

  // Queue a string for inline parsing once the whole block pass is done,
  // so link reference definitions anywhere in the document apply.
  queueInline(src) {
    const tokens = [];
    if (!this.suppressQueue) this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  blockTokens(src, tokens, opts) {
    const noSetext = opts && opts.noSetext;
    const isInner = opts && opts.isInner;
    const inListItem = opts && opts.inListItem;
    const PARA = inListItem ? BLOCK_PARA_LIST : BLOCK_PARA;
    let pos = 0;
    const len = src.length;
    while (pos < len) {
      const rest = src.slice(pos);
      let m;
      // blank lines (a line of only spaces/tabs counts as blank)
      {
        const { text: firstLine } = lineAt(rest, 0);
        if (isBlankLine(firstLine)) {
          let p = 0;
          let newlines = 0;
          while (p < rest.length) {
            const { text: line, next, hasNl } = lineAt(rest, p);
            if (!isBlankLine(line)) break;
            if (hasNl) newlines++;
            p = next;
          }
          pos += p;
          if (newlines > 1) tokens.push({ type: 'space' });
          continue;
        }
      }
      // indented code (tab-aware): a line with >= 4 columns of leading
      // whitespace. Blank lines between code lines belong to the block
      // (keeping their content after the 4-column strip); leading and
      // trailing blank lines do not. Tabs in the content are preserved,
      // except a tab the indent cuts through, which leaves spaces.
      {
        const { text: firstLine } = lineAt(rest, 0);
        if (leadingWhitespaceColumns(firstLine, 0).columns >= 4) {
          let p = 0;
          let text = '';
          let pendingBlanks = [];
          let end = 0;
          let started = false;
          while (p < rest.length) {
            const { text: line, next, hasNl } = lineAt(rest, p);
            if (isBlankLine(line)) {
              const s = stripColumns(line, 4, 0);
              pendingBlanks.push(s ? s.prefix + s.rest : '');
              p = next;
              continue;
            }
            if (leadingWhitespaceColumns(line, 0).columns >= 4) {
              if (started) {
                for (const b of pendingBlanks) text += b + '\n';
              }
              pendingBlanks = [];
              started = true;
              const stripped = stripColumns(line, 4, 0);
              text += stripped.prefix + stripped.rest + (hasNl ? '\n' : '');
              p = next;
              end = p;
            } else {
              break;
            }
          }
          if (end > 0) {
            pos += end;
            tokens.push({ type: 'code', text, lang: null });
            continue;
          }
        }
      }
      // fenced code
      if ((m = BLOCK_FENCES.exec(rest))) {
        pos += m[0].length;
        const info = m[2] ? m[2].trim() : '';
        let text = m[3] || '';
        // The fence regex consumes the newline before the closing fence;
        // it belongs to the code text only when the captured content
        // does not already end with a newline (a trailing blank line
        // already supplies one).
        const fenceLine = lineAt(rest, 0);
        const contentStart = fenceLine.next;
        if (text && !text.endsWith('\n') && rest[contentStart + text.length] === '\n') text += '\n';
        // Content lines lose up to the opening fence's indent -- but
        // only for backtick fences: a tilde fence keeps its content
        // lines' indentation verbatim.
        const fenceIndent = /^ */.exec(fenceLine.text)[0].length;
        if (fenceIndent > 0 && text && m[1][0] === '`') {
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            // Strip up to fenceIndent leading whitespace characters; a
            // tab counts as one character, so a tab cut through by the
            // strip is removed whole, not left as spaces.
            let n = 0;
            while (n < lines[i].length && n < fenceIndent && (lines[i][n] === ' ' || lines[i][n] === '\t')) n++;
            if (n > 0) lines[i] = lines[i].slice(n);
          }
          text = lines.join('\n');
        }
        tokens.push({ type: 'code', text, lang: info ? unescapeBackslash(info.split(/\s+/)[0]) : '' });
        continue;
      }
      // thematic break
      if ((m = BLOCK_HR.exec(rest))) {
        pos += m[0].length;
        tokens.push({ type: 'hr' });
        continue;
      }
      // ATX heading
      if ((m = BLOCK_HEADING.exec(rest))) {
        pos += m[0].length;
        const text = m[2].replace(/ #+ *$/, '').trim();
        tokens.push({ type: 'heading', depth: m[1].length, text, tokens: this.queueInline(text) });
        continue;
      }
      // block quote (with lazy continuation lines)
      if (rest.charCodeAt(0) === 62 || /^ {0,3}>/.test(rest)) {
        const bq = this.blockquote(rest);
        if (bq) {
          pos += bq.length;
          const innerTokens = this.blockTokens(bq.inner, [], { noSetext: bq.noSetext, isInner: true });
          if (bq.lazyIndent && bq.lazyIndent.length) stripLazyIndent(innerTokens, bq.lazyIndent, this.inlineQueue);
          if (bq.trailingWs) appendTrailingWs(innerTokens, bq.trailingWs, this.inlineQueue);
          tokens.push({ type: 'blockquote', tokens: innerTokens });
          continue;
        }
      }
      // list
      if (parseListMarker(lineAt(rest, 0).text)) {
        const li = this.list(rest);
        if (li) {
          pos += li.length;
          tokens.push(li.token);
          continue;
        }
      }
      // raw HTML block
      if (BLOCK_HTML_START.test(rest)) {
        const hb = this.htmlBlock(rest, isInner);
        if (hb) {
          pos += hb.length;
          tokens.push({ type: 'html', text: hb.text, pre: hb.pre });
          continue;
        }
      }
      // link reference definition
      if ((m = BLOCK_DEF.exec(rest))) {
        const label = normalizeLabel(m[1].replace(/\\([\\\[\]])/g, '$1'));
        // An empty label (e.g. only whitespace) is not a definition.
        if (label === '') {
          // Fall through to the paragraph rule below.
        } else {
          pos += m[0].length;
          const title = m[4] ? unescapeBackslash(m[4].slice(1, -1)) : null;
          const rawHref = m[2] !== undefined ? m[2] : m[3];
          if (!(label in this.links)) {
            this.links[label] = { href: cleanUrl(unescapeBackslash(rawHref)) || unescapeBackslash(rawHref), title };
          }
          continue;
        }
      }
      // GFM table
      if ((m = BLOCK_TABLE.exec(rest)) && /[|:]/.test(m[2])) {
        const table = this.table(rest, m);
        if (table) {
          pos += table.length;
          tokens.push(table.token);
          continue;
        }
      }
      // setext heading (disabled when the inner text ends in a lazy ===
      // line, which is paragraph text, not an underline)
      if (!noSetext && (m = BLOCK_LHEADING.exec(rest))) {
        pos += m[0].length;
        const text = m[1].replace(/\n$/, '').trim();
        tokens.push({ type: 'heading', depth: m[2][0] === '=' ? 1 : 2, text, tokens: this.queueInline(text) });
        continue;
      }
      // paragraph
      if ((m = PARA.exec(rest))) {
        pos += m[0].length;
        let text = m[1];
        if (text.charCodeAt(text.length - 1) === 10) text = text.slice(0, -1);
        tokens.push({ type: 'paragraph', text, tokens: this.queueInline(text) });
        continue;
      }
      // Fallback: consume one line as a paragraph so lexing always moves.
      const nl = rest.indexOf('\n');
      const line = nl === -1 ? rest : rest.slice(0, nl);
      pos += line.length + (nl === -1 ? 0 : 1);
      tokens.push({ type: 'paragraph', text: line, tokens: this.queueInline(line) });
    }
    return tokens;
  }

  // A block quote: lines starting with an optional 3 spaces and '>', blank
  // lines that precede another '>' line, and lazy continuation lines of a
  // trailing paragraph. Returns the inner text (markers stripped) and the
  // consumed length.
  blockquote(src) {
    let pos = 0;
    let inner = '';
    let innerTokens = null;
    let lazyCount = 0;
    let noSetext = false;
    // Lazy lines indented 4+ columns lose 4 of them, but only in the
    // paragraph text (they must not re-lex as a block start), so the
    // original line is kept in `inner` and stripped from the token later.
    let lazyIndent = [];
    while (pos < src.length) {
      const { text: line, next, hasNl } = lineAt(src, pos);
      const qm = stripBlockquoteMarker(line);
      if (qm) {
        inner += qm.rest + (hasNl ? '\n' : '');
        pos = next;
        innerTokens = null;
        lazyCount = 0;
        continue;
      }
      if (isBlankLine(line)) {
        // A blank line without a '>' marker ends the quote; a '>' line
        // that follows starts a new blockquote.
        break;
      }
      // Lazy continuation line: the inner content must end in a paragraph
      // and the line must not start a block construct. A blank line at
      // the end of the inner content closes the paragraph.
      if (innerTokens === null) {
        // Probe only (checks endsWithParagraph); do not queue inline
        // content, or the queue fills with duplicates out of order.
        this.suppressQueue = true;
        try { innerTokens = this.blockTokens(inner, []); }
        finally { this.suppressQueue = false; }
      }
      if (endsWithParagraph(innerTokens) && !inner.endsWith('\n\n')) {
        const { text: nl2 } = lineAt(src, next);
        if (!interruptsParagraph(line, nl2)) {
          // A lazy line that looks like a setext === underline is not an
          // underline: after another lazy line it is indented 4 (so it
          // cannot be one), and as the first lazy line it must not form
          // one either (handled by noSetext below).
          if (/^ {0,3}=+ *$/.test(line)) {
            if (lazyCount > 0) {
              inner += '    ' + line.trimStart() + '\n';
            } else {
              inner += line + '\n';
              noSetext = true;
            }
          } else if (leadingWhitespaceColumns(line, 0).columns >= 4) {
            // A lazy line indented 4+ columns loses 4 of them in the
            // paragraph text; keep the original line in `inner` so it
            // cannot re-lex as a block start, and record it for later.
            lazyIndent.push(line);
            inner += line + '\n';
          } else {
            inner += line + '\n';
          }
          lazyCount++;
          pos = next;
          innerTokens = null;
          continue;
        }
      }
      break;
    }
    if (pos === 0) return null;
    // A trailing whitespace-only line (from a '>' line) at the end of the
    // quote is part of the last paragraph's text; keep it out of `inner`
    // (it would otherwise end the paragraph) and append it afterwards.
    let trailingWs = null;
    const twm = /\n( +)\n$/.exec(inner);
    if (twm) {
      trailingWs = twm[1];
      inner = inner.slice(0, inner.length - twm[0].length) + '\n';
    }
    return { inner, length: pos, noSetext, lazyIndent, trailingWs };
  }

  // A raw HTML block (CommonMark types 1-7). Returns the block text, whether
  // it is a pre/script/style/textarea block, and the consumed length.
  // isInner is true when lexing the inner text of a container (list item,
  // block quote): a trailing HTML block there drops its final newline,
  // which belongs to the container, not the block.
  htmlBlock(src, isInner) {
    const start = BLOCK_HTML_START.exec(src);
    if (!start) return null;
    const tag = start[1] ? start[1].toLowerCase() : null;
    const first = lineAt(src, 0);
    // Drop a block's trailing newline when it is followed by a blank line
    // or ends inner text (the newline belongs to the container, not the
    // block); at the top level it is kept.
    const dropNl = (text, pos) => {
      if (!text.endsWith('\n')) return text;
      if (pos < src.length) {
        return isBlankLine(lineAt(src, pos).text) ? text.slice(0, -1) : text;
      }
      return isInner ? text.slice(0, -1) : text;
    };
    // For pre/script/style/textarea and comments, a whitespace-only
    // (but non-empty) next line does not drop the trailing newline;
    // only a truly empty next line does.
    const dropNlStrict = (text, pos) => {
      if (!text.endsWith('\n')) return text;
      if (pos < src.length) {
        return lineAt(src, pos).text === '' ? text.slice(0, -1) : text;
      }
      return isInner ? text.slice(0, -1) : text;
    };
    // Type 1: script, pre, style, textarea: ends at the matching end tag.
    if (tag) {
      const endRe = new RegExp('</' + tag + '(?:\\s|>|$)', 'i');
      let pos = 0;
      while (pos < src.length) {
        const { text: line, next } = lineAt(src, pos);
        pos = next;
        if (endRe.test(line)) return { text: dropNlStrict(src.slice(0, pos), pos), pre: true, length: pos };
      }
      return { text: src, pre: true, length: src.length };
    }
    // Type 2: comment, ends at -->.
    if (/^ {0,3}<!--/.test(first.text)) {
      if (first.text.includes('-->')) return { text: dropNlStrict(first.text + (first.hasNl ? '\n' : ''), first.next), pre: false, length: first.next };
      let pos = first.next;
      while (pos < src.length) {
        const { text: line, next } = lineAt(src, pos);
        pos = next;
        if (line.includes('-->')) return { text: dropNlStrict(src.slice(0, pos), pos), pre: false, length: pos };
      }
      return { text: src, pre: false, length: src.length };
    }
    // Type 3: processing instruction, ends at ?>.
    if (/^ {0,3}<\?/.test(first.text)) {
      if (first.text.includes('?>')) return { text: dropNl(first.text + (first.hasNl ? '\n' : ''), first.next), pre: false, length: first.next };
      let pos = first.next;
      while (pos < src.length) {
        const { text: line, next } = lineAt(src, pos);
        pos = next;
        if (line.includes('?>')) return { text: dropNl(src.slice(0, pos), pos), pre: false, length: pos };
      }
      return { text: src, pre: false, length: src.length };
    }
    // Type 5: CDATA, ends at ]]>.
    if (/^ {0,3}<!\[CDATA\[/.test(first.text)) {
      if (first.text.includes(']]>')) return { text: dropNl(first.text + (first.hasNl ? '\n' : ''), first.next), pre: false, length: first.next };
      let pos = first.next;
      while (pos < src.length) {
        const { text: line, next } = lineAt(src, pos);
        pos = next;
        if (line.includes(']]>')) return { text: dropNl(src.slice(0, pos), pos), pre: false, length: pos };
      }
      return { text: src, pre: false, length: src.length };
    }
    // Type 4: declaration, ends at the first >.
    if (/^ {0,3}<!/.test(first.text)) {
      let pos = 0;
      while (pos < src.length) {
        const { text: line, next } = lineAt(src, pos);
        pos = next;
        if (line.includes('>')) return { text: dropNl(src.slice(0, pos), pos), pre: false, length: pos };
      }
      return { text: src, pre: false, length: src.length };
    }
    // Type 6: a block-level tag (CommonMark's list) opens a block that
    // ends at a blank line. This is checked before type 7: a <div> on its
    // own line is type 6, not a one-line type 7 block.
    const tagName = /^ {0,3}<\/?([a-zA-Z][\w-]*)/.exec(first.text);
    if (tagName && BLOCK_TAGS.has(tagName[1].toLowerCase())) {
      let pos = first.next;
      while (pos < src.length) {
        const { text: line, next } = lineAt(src, pos);
        if (isBlankLine(line)) break;
        pos = next;
      }
      return { text: dropNl(src.slice(0, pos), pos), pre: false, length: pos };
    }
    // Type 7: a single line that is exactly one complete tag. In marked
    // such a block continues until a blank line, like type 6 (so the lines
    // after <a href="foo"> are raw HTML, not markdown).
    const stripped = first.text.replace(/^ {0,3}/, '');
    if (/^<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?> *$/.test(stripped)) {
      let pos = first.next;
      while (pos < src.length) {
        const { text: line, next } = lineAt(src, pos);
        if (isBlankLine(line)) break;
        pos = next;
      }
      return { text: dropNl(src.slice(0, pos), pos), pre: false, length: pos };
    }
    // Any other tag (e.g. an inline tag spanning lines) is not an HTML
    // block; it is paragraph text (and may be a setext heading).
    return null;
  }

  // A list: items are collected line by line. A line starts a new item
  // when it has a marker of the same type indented less than the current
  // item's content indent; a line indented at least the content indent, or
  // a lazy paragraph continuation, belongs to the current item; anything
  // else ends the list. Blank lines are buffered and only kept when a
  // belonging line follows them.
  list(src) {
    const first = lineAt(src, 0);
    const fm = parseListMarker(first.text);
    if (!fm) return null;
    const marker = fm.marker;
    const ordered = fm.ordered;
    const delim = fm.delim;
    const startNum = fm.startNum;

    const items = [];
    let pos = 0;
    let pendingBlanks = [];
    let end = 0;
    // Fence state for the current item: a line inside a fenced code block
    // belongs to the item at any indent once the fence has content, until
    // the closing fence. A fence whose first content line is below the
    // item's content indent is empty: that line ends the item instead.
    // A closing fence below the content indent does not close this
    // fence; it ends the item and starts a new block outside the list.
    let fenceChar = null;
    let fenceLen = 0;
    let fenceHasContent = false;
    const updateFence = (l) => {
      if (fenceChar) {
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        if (cm && cm[1][0] === fenceChar && cm[1].length >= fenceLen) { fenceChar = null; fenceHasContent = false; }
      } else {
        const om = /^ {0,3}(`{3,}|~{3,})/.exec(l);
        if (om) { fenceChar = om[1][0]; fenceLen = om[1].length; fenceHasContent = false; }
      }
    };

    let cur = { lines: [fm.content], contentIndent: fm.contentIndent, task: false, checked: false, trailingNl: first.hasNl, lazyIndent: [] };
    updateFence(fm.content);
    pos = first.next;
    end = first.next;

    while (pos < src.length) {
      const { text: line, next, hasNl } = lineAt(src, pos);
      if (fenceChar) {
        // Inside a fenced code block. A blank line is code content.
        const lw0 = leadingWhitespaceColumns(line, 0);
        if (isBlankLine(line)) {
          cur.lines.push('');
          fenceHasContent = true;
          cur.trailingNl = hasNl;
          end = next;
          pos = next;
          continue;
        }
        if (lw0.columns < cur.contentIndent) {
          // Below the item's content indent: a closing fence here does
          // not close this fence (it ends the item), and a content line
          // only belongs once the fence already has content.
          const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
          if (cm && cm[1][0] === fenceChar && cm[1].length >= fenceLen) break;
          if (!fenceHasContent) break;
          cur.lines.push(line);
          cur.trailingNl = hasNl;
          end = next;
          pos = next;
          continue;
        }
        const s0 = stripColumns(line, cur.contentIndent, 0);
        const stripped = expandLeadingWhitespace(s0.prefix + s0.rest, s0.endCol - s0.prefix.length);
        const wasOpen = !!fenceChar;
        cur.lines.push(stripped);
        updateFence(stripped);
        if (wasOpen && fenceChar) fenceHasContent = true;
        cur.trailingNl = hasNl;
        end = next;
        pos = next;
        continue;
      }
      if (isBlankLine(line)) {
        pendingBlanks.push('');
        pos = next;
        continue;
      }
      // A thematic break ends the list (it wins over a list marker, e.g.
      // "* * *" is an hr, not a nested item) -- but only at the list
      // level; an hr line indented to the item's content belongs to it.
      const hrLw = leadingWhitespaceColumns(line, 0);
      if (BLOCK_HR.test(line) && hrLw.columns < cur.contentIndent) break;
      const im = parseListMarker(line);
      const imIndent = im ? im.indentCols : 0;
      const imMarker = im ? im.marker : null;
      const imOrdered = im ? im.ordered : false;
      const sameType = imMarker
        ? (ordered ? (imOrdered && imMarker[imMarker.length - 1] === delim) : (!imOrdered && imMarker === marker))
        : false;
      if (im && sameType && imIndent < cur.contentIndent) {
        // A new item of this list.
        if (pendingBlanks.length > 0) cur.lines.push(...pendingBlanks);
        items.push(cur);
        pendingBlanks = [];
        cur = { lines: [im.content], contentIndent: im.contentIndent, task: false, checked: false, trailingNl: hasNl, lazyIndent: [] };
        fenceChar = null; fenceLen = 0; fenceHasContent = false;
        updateFence(im.content);
        end = next;
        pos = next;
        continue;
      }
      if (im && imIndent < cur.contentIndent) {
        // A marker of another list type: this list ends.
        break;
      }
      const lw = leadingWhitespaceColumns(line, 0);
      if (lw.columns >= cur.contentIndent) {
        // An empty item followed by a blank line is closed; a later
        // indented line starts a new block instead.
        if (pendingBlanks.length > 0 && cur.lines.every((l) => l === '')) break;
        if (pendingBlanks.length > 0) {
          cur.lines.push(...pendingBlanks);
          pendingBlanks = [];
        }
        const s = stripColumns(line, cur.contentIndent, 0);
        const stripped = expandLeadingWhitespace(s.prefix + s.rest, s.endCol - s.prefix.length);
        cur.lines.push(stripped);
        updateFence(stripped);
        cur.trailingNl = hasNl;
        end = next;
        pos = next;
        continue;
      }
      // Lazy continuation line of the current item's trailing paragraph.
      // A blank line since the last content line closes the paragraph.
      const itemText = cur.lines.join('\n');
      this.suppressQueue = true;
      let itemTokens;
      try { itemTokens = this.blockTokens(itemText, []); }
      finally { this.suppressQueue = false; }
      const { text: nextLineText } = lineAt(src, next);
      if (pendingBlanks.length === 0 && endsWithParagraph(itemTokens) && !interruptsParagraph(line, nextLineText)) {
        if (pendingBlanks.length > 0) {
          cur.lines.push(...pendingBlanks);
          pendingBlanks = [];
        }
        // A lazy line indented 4+ columns loses 4 of them in the
        // paragraph text; keep the original line so it cannot re-lex
        // as a block start, and record it for later stripping.
        if (leadingWhitespaceColumns(line, 0).columns >= 4) cur.lazyIndent.push(line);
        cur.lines.push(line);
        cur.trailingNl = hasNl;
        end = next;
        pos = next;
        continue;
      }
      break;
    }
    if (cur) items.push(cur);
    if (items.length === 0) return null;

    // Loose when an item holds a blank line between its direct children,
    // or items are separated by blank lines. A blank line inside a nested
    // list does not loosen the outer list: both neighbours are then list
    // markers of that nested list, or indented nested content. The first
    // line is the marker line, not a blank line between blocks.
    let loose = false;
    const indentOf = (l) => leadingWhitespaceColumns(l, 0).columns;
    const isMarker = (l) => parseListMarker(l) !== null;
    for (const it of items) {
      const lines = it.lines;
      // Blank lines inside a fenced code block are code content, not
      // separators: track fence state while scanning.
      const inFence = new Set();
      let fenceChar = null;
      let fenceLen = 0;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (fenceChar) {
          inFence.add(i);
          const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
          if (cm && cm[1][0] === fenceChar && cm[1].length >= fenceLen) fenceChar = null;
        } else {
          const om = /^ {0,3}(`{3,}|~{3,})/.exec(l);
          if (om) { fenceChar = om[1][0]; fenceLen = om[1].length; }
        }
      }
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] !== '' || inFence.has(i)) continue;
        let j = i;
        while (j < lines.length && lines[j] === '') j++;
        let before = null;
        for (let k = i - 1; k >= 0; k--) { if (lines[k] !== '') { before = lines[k]; break; } }
        const after = j < lines.length ? lines[j] : null;
        let atItemLevel = false;
        if (before !== null && after !== null) {
          // Inside a nested list when both neighbours are indented, both
          // are list markers, the line before is a marker whose item's
          // content follows (indented), or the line after is a marker
          // whose item's content precedes it (indented).
          const nested = (indentOf(before) > 0 && indentOf(after) > 0)
            || (isMarker(before) && isMarker(after))
            || (isMarker(before) && indentOf(after) > 0)
            || (isMarker(after) && indentOf(before) > 0);
          atItemLevel = !nested;
        } else if (after === null) {
          // A trailing blank run in an item's lines means a new item
          // followed at this list's level: the items are separated.
          atItemLevel = true;
        }
        if (atItemLevel) { loose = true; break; }
        i = j - 1;
      }
      if (loose) break;
    }
    // Task lists: [ ] / [x] / [X] at the start of the item's first line.
    for (const it of items) {
      const tm = /^\[( |x|X)\](?: |$)/.exec(it.lines[0] || '');
      if (tm) {
        it.task = true;
        it.checked = tm[1] === 'x' || tm[1] === 'X';
        it.lines[0] = it.lines[0].slice(tm[0].length);
      }
      const content = it.lines.join('\n') + (it.trailingNl ? '\n' : '');
      it.tokens = this.blockTokens(content, [], { isInner: true, inListItem: true });
      if (it.lazyIndent && it.lazyIndent.length) stripLazyIndent(it.tokens, it.lazyIndent, this.inlineQueue);
    }
    return {
      length: end,
      token: { type: 'list', ordered, start: startNum, loose, items },
    };
  }

  // A GFM table. m is the BLOCK_TABLE match (header, delimiter). Body rows
  // are the non-blank lines that follow. Returns the token and the length.
  table(src, m) {
    const headerCells = splitCells(m[1].trim());
    const alignRaw = m[2].replace(/^ *\|? *| *\|? *$/g, '').split(/ *\| */);
    if (headerCells.length !== alignRaw.length) return null;
    const align = alignRaw.map((c) => {
      if (/^:-+:$/.test(c)) return 'center';
      if (/^-+:$/.test(c)) return 'right';
      if (/^:-+$/.test(c)) return 'left';
      return null;
    });
    const header = headerCells.map((c) => ({ text: c.trim(), tokens: this.queueInline(c.trim()) }));
    const rows = [];
    let pos = m[0].length;
    while (pos < src.length) {
      const { text: line, next } = lineAt(src, pos);
      // Only an empty or spaces-only line ends the table. A line that
      // contains a tab is a (possibly empty) body row, not a blank line.
      if (/^ *$/.test(line)) break;
      // A blockquote line ends the table; it is not a body row.
      if (/^ {0,3}>/.test(line)) break;
      // A line that starts a new block (fence, heading, list, hr, html
      // block, ...) ends the table body; it is not a row.
      const { text: nextLine } = lineAt(src, next);
      if (interruptsParagraph(line, nextLine)) break;
      const cells = splitCells(line.trim());
      const row = [];
      for (let i = 0; i < headerCells.length; i++) {
        const c = i < cells.length ? cells[i].trim() : '';
        row.push({ text: c, tokens: this.queueInline(c) });
      }
      rows.push(row);
      pos = next;
    }
    return {
      length: pos,
      token: { type: 'table', header, align, rows },
    };
  }
  // ---- Inline lexer ----
  // Tokenizes inline content. Delimiter runs (*, _) become 'delim' tokens
  // resolved by resolveEmphasis() after the pass. inLink blocks nested
  // links/reflinks and GFM urls (but not autolinks); inRawBlock makes
  // text tokens carry raw (unescaped) text.
  inlineTokens(src, inLink = false, inRawBlock = false, noLinks = false) {
    const tokens = [];
    let rest = src;
    let inLinkState = inLink;
    let inRawBlockState = inRawBlock;
    const pushText = (raw, text) => {
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') { last.raw += raw; last.text += text; }
      else tokens.push({ type: 'text', raw, text });
    };
    const prevChar = () => {
      const pos = src.length - rest.length;
      return pos > 0 ? src[pos - 1] : '';
    };

    while (rest) {
      let cap;
      // Escape: \x -> the literal char.
      if ((cap = INLINE_ESCAPE.exec(rest))) {
        rest = rest.slice(cap[0].length);
        pushText(cap[0], inRawBlockState ? cap[1] : escape(decodeNumericRefs(cap[1])));
        continue;
      }
      // Autolink: <scheme:...> or <email>. Checked before the tag rule so
      // a URL in angle brackets is a link, not a raw tag. Group 1 is a
      // URI (used as-is); group 2 is a bare email (mailto: prefixed).
      if (rest.charCodeAt(0) === 60 && (cap = INLINE_AUTOLINK.exec(rest))) {
        rest = rest.slice(cap[0].length);
        const display = cap[1] !== undefined ? cap[1] : cap[2];
        const href = cap[1] !== undefined ? display : 'mailto:' + display;
        tokens.push({ type: 'link', raw: cap[0], href: cleanUrl(href) || href, autolink: true, tokens: [{ type: 'text', raw: display, text: escape(decodeNumericRefs(display)) }] });
        continue;
      }
      // Raw HTML tag. Tracks <a> (link state) and pre/code/kbd/script (raw).
      if ((cap = INLINE_TAG.exec(rest))) {
        const tag = cap[0];
        if (!inLinkState && /^<a /i.test(tag)) { inLinkState = true; this.htmlAOpen = true; }
        // Any </a> clears the flag, even one in a later block than the
        // <a> that set it (inLinkState is per-entry, htmlAOpen persists).
        else if (/^<\/a>/i.test(tag)) { inLinkState = false; this.htmlAOpen = false; }
        if (!inRawBlockState && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) inRawBlockState = true;
        else if (inRawBlockState && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) inRawBlockState = false;
        rest = rest.slice(tag.length);
        tokens.push({ type: 'html', raw: tag, text: tag });
        continue;
      }
      // Inline link / image: [text](url "title"). Images ignore inLink.
      if (!noLinks && (cap = INLINE_LINK.exec(rest))) {
        const isImage = cap[0].charAt(0) === '!';
        if (isImage || !inLinkState) {
          if (!this.linkTextSwallowsBracket(cap, rest)) {
            const link = this.makeLink(cap, isImage);
            if (link) {
              rest = rest.slice(cap[0].length);
              tokens.push(link);
              continue;
            }
          }
        }
      }
      // Reference link / image: [text][ref].
      if (!noLinks && (cap = INLINE_REFLINK.exec(rest))) {
        const isImage = cap[0].charAt(0) === '!';
        if ((isImage || !inLinkState) && !this.linkTextSwallowsBracket(cap, rest)) {
          const link = this.makeReflink(cap, isImage);
          if (link) {
            rest = rest.slice(cap[0].length);
            tokens.push(link);
            continue;
          }
          // The reference is undefined: only the opening bracket is
          // literal text, and parsing continues from after it, so an
          // inner inline link inside [text] still forms (e.g.
          // [a [b](c)][d] -> [a <a>b</a>][d]) while [text] itself
          // never becomes a shortcut link (the [ was already consumed).
          const rawRef = cap[2] ? cap[2] : cap[1];
          if (!this.links[normalizeLabel(rawRef.replace(/\\([\\\[\]])/g, '$1'))]) {
            const openLen = isImage ? 2 : 1;
            const openRaw = rest.slice(0, openLen);
            rest = rest.slice(openLen);
            pushText(openRaw, inRawBlockState ? openRaw : escape(openRaw));
            continue;
          }
        }
      }
      // Shortcut reference link / image: [text] or [text][].
      if (!noLinks && (cap = INLINE_NOLINK.exec(rest))) {
        const isImage = cap[0].charAt(0) === '!';
        if ((isImage || !inLinkState) && !this.linkTextSwallowsBracket(cap, rest)) {
          const link = this.makeNolink(cap, isImage);
          if (link) {
            rest = rest.slice(cap[0].length);
            tokens.push(link);
            continue;
          }
        }
      }
      // Emphasis delimiter run: * or _ (resolved after the pass).
      if (rest.charCodeAt(0) === 42 || rest.charCodeAt(0) === 95) {
        const ch = rest[0];
        let i = 1;
        while (i < rest.length && rest[i] === ch) i++;
        const run = rest.slice(0, i);
        rest = rest.slice(i);
        tokens.push({ type: 'delim', char: ch, length: i, raw: run, canOpen: false, canClose: false });
        continue;
      }
      // Code span. A run of backticks with no matching closing run is
      // literal text: consume the whole run so a shorter suffix of it
      // cannot form a span (e.g. ```foo`` stays literal).
      if (rest.charCodeAt(0) === 96) {
        const cs = this.codeSpan(rest);
        if (cs) {
          rest = rest.slice(cs.raw.length);
          tokens.push(cs.token);
          continue;
        }
        let i = 0;
        while (i < rest.length && rest[i] === '`') i++;
        const run = rest.slice(0, i);
        rest = rest.slice(i);
        pushText(run, escape(run));
        continue;
      }
      // Hard break: two or more spaces + newline, or backslash + newline.
      // The next line's leading whitespace is stripped.
      if ((cap = INLINE_BR.exec(rest))) {
        rest = rest.slice(cap[0].length).replace(/^[ \t]+/, '');
        tokens.push({ type: 'br', raw: cap[0] });
        continue;
      }
      // Strikethrough: ~~...~~ or ~...~ (nesting-aware). A ~~ opener
      // preceded by another ~ is part of a longer ~~~ run, not a del.
      if (rest.charCodeAt(0) === 126) {
        const dbl = rest.charCodeAt(1) === 126;
        if (dbl && prevChar() === '~') { /* fall through to text */ }
        else {
        const close = findDelClose(rest, dbl);
        if (close !== -1) {
          const raw = rest.slice(0, close);
          const inner = rest.slice(dbl ? 2 : 1, close - (dbl ? 2 : 1));
          rest = rest.slice(close);
          tokens.push({ type: 'del', raw, tokens: this.inlineTokens(inner, inLinkState, inRawBlockState) });
          continue;
        }
        }
      }
      // GFM extended autolink: www., http(s)://, email. Blocked inside links
      // and while an earlier inline <a> is still open.
      if (!inLinkState && !this.htmlAOpen && (cap = INLINE_URL.exec(rest))) {
        const prev = prevChar();
        if (!prev || !/[a-zA-Z0-9]/.test(prev)) {
          // An email followed by - or _ is not an email at all (the
          // domain cannot end with those), so no link forms. But when
          // the _ is a closing emphasis delimiter (a _ run that can
          // open is already open in this inline run), the email does
          // link. A _ between two word chars is intra-word and cannot
          // open, so it does not count.
          const nextCh = rest.charAt(cap[0].length);
          let underscoreCloses = false;
          if (nextCh === '_') {
            const isWord = (c) => c !== '' && /[A-Za-z0-9_]/.test(c);
            for (let k = 0; k < tokens.length; k++) {
              const t = tokens[k];
              if (t.type !== 'delim' || t.char !== '_') continue;
              const prevC = k > 0 ? (tokens[k - 1].raw || '').slice(-1) : '';
              let nextC = '';
              if (k + 1 < tokens.length) nextC = (tokens[k + 1].raw || '').charAt(0);
              else nextC = rest.charAt(0);
              if (!(isWord(prevC) && isWord(nextC))) { underscoreCloses = true; break; }
            }
          }
          if (!((cap[2] !== undefined || cap[3] !== undefined) && ((nextCh === '-') || (nextCh === '_' && !underscoreCloses)))) {
            const url = this.gfmUrl(cap);
            if (url) {
              rest = rest.slice(url.raw.length);
              tokens.push(url.token);
              continue;
            }
          }
        }
      }
      // Plain text up to the next special character.
      if ((cap = INLINE_TEXT.exec(rest))) {
        rest = rest.slice(cap[0].length);
        pushText(cap[0], inRawBlockState ? cap[0] : escape(decodeNumericRefs(cap[0])));
        continue;
      }
      // Safety net: consume one character so the loop always terminates.
      pushText(rest[0], inRawBlockState ? rest[0] : escape(rest[0]));
      rest = rest.slice(1);
    }
    return resolveEmphasis(tokens);
  }

  // A code span starting at `rest` (which begins with a backtick).
  // Closed by a run of exactly the same number of backticks.
  codeSpan(rest) {
    let i = 0;
    while (i < rest.length && rest[i] === '`') i++;
    const n = i;
    let j = n;
    let closeIdx = -1;
    while (j < rest.length) {
      if (rest[j] === '`') {
        let k = j;
        while (k < rest.length && rest[k] === '`') k++;
        if (k - j === n) { closeIdx = j; break; }
        j = k;
      } else j++;
    }
    if (closeIdx < 0) return null;
    let content = rest.slice(n, closeIdx);
    content = content.replace(/\n/g, ' ');
    if (content.length > 0 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
      content = content.slice(1, -1);
    }
    const raw = rest.slice(0, closeIdx + n);
    return { raw, token: { type: 'codespan', raw, text: escape(content, true) } };
  }

  // GFM extended autolink starting at the INLINE_URL match.
  gfmUrl(cap) {
    const raw0 = cap[0];
    const raw = backpedalUrl(raw0);
    if (raw.length === 0) return null;
    let href;
    if (raw.startsWith('www.')) {
      if (raw.length <= 4) return null;
      href = 'http://' + raw;
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
      const after = raw.indexOf('://') + 3;
      if (after >= raw.length) return null;
      href = raw;
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(raw)) {
      href = raw;
    } else {
      href = 'mailto:' + raw;
    }
    const clean = cleanUrl(href);
    if (clean === null) return null;
    // Bare URLs escape & fully (a source &amp; renders &amp;amp;), unlike
    // bracket links which preserve named refs.
    return { raw, token: { type: 'link', raw, href: escape(clean, true), autolink: true, tokens: [{ type: 'text', raw, text: escape(raw, true) }] } };
  }

  // True when a backtick run in a link's text opens a code span whose
  // closing run lies past the ] that would close the link text, so the
  // ] is inside the span and no link forms.
  linkTextSpanPastBracket(cap, rest) {
    const text = cap[1];
    const textStart = cap[0].charAt(0) === '!' ? 2 : 1;
    const bracketPos = textStart + text.length;
    let i = 0;
    while (i < text.length) {
      if (text.charCodeAt(i) !== 96) { i++; continue; }
      const btPos = textStart + i;
      const cs = this.codeSpan(rest.slice(btPos));
      if (!cs) return false;
      if (btPos + cs.raw.length > bracketPos) return true;
      i = btPos + cs.raw.length - textStart;
    }
    return false;
  }

  // True when a < in a link's text opens an HTML tag whose end lies past
  // the ] that would close the link text, so the ] is inside the tag
  // and no link forms.
  linkTextTagPastBracket(cap, rest) {
    const text = cap[1];
    const textStart = cap[0].charAt(0) === '!' ? 2 : 1;
    const bracketPos = textStart + text.length;
    let i = 0;
    while (i < text.length) {
      if (text.charCodeAt(i) !== 60) { i++; continue; }
      const ltPos = textStart + i;
      const m = INLINE_TAG.exec(rest.slice(ltPos));
      if (!m) { i++; continue; }
      if (ltPos + m[0].length > bracketPos) return true;
      i = ltPos + m[0].length - textStart;
    }
    return false;
  }

  // True when a < in a link's text opens an autolink whose end lies past
  // the ] that would close the link text, so the ] is inside the
  // autolink and no link forms.
  linkTextAutolinkPastBracket(cap, rest) {
    const text = cap[1];
    const textStart = cap[0].charAt(0) === '!' ? 2 : 1;
    const bracketPos = textStart + text.length;
    let i = 0;
    while (i < text.length) {
      if (text.charCodeAt(i) !== 60) { i++; continue; }
      const ltPos = textStart + i;
      const m = INLINE_AUTOLINK.exec(rest.slice(ltPos));
      if (!m) { i++; continue; }
      if (ltPos + m[0].length > bracketPos) return true;
      i = ltPos + m[0].length - textStart;
    }
    return false;
  }

  // True when a link's text contains a code span, tag, or autolink that
  // swallows the ] closing the text.
  linkTextSwallowsBracket(cap, rest) {
    return this.linkTextSpanPastBracket(cap, rest)
      || this.linkTextTagPastBracket(cap, rest)
      || this.linkTextAutolinkPastBracket(cap, rest);
  }
  // Returns null when the destination is invalid or the text contains a
  // nested link (which blocks the outer link, but never an image).
  makeLink(cap, isImage) {
    const trimmedUrl = (cap[2] || '').trim();
    if (/^</.test(trimmedUrl) && !/>$/.test(trimmedUrl)) return null;
    let href = trimmedUrl;
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
    const clean = cleanUrl(unescapeBackslash(href));
    if (clean === null) return null;
    let title = null;
    if (cap[3]) {
      const t = cap[3];
      title = unescapeBackslash(t.slice(1, -1));
    }
    const text = cap[1];
    if (!isImage && this.linkTextBlocked(text)) return null;
    if (isImage) {
      // The alt text renders the link text with nested links allowed,
      // so a link inside it contributes only its text to the alt.
      const altTokens = this.inlineTokens(text, false, false);
      return { type: 'image', raw: cap[0], href: clean, title, text, tokens: altTokens };
    }
    return { type: 'link', raw: cap[0], href: clean, title, tokens: this.inlineTokens(text, true, false) };
  }

  // Build a reference link/image token from an INLINE_REFLINK match.
  makeReflink(cap, isImage) {
    const rawRef = cap[2] ? cap[2] : cap[1];
    // The reference label is looked up with only bracket escapes
    // unescaped (\[ -> [, \] -> ]); other escapes are kept as written,
    // so [foo\!] does not match a [foo!] definition but [ref\[] does
    // match a [ref\[] definition.
    const ref = normalizeLabel(rawRef.replace(/\\([\\\[\]])/g, '$1'));
    const def = this.links[ref];
    if (!def) return null;
    const text = cap[1];
    if (!isImage && this.linkTextBlocked(text)) return null;
    if (isImage) {
      const altTokens = this.inlineTokens(text, false, false);
      return { type: 'image', raw: cap[0], href: def.href, title: def.title, text, tokens: altTokens };
    }
    return { type: 'link', raw: cap[0], href: def.href, title: def.title, tokens: this.inlineTokens(text, true, false) };
  }

  // Build a shortcut reference link/image token from an INLINE_NOLINK match.
  makeNolink(cap, isImage) {
    // Shortcut labels are looked up with only bracket escapes unescaped.
    const ref = normalizeLabel(cap[1].replace(/\\([\\\[\]])/g, '$1'));
    const def = this.links[ref];
    if (!def) return null;
    const text = cap[1];
    if (!isImage && this.linkTextBlocked(text)) return null;
    if (isImage) {
      const altTokens = this.inlineTokens(text, false, false);
      return { type: 'image', raw: cap[0], href: def.href, title: def.title, text, tokens: altTokens };
    }
    return { type: 'link', raw: cap[0], href: def.href, title: def.title, tokens: this.inlineTokens(text, true, false) };
  }

  // True when the link text contains a nested link (inline, reflink or
  // shortcut). Code spans shield their content; escaped brackets count
  // once unescaped. Autolinks and images never block.
  linkTextBlocked(text) {
    const unescaped = unescapeBrackets(text);
    const tokens = this.inlineTokens(unescaped, false, false);
    return inlineHasLink(tokens);
  }
}

// ---- Inline helpers (module level) ----
function isPunct(ch) {
  return ch !== '' && /[\p{P}\p{S}]/u.test(ch);
}
function isWs(ch) {
  return ch === '' || /\s/.test(ch);
}
function lastRawChar(token) {
  const r = token.raw || '';
  return r.length > 0 ? r[r.length - 1] : '';
}
function firstRawChar(token) {
  const r = token.raw || '';
  return r.length > 0 ? r[0] : '';
}

// Unescape only \[, \] and \\ (the escapes that affect bracket matching).
function unescapeBrackets(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      const n = text[i + 1];
      if (n === '[' || n === ']' || n === '\\') { out += n; i++; continue; }
    }
    out += c;
  }
  return out;
}

// True when a token tree holds a link that is not an autolink or an image.
function inlineHasLink(tokens) {
  for (const t of tokens) {
    if (t.type === 'link' && !t.autolink) return true;
    if (t.tokens && inlineHasLink(t.tokens)) return true;
  }
  return false;
}

// Trim trailing punctuation and unbalanced ')' from a GFM autolink.
function backpedalUrl(raw) {
  let s = raw;
  for (;;) {
    let changed = false;
    if (s.endsWith(')')) {
      // Only the trailing ) itself matters: it is kept when some (
      // before it is still open at that point (a mid-URL unmatched )
      // does not force trimming a matched trailing one).
      let depth = 0;
      let matched = false;
      for (let k = 0; k < s.length; k++) {
        if (s[k] === '(') depth++;
        else if (s[k] === ')') {
          if (k === s.length - 1) matched = depth > 0;
          if (depth > 0) depth--;
        }
      }
      if (!matched) { s = s.slice(0, -1); changed = true; }
    }
    if (!changed) {
      const m = /[?!.,:;*_~]$/.exec(s);
      if (m) {
        // A trailing &...; entity is not part of the URL at all.
        if (m[0] === ';' && /&[a-zA-Z0-9#]+;$/.test(s)) {
          s = s.replace(/&[a-zA-Z0-9#]+;$/, '');
          changed = true;
        } else {
          s = s.slice(0, -1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return s;
}

// CommonMark delimiter-stack emphasis resolution over a flat token list.
// Delimiter tokens ('delim') are replaced by em/strong nodes; leftovers
// stay literal.
function resolveEmphasis(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'delim') continue;
    const prev = i > 0 ? lastRawChar(tokens[i - 1]) : '';
    const next = i < tokens.length - 1 ? firstRawChar(tokens[i + 1]) : '';
    const leftFlanking = !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
    const rightFlanking = !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
    if (t.char === '*') {
      t.canOpen = leftFlanking;
      t.canClose = rightFlanking;
    } else {
      t.canOpen = leftFlanking && (!rightFlanking || isPunct(prev));
      t.canClose = rightFlanking && (!leftFlanking || isPunct(next));
    }
  }
  const delims = tokens.filter((t) => t.type === 'delim');
  const stack = [];
  for (const d of delims) {
    if (d.length === 0) continue;
    if (!d.canClose) {
      if (d.canOpen) stack.push(d);
      continue;
    }
    while (d.length > 0) {
      let oi = -1;
      // A lone * closer that directly follows an inner em/strong
      // node (only alphanumerics between that node and this closer)
      // does not pair with a ** opener (e.g. **a *b*c* d** forms the
      // outer strong instead). It also does not pair with a * opener
      // when the inner node is a strong preceded by whitespace (e.g.
      // *a **b**c* stays literal). When the inner node is glued to
      // preceding text (*foo**bar**baz*), or is an em (*state *types*
      // updates* it*), the outer emphasis does form.
      const diIdx0 = tokens.indexOf(d);
      let blockedDouble = false;
      let blockedSingle = false;
      if (d.char === '*' && d.length === 1 && diIdx0 > 1) {
        const prevTok = tokens[diIdx0 - 1];
        const prevPrev = tokens[diIdx0 - 2];
        if (prevTok && prevTok.type === 'text' && /^[A-Za-z0-9]+$/.test(prevTok.raw || '')
          && prevPrev && (prevPrev.type === 'em' || prevPrev.type === 'strong')) {
          blockedDouble = true;
          if (prevPrev.type === 'strong') {
            const beforeNode = diIdx0 > 2 ? tokens[diIdx0 - 3] : null;
            const beforeIsWs = !beforeNode
              || (beforeNode.type === 'text' && /[\s]$/.test(beforeNode.raw || ''))
              || (beforeNode.type !== 'text' && beforeNode.type !== 'em' && beforeNode.type !== 'strong');
            if (beforeIsWs) blockedSingle = true;
          }
        }
      }
      for (let i = stack.length - 1; i >= 0; i--) {
        const o = stack[i];
        if (o.char !== d.char || o.length === 0) continue;
        if (o.length >= 2 ? blockedDouble : blockedSingle) {
          // A * opener blocked by a lone closer after a strong stays
          // blocked: it can no longer pair with a later closer (the
          // outer ** must pair with the outer ** instead). Drop it.
          if (blockedSingle && o.length === 1) stack.splice(i, 1);
          continue;
        }
        // Rule of 3: skip when the sum is a multiple of 3, unless both
        // runs are themselves multiples of 3.
        if ((o.canClose || d.canOpen) && ((o.length + d.length) % 3 === 0) && !(o.length % 3 === 0 && d.length % 3 === 0)) continue;
        oi = i;
        break;
      }
      if (oi === -1) break;
      const o = stack[oi];
      const use = o.length >= 2 && d.length >= 2 ? 2 : 1;
      const oiIdx = tokens.indexOf(o);
      const diIdx = tokens.indexOf(d);
      if (oiIdx < 0 || diIdx < 0 || oiIdx >= diIdx) break;
      const children = tokens.slice(oiIdx + 1, diIdx);
      const node = { type: use === 2 ? 'strong' : 'em', raw: '', tokens: children };
      o.length -= use;
      d.length -= use;
      // Delimiters now inside the emphasis node can no longer match
      // closers outside it.
      for (let si = stack.length - 1; si >= 0; si--) {
        if (children.includes(stack[si])) stack.splice(si, 1);
      }
      const replacement = [];
      if (o.length > 0) {
        o.raw = o.char.repeat(o.length);
        replacement.push(o);
      } else {
        stack.splice(oi, 1);
      }
      replacement.push(node);
      if (d.length > 0) {
        d.raw = d.char.repeat(d.length);
        replacement.push(d);
      }
      tokens.splice(oiIdx, diIdx - oiIdx + 1, ...replacement);
      if (d.length === 0) break;
    }
    // A leftover closer that could not pair is literal text. When the
    // strong node it just closed contains an inner em, the leftover is
    // the leading part of the closer run and belongs inside that node
    // (e.g. the * in **by command *tool*one*** stays inside the
    // strong). With plain-text content (**foo***) or an em node it
    // stays outside.
    if (d.length > 0) {
      const di = tokens.indexOf(d);
      if (di > 0 && tokens[di - 1].type === 'strong'
        && tokens[di - 1].tokens.some((t) => t.type === 'em')) {
        tokens[di - 1].tokens.push(d);
        tokens.splice(di, 1);
        d.length = 0;
      }
    }
    if (d.length > 0 && d.canOpen && !stack.includes(d)) stack.push(d);
  }
  return tokens;
}

// ---- Renderer ----
class Parser {
  parse(tokens) {
    return this.parseTokens(tokens, true);
  }

  parseTokens(tokens, top) {
    let out = '';
    for (const t of tokens) out += this.parseToken(t, top);
    return out;
  }

  parseToken(token, top) {
    switch (token.type) {
      case 'space':
        return '';
      case 'paragraph': {
        const inner = this.parseInline(token.tokens);
        return top ? '<p>' + inner + '</p>\n' : inner;
      }
      case 'heading':
        return '<h' + token.depth + '>' + this.parseInline(token.tokens) + '</h' + token.depth + '>\n';
      case 'code': {
        const lang = token.lang ? ' class="language-' + escape(token.lang) + '"' : '';
        return '<pre><code' + lang + '>' + escape(token.text, true) + '</code></pre>\n';
      }
      case 'blockquote':
        return '<blockquote>\n' + this.parseTokens(token.tokens, true) + '</blockquote>\n';
      case 'list': {
        const tag = token.ordered ? 'ol' : 'ul';
        const start = token.ordered && token.start !== 1 ? ' start="' + token.start + '"' : '';
        let body = '';
        for (const item of token.items) body += this.listItem(item, token.loose);
        return '<' + tag + start + '>\n' + body + '</' + tag + '>\n';
      }
      case 'html':
        return token.text;
      case 'hr':
        return '<hr>\n';
      case 'table': {
        let out = '<table>\n<thead>\n<tr>\n';
        for (let i = 0; i < token.header.length; i++) {
          const align = token.align[i];
          out += '<th' + (align ? ' align="' + align + '"' : '') + '>' + this.parseInline(token.header[i].tokens) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (token.rows.length > 0) {
          out += '<tbody>';
          for (const row of token.rows) {
            out += '<tr>\n';
            for (let i = 0; i < row.length; i++) {
              const align = token.align[i];
              out += '<td' + (align ? ' align="' + align + '"' : '') + '>' + this.parseInline(row[i].tokens) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        return out;
      }
      default:
        return '';
    }
  }

  listItem(item, loose) {
    const checkbox = item.task
      ? '<input' + (item.checked ? ' checked=""' : '') + ' disabled="" type="checkbox">'
      : '';
    if (checkbox && loose && item.tokens.length > 0 && item.tokens[0].type === 'paragraph') {
      item.tokens[0].tokens.unshift({ type: 'html', raw: checkbox + ' ', text: checkbox + ' ' });
      return '<li>' + this.parseTokens(item.tokens, true) + '</li>\n';
    }
    let body = this.parseTokens(item.tokens, loose);
    if (checkbox) body = checkbox + ' ' + body;
    return '<li>' + body + '</li>\n';
  }

  parseInline(tokens) {
    let out = '';
    for (const t of tokens) {
      switch (t.type) {
        case 'text':
          out += t.text;
          break;
        case 'html':
          out += t.text;
          break;
        case 'strong':
          out += '<strong>' + this.parseInline(t.tokens) + '</strong>';
          break;
        case 'em':
          out += '<em>' + this.parseInline(t.tokens) + '</em>';
          break;
        case 'codespan':
          out += '<code>' + t.text + '</code>';
          break;
        case 'br':
          out += '<br>';
          break;
        case 'del':
          out += '<del>' + this.parseInline(t.tokens) + '</del>';
          break;
        case 'link': {
          const title = t.title ? ' title="' + escape(t.title) + '"' : '';
          out += '<a href="' + escape(t.href) + '"' + title + '>' + this.parseInline(t.tokens) + '</a>';
          break;
        }
        case 'image': {
          const title = t.title ? ' title="' + escape(t.title) + '"' : '';
          out += '<img src="' + escape(t.href) + '" alt="' + this.altText(t.tokens) + '"' + title + '>';
          break;
        }
        case 'delim':
          out += t.raw;
          break;
        default:
          break;
      }
    }
    return out;
  }

  // Alt text: the text content of the inline tokens. A nested image
  // contributes its own alt text (rather than having its whole <img>
  // tag stripped away); markup contributes only its children.
  altText(tokens) {
    let out = '';
    for (const t of tokens) {
      switch (t.type) {
        case 'text':
        case 'codespan':
          out += t.text;
          break;
        case 'strong':
        case 'em':
        case 'del':
        case 'link':
        case 'image':
          out += this.altText(t.tokens);
          break;
        case 'delim':
          out += t.raw;
          break;
        default:
          break;
      }
    }
    return out;
  }
}

// Parse markdown to HTML, exactly as marked 18.1.3 with default options.
export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return new Parser().parse(tokens);
}

export { escape, unescape };
