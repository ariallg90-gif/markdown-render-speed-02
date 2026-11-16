// parse.js — a fast, dependency-free Markdown renderer whose parse() returns
// exactly the HTML marked 18.1.3 returns with its default options (GFM on,
// breaks off, pedantic off). Written from scratch against the CommonMark 0.31.2
// and GFM 0.29 specs, verified byte-for-byte against marked on the practice set.
//
// Design: a line-based block parser driven by a stack of open containers
// (block quotes, lists, list items), and a single-pass inline scanner with the
// CommonMark delimiter-stack algorithm for emphasis / strikethrough. No
// caching across calls: parse() keeps nothing from an earlier call.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape text for HTML output. A bare & is escaped unless it already starts a
// character reference (&name; or &#...;), which is left alone.
const ESC_RE = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][0-9a-fA-F]{1,6}|\w+);)/g;
function esc(s) {
  return s.replace(ESC_RE, (ch) => (ch === '&' ? '&amp;' : ESC_MAP[ch]));
}

// Escape text for code spans and code blocks: every & is escaped.
const ESC_ALL_RE = /[&<>"']/g;
function escAll(s) {
  return s.replace(ESC_ALL_RE, (ch) => ESC_MAP[ch]);
}

// Decode the character references marked decodes: the five named ones and
// numeric (decimal / hexadecimal) references. Anything else (notably &copy;)
// is left as written. Code point 0, out-of-range values and lone surrogates
// become U+FFFD.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const UNESC_RE = /&(#(?:[xX][0-9a-fA-F]{1,6}|\d{1,7})|amp|lt|gt|quot|#39);/g;
function unescape(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(UNESC_RE, (m, e) => {
    if (e.charCodeAt(0) === 35) {
      const cp = e.charCodeAt(1) === 120 || e.charCodeAt(1) === 88
        ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
      return String.fromCodePoint(cp);
    }
    return NAMED[e];
  });
}

// Text runs are decoded then escaped: &#65; becomes A, &amp; stays &amp;,
// &copy; stays &copy;, a bare & becomes &amp;.
function escText(s) {
  return esc(unescape(s)).replace(/\u0001/g, '&amp;');
}

// Clean a link destination the way marked does: percent-encode it, but keep
// literal % signs. Returns null when the destination cannot be encoded.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
const UNICODE_PUNCT_RE = /\p{P}|\p{S}/u;
const UNICODE_WS_RE = /\s/;

function isSpaceCh(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\v' || ch === '\r';
  return UNICODE_WS_RE.test(ch);
}

// Unicode punctuation (CommonMark's definition): ASCII punctuation plus any
// character in Unicode general categories P (punctuation) or S (symbol).
function isPunctCh(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.has(ch);
  return UNICODE_PUNCT_RE.test(ch);
}

// Normalize a link label: collapse every run of whitespace to one space,
// trim, lowercase (with Unicode case folding: ß/ẞ fold to "ss").
function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st')
    .replace(/ς/g, 'σ');
}

// Columns of indentation of the leading whitespace of a line, tabs advancing
// to the next multiple of 4. Returns [indent, indexOfFirstNonWhitespace].
function leadOf(line) {
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return [col, i];
}

// Is the line blank (only spaces/tabs)?
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Remove `cols` columns of indentation from the start of a line. A tab that
// is only partly consumed leaves spaces for its remaining columns.
function stripCols(line, cols) {
  if (cols <= 0) return line;
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      // A tab that starts inside the indent region is removed entirely
      // (marked's fenced-code rule: no partial-tab spaces are left);
      // the column still advances to the tab stop for further stripping.
      col = col + 4 - (col % 4); i++;
    } else break;
  }
  return line.slice(i);
}

// ---------- Inline parsing ----------

const T_TEXT = 0, T_CODE = 1, T_BR = 2, T_HTML = 3, T_LINK = 4, T_IMG = 5,
  T_DELIM = 6, T_AUTO = 7, T_WRAP = 8;

// Characters that end a plain-text run.
const SPECIAL_RE = /[\\`\n*_~\[\]!<]/g;

// ASCII punctuation, for backslash escapes.
const ESCAPABLE_RE = /\\([!-\/:-@\[-`{-~])/g;
// Placeholder for an escaped '&' (from \&): unescape must not treat a
// following word; as an entity, and esc must render it as &amp;.
const AMP_ESC = '\u0001';
function resolveEscapes(raw) {
  if (raw.indexOf('\\') < 0) return raw;
  return raw.replace(ESCAPABLE_RE, (m, p) => p === '&' ? AMP_ESC : p);
}

// ---- autolinks (GFM extended) ----

const TRAIL_PUNCT = new Set(['?', '!', '.', ',', ':', ';', '*', '_', '~']);

// Trim trailing punctuation and unbalanced closing parens from an autolink.
// Marked's autolink backpedal: trims trailing punctuation / unbalanced ')',
// and a trailing named entity (&word;). Applied until the string is stable.
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimAuto(s) {
  let prev;
  do {
    prev = s;
    const m = BACKPEDAL_RE.exec(s);
    s = m ? m[0] : '';
  } while (s !== prev);
  return s.length;
}

function isDomainChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9') || c === '-' || c === '.';
}

// Try to match an extended autolink at `raw` starting at index `i` (the
// first character of the candidate). `prevCh` is the character before it in
// the source ('' at the start). Returns {end, href} or null.
// True when the backslash at src[i] is the last character of an extended
// autolink URL (scheme://... or www....): scan back over URL characters to
// the word start and check for a scheme or www. prefix.
function backslashInUrl(src, i) {
  let s = i - 1;
  while (s >= 0) {
    const c = src.charCodeAt(s);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 45 || c === 46 || c === 95 || c === 126 || c === 58 || c === 47 || c === 63 ||
      c === 35 || c === 91 || c === 93 || c === 64 || c === 33 || c === 36 || c === 38 ||
      c === 39 || c === 40 || c === 41 || c === 42 || c === 43 || c === 44 || c === 59 ||
      c === 61 || c === 37 || c === 92;
    if (!ok) break;
    s--;
  }
  s++;
  const word = src.slice(s, i + 1).toLowerCase();
  return word.startsWith('http://') || word.startsWith('https://') ||
    word.startsWith('ftp://') || word.startsWith('www.');
}

function matchExtendedAuto(raw, i, prevCh) {
  // Must not be preceded by a word character or '/'.
  if (prevCh) {
    const pc = prevCh.charCodeAt(0);
    if ((pc >= 48 && pc <= 57) || (pc >= 65 && pc <= 90) || (pc >= 97 && pc <= 122) ||
      pc === 95 || pc === 47) return null;
  }
  const n = raw.length;
  let kind = 0; // 1 www, 2 scheme
  let start = i;
  if (raw.startsWith('www.', i)) {
    kind = 1;
  } else {
    // Scheme: only http, https, ftp (case-insensitive).
    const c0 = raw.charCodeAt(i);
    if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
      let j = i + 1;
      while (j < n) {
        const c = raw.charCodeAt(j);
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
          c === 43 || c === 45 || c === 46) j++;
        else break;
      }
      if (raw.startsWith('://', j)) {
        const scheme = raw.slice(i, j).toLowerCase();
        if (scheme === 'http' || scheme === 'https' || scheme === 'ftp') kind = 2;
      }
    }
  }
  if (kind === 1 || kind === 2) {
    // Consume until whitespace or '<', then trim with the backpedal.
    let j = kind === 1 ? i + 4 : raw.indexOf('://', i) + 3;
    // The domain right after www. / :// must start with [A-Za-z0-9-].
    if (j >= n || !isDomainChar(raw[j])) return null;
    let k = j;
    while (k < n) {
      const c = raw.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c === 60) break;
      k++;
    }
    const end = trimAuto(raw.slice(i, k)) + i;
    if (end <= (kind === 1 ? i + 4 : j)) return null;
    const text = raw.slice(i, end);
    return { end, href: kind === 1 ? 'http://' + text : text };
  }
  return null;
}

// Match an email autolink whose '@' is at index `at` in raw. `start` is the
// earliest index the local part may begin at (the start of the current text
// run). Returns {start, end, href} or null.
function matchEmail(raw, at, start) {
  const n = raw.length;
  // Local part: scan back from at-1 over allowed characters.
  // May start/end with '.', may be just '.'.
  let s = at - 1;
  while (s >= start) {
    const c = raw.charCodeAt(s);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
      c === 39 || c === 42 || c === 43 || c === 45 || c === 47 || c === 61 ||
      c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 ||
      c === 125 || c === 126) s--;
    else break;
  }
  s++;
  if (s >= at) return null;
  // The local part must be preceded by a non-word, non-'/' character (if any).
  if (s > start) {
    const pc = raw.charCodeAt(s - 1);
    if ((pc >= 48 && pc <= 57) || (pc >= 65 && pc <= 90) || (pc >= 97 && pc <= 122) ||
      pc === 95 || pc === 47) return null;
    // The first character of the local part must not be backslash-escaped.
    if (pc === 92) return null;
  }
  // Domain: labels of [A-Za-z0-9_-]+ joined by '.', at least one dot, no empty
  // labels, last char must be alphanumeric. A trailing '.' is trimmed (the
  // email ends before it); a trailing '-' or '_' invalidates the email.
  // A '.' that would start an empty label ends the domain there (the email
  // is what precedes it; e.g. a@b.c..d -> a@b.c, a@b..c -> no email).
  let j = at + 1;
  let ok = true;
  let labelStart = j;
  while (j < n) {
    const c = raw.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) { j++; continue; }
    if (c === 46) {
      if (j === labelStart) break;
      labelStart = j + 1; j++; continue;
    }
    break;
  }
  if (!ok) return null;
  // Trim trailing '.'s (e.g. "a.b-c_d@a.b." -> email "a.b-c_d@a.b").
  while (j > at + 1 && raw.charCodeAt(j - 1) === 46) j--;
  if (j <= at + 1) return null;
  // The domain must contain a '.' before the end, with a non-empty label
  // after it; the last character must be alphanumeric.
  let dot = -1;
  for (let p = at + 1; p < j; p++) if (raw.charCodeAt(p) === 46) dot = p;
  if (dot < 0 || dot === j - 1) return null;
  const lastCh = raw.charCodeAt(j - 1);
  if (!((lastCh >= 48 && lastCh <= 57) || (lastCh >= 65 && lastCh <= 90) || (lastCh >= 97 && lastCh <= 122))) return null;
  const text = raw.slice(s, j);
  return { start: s, end: j, href: 'mailto:' + text };
}

// Scan a raw text run for extended autolinks and split it into items.
// `runStart` is the source index of the run's first character (for the
// preceding-character check of a match at the run's start).
function splitTextRun(items, raw, runStart, src, allowAuto) {
  if (allowAuto === false) {
    if (raw) items.push({ t: T_TEXT, s: resolveEscapes(raw) });
    return;
  }
  const n = raw.length;
  let pos = 0; // start of un-pushed text
  let scan = 0; // where to search for the next candidate
  while (scan < n) {
    // Find the next autolink candidate: 'www.', '://', or '@'.
    let cand = -1, candKind = 0;
    for (let k = scan; k < n; k++) {
      const c = raw.charCodeAt(k);
      if (c === 119 && raw.startsWith('www.', k)) { cand = k; candKind = 1; break; }
      if (c === 64) { cand = k; candKind = 3; break; }
      if (c === 58 && raw.startsWith('://', k)) {
        // A scheme must start 1-31 chars before; find its start.
        let s = k - 1;
        while (s >= scan) {
          const sc = raw.charCodeAt(s);
          if ((sc >= 48 && sc <= 57) || (sc >= 65 && sc <= 90) || (sc >= 97 && sc <= 122) ||
            sc === 43 || sc === 45 || sc === 46) s--;
          else break;
        }
        s++;
        const cc = raw.charCodeAt(s);
        if (k - s >= 2 && k - s <= 32 && ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122))) {
          cand = s; candKind = 2; break;
        }
      }
    }
    if (cand < 0) break;
    let m = null;
    if (candKind === 3) {
      m = matchEmail(raw, cand, pos);
      if (m) {
        // Scheme autolink: lowercase mailto: or xmpp: immediately before
        // the email (preceded by start/whitespace/*_~([ ). For xmpp, one
        // path segment (/[A-Za-z0-9@.]+) may follow the email.
        const es = m.start;
        let schemeLen = 0;
        if (es >= 7 && raw.slice(es - 7, es) === 'mailto:') schemeLen = 7;
        else if (es >= 5 && raw.slice(es - 5, es) === 'xmpp:') schemeLen = 5;
        if (schemeLen) {
          const bIdx = es - schemeLen;
          const prevCh = bIdx === 0 ? (runStart > 0 ? src[runStart - 1] : '') : raw[bIdx - 1];
          if (prevCh === '' || isSpaceCh(prevCh) || '*_~(['.includes(prevCh)) {
            let end = m.end;
            if (schemeLen === 5 && raw[end] === '/') {
              let p = end + 1;
              while (p < n) {
                const c = raw.charCodeAt(p);
                if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 64 || c === 46) p++;
                else break;
              }
              if (p > end + 1) end = p;
            }
            const full = raw.slice(bIdx, end);
            const tl = trimAuto(full);
            end = bIdx + tl;
            if (end > bIdx + schemeLen) {
              m = { start: bIdx, end: end, href: raw.slice(bIdx, end) };
            }
          }
        }
      }
    } else {
      const prevCh = cand === 0
        ? (runStart > 0 ? src[runStart - 1] : '')
        : raw[cand - 1];
      m = matchExtendedAuto(raw, cand, prevCh);
    }
    if (!m) {
      // No autolink here; keep scanning past this candidate (text is kept).
      scan = cand + 1;
      continue;
    }
    const start = m.start !== undefined ? m.start : cand;
    if (start > pos) items.push({ t: T_TEXT, s: resolveEscapes(raw.slice(pos, start)) });
    items.push({ t: T_AUTO, href: m.href, s: raw.slice(start, m.end) });
    pos = m.end;
    scan = m.end;
  }
  if (pos < n) items.push({ t: T_TEXT, s: resolveEscapes(raw.slice(pos)) });
}

// ---- inline scanner ----

// Parse a code span starting at src[i] ('`'). Returns {end, content} or null.
// `limit` (optional, >= 0) is the ']' closing the enclosing link text and
// `limitLine` (optional, >= 0) the next newline after the opener: a closer
// past `limit` is accepted only while it stays before `limitLine` (same
// line as the opener); a closer past both is rejected.
function parseCodeSpan(src, i, limit, limitLine) {
  const n = src.length;
  let j = i;
  while (j < n && src[j] === '`') j++;
  const run = j - i;
  let k = j;
  for (;;) {
    const b = src.indexOf('`', k);
    if (b < 0) return null;
    if (limit >= 0 && b >= limit && limitLine >= 0 && b >= limitLine) return null;
    let e = b;
    while (e < n && src[e] === '`') e++;
    if (e - b === run) {
      let content = src.slice(j, b).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' &&
        /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      return { end: e, content };
    }
    k = e;
  }
}

// Parse raw HTML starting at src[i] ('<'): comment, processing instruction,
// declaration, CDATA, or an open/close tag. Returns the end index or -1.
function parseHtmlTag(src, i) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    // <!--> and <!---> are complete (abruptly closed) comments.
    if (src[i + 4] === '>') return i + 5;
    if (src.startsWith('->', i + 4)) return i + 7;
    const e = src.indexOf('-->', i + 4);
    return e < 0 ? -1 : e + 3;
  }
  if (src.startsWith('<?', i)) {
    const e = src.indexOf('?>', i + 2);
    return e < 0 ? -1 : e + 2;
  }
  if (src.startsWith('<!', i)) {
    if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9);
      return e < 0 ? -1 : e + 3;
    }
    const c = src.charCodeAt(i + 2);
    if (c >= 65 && c <= 90) {
      const e = src.indexOf('>', i + 2);
      return e < 0 ? -1 : e + 1;
    }
    return -1;
  }
  let j = i + 1;
  let closing = false;
  if (src[j] === '/') { closing = true; j++; }
  const c0 = src.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) j++;
    else break;
  }
  if (closing) {
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
    return src[j] === '>' ? j + 1 : -1;
  }
  // Attributes: each attribute must be preceded by whitespace.
  for (;;) {
    const wsStart = j;
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
    if (j >= n) return -1;
    if (src[j] === '>') return j + 1;
    if (src[j] === '/' && src[j + 1] === '>') return j + 2;
    if (j === wsStart) return -1; // no whitespace before an attribute
    // Attribute name.
    const ac = src.charCodeAt(j);
    if (!((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac === 95 || ac === 58)) return -1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        c === 95 || c === 58 || c === 45 || c === 46) j++;
      else break;
    }
    // Peek for '=' without consuming the whitespace (a boolean attribute
    // leaves the whitespace for the next attribute's separator check).
    let k = j;
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
    if (src[k] === '=') {
      j = k + 1;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
      if (src[j] === '"' || src[j] === "'") {
        const q = src[j];
        j++;
        const e = src.indexOf(q, j);
        if (e < 0) return -1;
        j = e + 1;
      } else {
        const vs = j;
        while (j < n) {
          const c = src.charCodeAt(j);
          if (c === 32 || c === 9 || c === 10 || c === 34 || c === 39 || c === 61 ||
            c === 60 || c === 62 || c === 96) break;
          j++;
        }
        if (j === vs) return -1;
      }
    }
  }
}

// Parse an <...> autolink starting at src[i]. Returns {end, href, text} or null.
function parseAutolink(src, i) {
  const n = src.length;
  const e = src.indexOf('>', i + 1);
  if (e < 0) return null;
  const inner = src.slice(i + 1, e);
  if (inner.length === 0) return null;
  for (let p = 0; p < inner.length; p++) {
    const c = inner.charCodeAt(p);
    if (c === 32 || c === 60 || c === 10 || c < 32) return null;
  }
  // Scheme: letter followed by 1-31 alphanumerics/+/-/. then ':'.
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.exec(inner);
  if (m) return { end: e + 1, href: inner, text: inner };
  // Email.
  if (/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(inner)) {
    return { end: e + 1, href: 'mailto:' + inner, text: inner };
  }
  return null;
}

// Skip spaces, tabs and newlines starting at i. Returns the new index.
function skipWs(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Parse a link destination starting at src[i] (after '(' or after skipped
// whitespace). Returns {dest, end} or null.
function parseDest(src, i) {
  const n = src.length;
  if (src[i] === '<') {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = src[j];
      if (c === '\n') return null;
      if (c === '>') return { dest: out, end: j + 1 };
      if (c === '<') return null;
      if (c === '\\' && j + 1 < n && isPunctCh(src[j + 1])) { out += src[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  let j = i, depth = 0, out = '';
  while (j < n) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n') break;
    if (c === '\\' && j + 1 < n && isPunctCh(src[j + 1])) { out += src[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    const cc = src.charCodeAt(j);
    if (cc < 32) return null;
    out += c; j++;
  }
  if (out.length === 0) return null;
  return { dest: out, end: j };
}

// Parse a link title starting at src[i]. Returns {title, end} or null.
function parseTitle(src, i) {
  const n = src.length;
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let j = i + 1, out = '';
  while (j < n) {
    const c = src[j];
    if (c === '\\' && j + 1 < n && isPunctCh(src[j + 1])) { out += src[j + 1]; j += 2; continue; }
    if (c === close) return { title: out, end: j + 1 };
    if (q === '(' && (c === '(' || c === ')')) return null;
    out += c; j++;
  }
  return null;
}

// Try to form a link/image after the ']' at src[i-1] (i is the index just
// after ']'). `linkText` is the raw source of the link text. Returns
// {href, title, end} or null.
function tryLink(src, i, linkText, defs) {
  const n = src.length;
  if (src[i] === '(') {
    // Inline link. An empty destination is valid: [link]() -> href="".
    // If the inline form is invalid, fall through to the shortcut
    // reference (e.g. [foo](not a link) with a [foo] definition).
    let j = skipWs(src, i + 1);
    let d = null;
    if (src[j] === ')') {
      // Empty destination: [link]() -> href="".
      d = { dest: '', end: j };
    } else {
      d = parseDest(src, j);
    }
    if (d) {
      j = skipWs(src, d.end);
      let title = null;
      if (src[j] === '"' || src[j] === "'" || src[j] === '(') {
        const t = parseTitle(src, j);
        if (t) {
          title = t.title;
          j = skipWs(src, t.end);
        }
      }
      if (src[j] === ')') return { href: d.dest, title, end: j + 1 };
    }
    // Inline form failed: fall through to the shortcut reference.
  }
  if (src[i] === '[') {
    // Full or collapsed reference.
    let j = i + 1, depth = 0;
    while (j < n) {
      const c = src[j];
      if (c === '\\' && j + 1 < n) { j += 2; continue; }
      if (c === '[') depth++;
      if (c === ']') {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    if (j >= n || j - (i + 1) > 999) return null;
    const label = j === i + 1 ? linkText : src.slice(i + 1, j);
    const def = defs.get(normalizeLabel(label));
    if (!def) return null;
    return { href: def.href, title: def.title, end: j + 1 };
  }
  // Shortcut reference.
  const def = defs.get(normalizeLabel(linkText));
  if (!def) return null;
  return { href: def.href, title: def.title, end: i };
}

// Is this character usable inside an email address (local part or domain)?
function isEmailCh(c) {
  if (!c) return false;
  const cc = c.charCodeAt(0);
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) ||
    cc === 46 || cc === 33 || cc === 35 || cc === 36 || cc === 37 || cc === 38 ||
    cc === 39 || cc === 42 || cc === 43 || cc === 45 || cc === 47 || cc === 61 ||
    cc === 63 || cc === 94 || cc === 95 || cc === 96 || cc === 123 || cc === 124 ||
    cc === 125 || cc === 126;
}
// Is the '_' at src[i] part of an email address (so it is text, not an
// emphasis delimiter)? Scan back over email characters for an '@'.
// True when an earlier '_' in this inline source could open an emphasis
// that the '_' at src[i] would close: scan back for the nearest '_'
// run that is left-flanking (a plausible opener). Used to keep a '_' after
// an email domain as an emphasis closer (e.g. '_buffer ... an@x.com_')
// instead of swallowing it as email text, which would also kill the email.
function hasOpenUnderscore(src, i) {
  let k = i - 1;
  while (k >= 0) {
    if (src[k] !== '_') { k--; continue; }
    // Find the full run containing k.
    let s = k;
    while (s > 0 && src[s - 1] === '_') s--;
    let e = k;
    while (e < src.length && src[e] === '_') e++;
    const prev = s > 0 ? src[s - 1] : '';
    const nextCh = e < src.length ? src[e] : '';
    const [left, right] = flank(prev, nextCh);
    if (left && (!right || isPunctCh(prev))) return true;
    k = s - 1;
  }
  return false;
}

function underscoreInEmail(src, i) {
  let k = i - 1;
  if (k < 0 || !isEmailCh(src[k])) return false;
  while (k >= 0 && isEmailCh(src[k])) k--;
  return k >= 0 && src[k] === '@';
}

// Flanking for a delimiter run: prev is the char before the run, next the
// char after it ('' at the string's ends).
function flank(prev, next) {
  const prevWs = prev === '' || isSpaceCh(prev);
  const nextWs = next === '' || isSpaceCh(next);
  const prevPunct = prev !== '' && isPunctCh(prev);
  const nextPunct = next !== '' && isPunctCh(next);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return [left, right];
}

// The inline scanner. Returns the head of a doubly-linked list of items.
function scanInline(src, defs) {
  const n = src.length;
  let head = null, tail = null;
  const push = (it) => {
    it.next = null; it.prev = tail;
    if (tail) tail.next = it; else head = it;
    tail = it;
    return it;
  };
  const delims = [];
  const brackets = [];
  // Current text run, as raw source ranges.
  let segs = null; // array of [start, end]
  let runStart = 0;
  const flushText = () => {
    if (!segs) return;
    let raw = '';
    for (const [a, b] of segs) raw += src.slice(a, b);
    const items = [];
    // Extended autolinks (www / scheme / email) do not form inside link
    // text; <...> autolinks and code spans still do (handled elsewhere).
    splitTextRun(items, raw, runStart, src, brackets.length === 0);
    for (const it of items) push(it);
    segs = null;
  };
  const addSeg = (a, b) => {
    if (!segs) { segs = []; runStart = a; }
    segs.push([a, b]);
  };

  let i = 0;
  while (i < n) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(src);
    const next = m ? m.index : n;
    if (next > i) addSeg(i, next);
    if (!m) break;
    i = next;
    const ch = src[i];
    if (ch === '\\') {
      const nc = src[i + 1];
      if (nc === '\n') {
        // Backslash hard break (only when more content follows) — unless
        // the backslash ends an extended-autolink URL (e.g.
        // https://www.example.com/of.\ ), in which case it belongs to the
        // URL and the newline is a soft break.
        if (!backslashInUrl(src, i)) {
          flushText();
          let rest = false;
          for (let k = i + 2; k < n; k++) {
            if (!isSpaceCh(src[k])) { rest = true; break; }
          }
          if (rest) { push({ t: T_BR }); i += 2; while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; }
          else { addSeg(i, i + 1); i++; }
          continue;
        }
        addSeg(i, i + 1); i++; continue;
      }
      if (nc !== undefined && isPunctCh(nc)) { addSeg(i, i + 2); i += 2; continue; }
      addSeg(i, i + 1); i++; continue;
    }
    if (ch === '\n') {
      // Hard break: two or more spaces before the newline, and non-space
      // content follows somewhere later in the string.
      let spaces = 0;
      if (segs) {
        outer: for (let s = segs.length - 1; s >= 0; s--) {
          const [a, b] = segs[s];
          for (let k = b - 1; k >= a; k--) {
            const c = src.charCodeAt(k);
            if (c === 32) { spaces++; }
            else break outer;
          }
        }
      }
      let rest = false;
      if (spaces >= 2) {
        for (let k = i + 1; k < n; k++) {
          if (!isSpaceCh(src[k])) { rest = true; break; }
        }
      }
      if (spaces >= 2 && rest) {
        // Drop the trailing spaces from the text run.
        flushText();
        // Remove trailing spaces from the last text item(s).
        let t = tail;
        let drop = spaces;
        while (t && drop > 0 && t.t === T_TEXT) {
          const s = t.s;
          let cut = 0;
          for (let k = s.length - 1; k >= 0 && drop > 0; k--) {
            if (s[k] === ' ') { cut++; drop--; }
            else break;
          }
          t.s = s.slice(0, s.length - cut);
          if (t.s === '') {
            const p = t.prev;
            if (p) p.next = null; else head = null;
            tail = p;
            t = p;
          } else break;
        }
        push({ t: T_BR });
        i++;
        // A hard break swallows the newline and the next line's leading
        // spaces/tabs.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      addSeg(i, i + 1); i++; continue;
    }
    if (ch === '`') {
      // Inside a link text, a code-span closer may pass the ']' that
      // closes the link only when it stays on the opener's line (cm-342,
      // cm-525); a closer on a later line past the ']' would swallow the
      // whole link and match a foreign backtick run (doc-09).
      let limit = -1, limitLine = -1;
      if (brackets.length > 0) {
        const close = src.indexOf(']', i);
        if (close >= 0) { limit = close; limitLine = src.indexOf('\n', i); }
      }
      const cs = parseCodeSpan(src, i, limit, limitLine);
      if (cs) {
        flushText();
        push({ t: T_CODE, s: cs.content });
        i = cs.end;
        continue;
      }
      // No matching closer for this run: the whole run is literal text
      // (do not retry with a shorter run, which would wrongly form a span).
      let j = i;
      while (j < n && src[j] === '`') j++;
      addSeg(i, j); i = j; continue;
    }
    if (ch === '<') {
      const al = parseAutolink(src, i);
      if (al) {
        flushText();
        push({ t: T_AUTO, href: al.href, s: al.text });
        i = al.end;
        continue;
      }
      const tagEnd = parseHtmlTag(src, i);
      if (tagEnd > 0) {
        flushText();
        push({ t: T_HTML, s: src.slice(i, tagEnd) });
        i = tagEnd;
        continue;
      }
      addSeg(i, i + 1); i++; continue;
    }
    if (ch === '!') {
      if (src[i + 1] === '[') {
        flushText();
        push({ t: T_TEXT, s: '![' });
        brackets.push({ item: tail, img: true, active: true, srcStart: i + 1 });
        i += 2;
        continue;
      }
      addSeg(i, i + 1); i++; continue;
    }
    if (ch === '[') {
      flushText();
      push({ t: T_TEXT, s: '[' });
      brackets.push({ item: tail, img: false, active: true, srcStart: i });
      i++; continue;
    }
    if (ch === ']') {
      const opener = brackets.length ? brackets[brackets.length - 1] : null;
      if (!opener) { addSeg(i, i + 1); i++; continue; }
      if (!opener.active) {
        brackets.pop();
        addSeg(i, i + 1); i++; continue;
      }
      // Link text: the items after the opener's '[' item.
      const linkText = src.slice(opener.srcStart + 1, i);
      const res = tryLink(src, i + 1, linkText, defs);
      if (!res) {
        brackets.pop();
        addSeg(i, i + 1); i++; continue;
      }
      const href = cleanUrl(unescape(res.href));
      if (href === null) {
        brackets.pop();
        addSeg(i, i + 1); i++; continue;
      }
      flushText();
      // Collect the children: items after the opener item up to the tail.
      // Emphasis inside link text must be resolved now: processEmphasis
      // works on the linked list, but the children are stored as an array,
      // so resolve emphasis here (before snapshotting) and remove those
      // delimiters from the shared chain.
      let childHead = opener.item.next;
      const childDelims = [];
      {
        let nd = childHead;
        while (nd) { if (nd.t === T_DELIM) childDelims.push(nd); nd = nd.next; }
      }
      if (childDelims.length) {
        for (const d of childDelims) removeDelim(d);
        // Also drop them from the delims array: later delimiter pushes use
        // delims[delims.length-1] as dprev, and a removed delimiter there
        // would orphan the new delimiter from the active chain.
        for (let k = delims.length - 1; k >= 0; k--) {
          if (childDelims.indexOf(delims[k]) >= 0) delims.splice(k, 1);
        }
        for (let k = 0; k < childDelims.length; k++) {
          childDelims[k].dprev = k > 0 ? childDelims[k - 1] : null;
          childDelims[k].dnext = k + 1 < childDelims.length ? childDelims[k + 1] : null;
        }
        childHead = processEmphasis(childHead, childDelims);
      }
      const children = [];
      let node = childHead;
      while (node) {
        const nx = node.next;
        children.push(node);
        node = nx;
      }
      // Unlink the opener item and the children from the list.
      const before = opener.item.prev;
      if (before) before.next = null; else head = null;
      tail = before;
      if (opener.img) {
        push({ t: T_IMG, href, title: res.title, children });
      } else {
        push({ t: T_LINK, href, title: res.title, children });
        // A link deactivates every earlier LINK bracket (no nested links),
        // but not an earlier IMAGE bracket: a link inside an image's alt
        // text must not prevent the image from forming.
        for (const b of brackets) if (!b.img) b.active = false;
      }
      brackets.pop();
      i = res.end;
      continue;
    }
    if (ch === '*' || ch === '_') {
      let j = i;
      while (j < n && src[j] === ch) j++;
      const run = j - i;
      if (ch === '_' && run === 1 && underscoreInEmail(src, i) && !hasOpenUnderscore(src, i)) { addSeg(i, j); i = j; continue; }
      const prev = i > 0 ? src[i - 1] : '';
      const nextCh = j < n ? src[j] : '';
      const [left, right] = flank(prev, nextCh);
      let canOpen, canClose;
      if (ch === '*') { canOpen = left; canClose = right; }
      else {
        canOpen = left && (!right || isPunctCh(prev));
        canClose = right && (!left || isPunctCh(nextCh));
      }
      if (!canOpen && !canClose) { addSeg(i, j); i = j; continue; }
      flushText();
      const d = push({ t: T_DELIM, ch, n: run, canOpen, canClose });
      d.dprev = delims.length ? delims[delims.length - 1] : null;
      d.dnext = null;
      if (d.dprev) d.dprev.dnext = d;
      delims.push(d);
      i = j;
      continue;
    }
    if (ch === '~') {
      let j = i;
      while (j < n && src[j] === '~') j++;
      const run = j - i;
      if (run === 1 || run === 2) {
        const prev = i > 0 ? src[i - 1] : '';
        const nextCh = j < n ? src[j] : '';
        const [left, right] = flank(prev, nextCh);
        if (!left && !right) { addSeg(i, j); i = j; continue; }
        flushText();
        const d = push({ t: T_DELIM, ch: '~', n: run, canOpen: left, canClose: right });
        d.dprev = delims.length ? delims[delims.length - 1] : null;
        d.dnext = null;
        if (d.dprev) d.dprev.dnext = d;
        delims.push(d);
        i = j;
        continue;
      }
      addSeg(i, j); i = j; continue;
    }
    // Unreachable: every character in SPECIAL_RE is handled above.
    addSeg(i, i + 1); i++;
  }
  flushText();
  head = processEmphasis(head, delims);
  // Flatten the linked list into an array.
  const items = [];
  let node = head;
  while (node) {
    items.push(node);
    node = node.next;
  }
  return items;
}

// Render inline items to HTML.
function renderItems(items, out) {
  for (const it of items) {
    switch (it.t) {
      case T_TEXT: out.push(escText(it.s)); break;
      case T_CODE: out.push('<code>', escAll(it.s), '</code>'); break;
      case T_BR: out.push('<br>'); break;
      case T_HTML: out.push(it.s); break;
      case T_LINK: {
        out.push('<a href="', esc(it.href), '"');
        if (it.title !== null && it.title !== undefined) {
          out.push(' title="', esc(unescape(it.title)), '"');
        }
        out.push('>');
        renderItems(it.children, out);
        out.push('</a>');
        break;
      }
      case T_IMG: {
        out.push('<img src="', esc(it.href), '" alt="', renderPlain(it.children), '"');
        if (it.title !== null && it.title !== undefined) {
          out.push(' title="', esc(unescape(it.title)), '"');
        }
        out.push('>');
        break;
      }
      case T_DELIM: out.push(it.ch.repeat(it.n)); break;
      case T_AUTO: {
        const href = cleanUrl(unescape(it.href));
        out.push('<a href="', esc(href === null ? it.href : href), '">', escText(it.s), '</a>');
        break;
      }
      case T_WRAP: {
        const tag = it.kind === 'em' ? 'em' : it.kind === 'strong' ? 'strong' : 'del';
        out.push('<', tag, '>');
        renderItems(it.children, out);
        out.push('</', tag, '>');
        break;
      }
    }
  }
}

// Render inline items as plain text (for image alt text): markup is dropped,
// the text it wraps is kept, and the result is escaped.
function renderPlain(items) {
  const out = [];
  for (const it of items) {
    switch (it.t) {
      case T_TEXT: out.push(escText(it.s)); break;
      case T_CODE: out.push(escAll(it.s)); break;
      case T_BR: break;
      case T_HTML: out.push(escAll(it.s)); break;
      case T_LINK: case T_WRAP: out.push(renderPlain(it.children)); break;
      case T_IMG: out.push(renderPlain(it.children)); break;
      case T_DELIM: out.push(it.ch.repeat(it.n)); break;
      case T_AUTO: out.push(escText(it.s)); break;
    }
  }
  return out.join('');
}

// Parse inline Markdown to HTML.
function parseInline(src, defs) {
  if (src.indexOf('\n') < 0 && src.indexOf('\\') < 0 && src.indexOf('`') < 0 && src.indexOf('*') < 0 &&
    src.indexOf('_') < 0 && src.indexOf('~') < 0 && src.indexOf('[') < 0 &&
    src.indexOf('<') < 0 && src.indexOf('!') < 0) {
    // Fast path: plain text with possible extended autolinks only when the
    // text contains a candidate; otherwise it is just escaped text.
    if (src.indexOf('www.') < 0 && src.indexOf('://') < 0 && src.indexOf('@') < 0) {
      return escText(src);
    }
  }
  const items = scanInline(src, defs);
  const out = [];
  renderItems(items, out);
  return out.join('');
}

// Remove a delimiter item from the delimiter list.
function removeDelim(d) {
  if (d.dprev) d.dprev.dnext = d.dnext;
  if (d.dnext) d.dnext.dprev = d.dprev;
  d.dprev = d.dnext = null;
}

// The CommonMark delimiter algorithm over the scanned items. Returns the
// (possibly new) head of the items list.
function processEmphasis(head, delims) {
  if (!delims.length) return head;
  const openersBottom = { '*': null, '_': null, '~': null };
  let cur = delims[0];
  while (cur) {
    const nextDelim = cur.dnext;
    if (cur.canClose) {
      let opener = cur.dprev;
      while (opener && opener !== openersBottom[cur.ch]) {
        const odd = (opener.canClose || cur.canOpen) &&
          ((opener.n + cur.n) % 3 === 0) &&
          (opener.n % 3 !== 0 || cur.n % 3 !== 0);
        if (opener.ch === cur.ch && opener.canOpen && !odd) break;
        opener = opener.dprev;
      }
      if (opener) {
        const use = opener.n >= 2 && cur.n >= 2 ? 2 : 1;
        const kind = cur.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        const curN = cur.n;
        opener.n -= use;
        cur.n -= use;
        // Wrap the items between opener and cur.
        const children = [];
        let node = opener.next;
        while (node !== cur) {
          const nx = node.next;
          children.push(node);
          node = nx;
        }
        const wrap = { t: T_WRAP, kind, children, next: cur, prev: opener };
        opener.next = wrap;
        cur.prev = wrap;
        // Delimiters strictly inside this emphasis can no longer match a
        // closer outside it (e.g. the '*' inside a <strong> must stay
        // literal when the outer '*' closes after the strong).
        {
          let dd = opener.dnext;
          while (dd && dd !== cur) {
            const nxd = dd.dnext;
            removeDelim(dd);
            dd = nxd;
          }
        }
        // Rule of 3 across a nested emphasis: when this emphasis's closer
        // can also open (followed by a letter), its opener is a pure
        // opener (cannot close), and the closer's length plus the directly
        // preceding outer opener's length is a multiple of 3 (without both
        // being multiples of 3), the outer emphasis must not form across
        // it (e.g. '*a **b**c*' leaves the outer '*' literal, while
        // '*foo**bar**baz*' still nests because its inner opener can close).
        if (cur.canOpen && !opener.canClose) {
          const od = opener.dprev;
          if (od && od.ch === cur.ch && od.canOpen &&
            (curN + od.n) % 3 === 0 && (curN % 3 !== 0 || od.n % 3 !== 0)) {
            removeDelim(od);
          }
        }
        // Drop exhausted delimiters from both lists.
        if (opener.n === 0) {
          const op = opener.prev;
          wrap.prev = op;
          if (op) op.next = wrap; else head = wrap;
          removeDelim(opener);
        }
        if (cur.n === 0) {
          const cn = cur.next;
          wrap.next = cn;
          if (cn) cn.prev = wrap;
          removeDelim(cur);
          cur = nextDelim;
        }
        // Otherwise cur stays and is re-examined.
      } else {
        openersBottom[cur.ch] = cur.dprev;
        if (!cur.canOpen) removeDelim(cur);
        cur = nextDelim;
      }
    } else {
      cur = nextDelim;
    }
  }
  return head;
}

// ---------- Block parsing ----------
// A line object: { s, lazy, ss, extraNL }
//   s: text with container prefixes stripped
//   lazy: true if added as a lazy continuation (no container marker)
//   ss: true if a setext underline suppressed from becoming a heading (lazy line in a list item)
//   extraNL: true if the line contributes an extra '\n' to a paragraph text (list lazy setext lines)
function mkLine(s, lazy, ss, extraNL) { return { s: s, lazy: !!lazy, ss: !!ss, extraNL: !!extraNL }; }
function isBlankLine(l) { return !l.ws && /^[ \t]*$/.test(l.s); }
function colIndent(s) {
  let c = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ' ') c++;
    else if (ch === '\t') c += 4 - (c % 4);
    else break;
  }
  return c;
}
function firstNonSpace(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return i;
  return -1;
}
function stripColsExpand(s, n) {
  // Expand all leading tabs to spaces, then remove n columns (used when
  // stripping a container's content indent; marked expands tabs first).
  let col = 0, i = 0, expanded = '';
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') { expanded += ' '; col++; i++; }
    else { const w = 4 - (col % 4); expanded += ' '.repeat(w); col += w; i++; }
  }
  if (expanded.length <= n) return s.slice(i);
  return expanded.slice(n) + s.slice(i);
}
// Remove one level of indented-code indent (marked's codeRemoveIndent):
// up to 3 spaces + a tab, or 1-4 spaces.
function stripCodeIndent(s) {
  return s.replace(/^(?: {0,3}\t| {1,4})/, '');
}
function trimLineEnd(s) { return s.replace(/[ \t]+$/, ''); }

// ATX heading: returns { level, text } or null. text is the raw heading content (after the #'s).
function atxHead(s) {
  if (colIndent(s) >= 4) return null;
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(s);
  if (!m) return null;
  let text = m[2] === undefined ? '' : m[2];
  text = text.replace(/[ \t]+$/, '');
  // closing sequence of #'s: stripped when the remainder is empty or ends with a space/tab
  if (/#$/.test(text)) {
    const s2 = text.replace(/#+$/, '');
    if (s2 === '' || /[ \t]$/.test(s2)) text = s2.replace(/[ \t]+$/, '');
  }
  return { level: m[1].length, text: text };
}
// Fence start: returns { ch, len, info } or null.
function fenceStart(s) {
  if (colIndent(s) >= 4) return null;
  const m = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(s);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].indexOf('`') !== -1) return null;
  return { ch: m[1][0], len: m[1].length, info: m[2] };
}
// Fence end line: same char, at least len, indent < 4, only spaces after.
function fenceEnd(s, ch, len) {
  if (colIndent(s) >= 4) return false;
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(s);
  return !!m && m[1][0] === ch && m[1].length >= len;
}
// Thematic break.
function hrLine(s) {
  if (colIndent(s) >= 4) return false;
  return /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(s);
}
// Setext underline: returns 1 for '=', 2 for '-', else 0. Indent must be < 4.
function setextLevel(s) {
  if (colIndent(s) >= 4) return 0;
  if (/^ {0,3}=+[ \t]*$/.test(s)) return 1;
  if (/^ {0,3}-+[ \t]*$/.test(s)) return 2;
  return 0;
}
// Table delimiter row: returns array of alignments (0 none, 1 left, 2 center, 3 right) or null.
function tableDelim(s) {
  if (colIndent(s) >= 4) return null;
  const m = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?) *$/.exec(s);
  if (!m) return null;
  const d = m[1];
  if (d.indexOf(':') === -1 && d.indexOf('|') === -1) return null;
  let cells = d.split('|');
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  const align = [];
  for (const c of cells) {
    const t = c.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    const l = t[0] === ':', r = t[t.length - 1] === ':';
    align.push(l && r ? 2 : r ? 3 : l ? 1 : 0);
  }
  if (!align.length) return null;
  return align;
}
// Split a table row into cells (handles escaped pipes and leading/trailing pipes).
function splitTableRow(s) {
  let t = s.replace(/\\\|/g, '\u0000');
  let cells = t.split('|');
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\u0000/g, '|');
  return cells;
}

// Block-level HTML tag names (CommonMark list).
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
// HTML block start: returns type 1-7 or 0.
function htmlBlockStart(s) {
  if (colIndent(s) >= 4) return 0;
  const t = s.replace(/^ {0,3}/, '');
  if (/^<(script|pre|style|textarea)([\s>]|$)/i.test(t)) return 1;
  if (/^<!--/.test(t)) return 2;
  if (/^<\?/.test(t)) return 3;
  if (/^<![A-Z]/.test(t)) return 4;
  if (/^<!\[CDATA\[/.test(t)) return 5;
  if (/^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[ \t]+|\/?>|$)/.test(t)) {
    const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(t);
    if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  }
  // Type 7: a complete open/closing tag alone on the line (attributes must
  // be valid; use the tag parser rather than a permissive regex).
  if (/^<\/?[a-zA-Z]/.test(t)) {
    const end = parseHtmlTag(t, 0);
    if (end > 0 && /^[ \t]*$/.test(t.slice(end))) return 7;
  }
  return 0;
}
// HTML block end condition for types 1-5: returns true if the line contains the end pattern.
function htmlBlockEnd(s, type) {
  if (type === 1) return /<\/(script|pre|style|textarea)>/i.test(s);
  if (type === 2) return /-->/.test(s);
  if (type === 3) return /\?>/.test(s);
  if (type === 4) return />/.test(s);
  if (type === 5) return /\]\]>/.test(s);
  return false;
}

// Link reference definition starting at lines[i]. Returns { def, next } or null.
// def = { label, href, title }. next = index of the first line after the definition.
// Link reference definition, mirroring marked's def regex:
// /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?(dest)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/
// The label may span lines (not across a blank line) and contain escapes;
// the title may span lines too. If a title is present but invalid (trailing
// text after it), the regex backtracks to a destination-only definition.
const DEF_RE = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
function tryDef(lines, i) {
  const first = lines[i].s;
  if (colIndent(first) >= 4) return null;
  if (!/^ {0,3}\[/.test(first)) return null;
  // Join this line and the following lines (a def spans a few lines at most
  // and never crosses a blank line) so the regex can match multi-line
  // labels, destinations and titles.
  let end = i + 1;
  while (end < lines.length && end - i < 8 && !isBlankLine(lines[end])) end++;
  const text = lines.slice(i, end).map(l => l.s).join('\n');
  const m = DEF_RE.exec(text);
  if (!m) return null;
  const norm = normalizeLabel(m[1]);
  if (!norm) return null;
  let dest = m[2];
  if (dest[0] === '<' && dest[dest.length - 1] === '>') dest = dest.slice(1, -1);
  dest = dest.replace(ESCAPABLE_RE, '$1');
  let title = null;
  if (m[3]) title = m[3].slice(1, -1).replace(ESCAPABLE_RE, '$1');
  // Lines consumed: strip the trailing spaces/newlines of the match, then
  // count the newlines in the definition content.
  const raw = m[0].replace(/[ \t]*\n+$/, '').replace(/[ \t]+$/, '');
  const consumed = raw.split('\n').length;
  return { def: { label: norm, href: dest, title: title }, next: i + consumed };
}

// List marker on a line: returns { ordered, start, markerLen } or null.
function listMarkerAt(s) {
  if (colIndent(s) >= 4) return null;
  let m = /^ {0,3}([*+-])(?:[ \t]+|$)/.exec(s);
  if (m) return { ordered: false, start: 0, markerLen: m[0].length, bullet: m[1] };
  m = /^ {0,3}(\d{1,9})([.)])(?:[ \t]+|$)/.exec(s);
  if (m) return { ordered: true, start: parseInt(m[1], 10), markerLen: m[0].length, bullet: m[1] + m[2] };
  return null;
}
// Does a list marker line interrupt a paragraph? Bullet: first item non-empty.
// Ordered: starts with 1 -- except inside a container (list item / blockquote),
// where any ordered list may interrupt (marked lexes item content with top=false).
function listInterrupts(s, top) {
  const mk = listMarkerAt(s);
  if (!mk) return false;
  const rest = s.slice(mk.markerLen);
  if (rest.trim() === '') return false; // empty first item cannot interrupt
  if (mk.ordered && mk.start !== 1 && top) return false;
  return true;
}
// Whether the parsed inner lines end with an open paragraph (for lazy continuation).
function endsWithOpenParagraph(lines, defs) {
  if (!lines.length) return false;
  if (isBlankLine(lines[lines.length - 1])) return false;
  const nodes = parseBlocks(lines, defs, true, false, false);
  if (!nodes.length) return false;
  let node = nodes[nodes.length - 1];
  while (node) {
    if (node.t === 'para') return true;
    if (node.t === 'quote') {
      if (!node.children.length) return false;
      node = node.children[node.children.length - 1];
      continue;
    }
    if (node.t === 'list') {
      if (!node.children.length) return false;
      node = node.children[node.children.length - 1];
      continue;
    }
    if (node.t === 'item') {
      if (!node.children.length) return false;
      node = node.children[node.children.length - 1];
      continue;
    }
    return false;
  }
  return false;
}

// Build paragraph text from its lines (handles extraNL).
function paraText(lines) {
  let out = '';
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    out += l.s;
    if (l.extraNL) out += '\n';
    if (k < lines.length - 1) out += '\n';
  }
  return out;
}

// Main block parser. lines: array of line objects. defs: shared Map. speculative: true when called only to test structure (no def side effects needed).
// Returns the node array; the array carries .hasBlankSep (a blank line separates two blocks).
function parseBlocks(lines, defs, speculative, endsNL, top) {
  if (top === undefined) top = true;
  const nodes = [];
  const n = lines.length;
  let i = 0;
  let para = null; // array of line objects
  let sawBlank = false; // a blank line was seen since the last emitted block
  let hasBlankSep = false; // a blank line separates two blocks
  let hasBlankBeforeDef = false; // a blank line precedes a link ref definition
  const emit = (node) => {
    if (sawBlank && nodes.length) hasBlankSep = true;
    sawBlank = false;
    nodes.push(node);
  };
  const closePara = () => {
    if (para && para.length) { emit({ t: 'para', lines: para }); para = null; }
  };

  while (i < n) {
    const line = lines[i];
    const s = line.s;
    if (isBlankLine(line) || (!para && /^[ \t]*$/.test(s))) { closePara(); sawBlank = true; i++; continue; }
    if (para) {
      const sl = setextLevel(s);
      if (sl && !line.ss) {
        emit({ t: 'head', level: sl, lines: para });
        para = null; i++; continue;
      }
      const delim = tableDelim(s);
      if (delim) {
        const headCells = splitTableRow(para[para.length - 1].s);
        if (headCells.length === delim.length) {
          const rest = para.slice(0, para.length - 1);
          if (rest.length) emit({ t: 'para', lines: rest });
          para = null;
          const rows = [];
          i++;
          while (i < n) {
            const ls = lines[i].s;
            // A table row ends the table only on a truly blank line (empty
            // or spaces only). A line of only tabs is an (empty) row: the
            // table body pattern excludes ` *\n` blank lines and indented
            // code `(?: {4}| {0,3}\t)[^\n]`, but a lone tab is neither.
            if (/^ *$/.test(ls)) break;
            if (atxHead(ls) || fenceStart(ls) || hrLine(ls)) break;
            if (/^ {0,3}>/.test(ls)) break;
            if (listMarkerAt(ls)) break;
            const hb2 = htmlBlockStart(ls);
            if (hb2 >= 1 && hb2 <= 6) break;
            if (/^(?: {4}| {0,3}\t)./.test(ls)) break;
            rows.push(splitTableRow(ls));
            i++;
          }
          emit({ t: 'table', align: delim, head: headCells, rows: rows });
          continue;
        }
      }
      // A lazy continuation line never starts a new block; it extends the
      // paragraph (setext/table checks above still apply).
      if (!line.lazy) {
        const ah = atxHead(s);
        if (ah) { closePara(); emit({ t: 'head', level: ah.level, lines: [mkLine(ah.text)] }); i++; continue; }
        const fs = fenceStart(s);
        if (fs) { closePara(); const r = collectFence(lines, i, fs); emit(r.node); i = r.next; continue; }
        if (hrLine(s)) { closePara(); emit({ t: 'hr' }); i++; continue; }
        if (/^ {0,3}>/.test(s)) { closePara(); const r = collectQuote(lines, i, defs); emit(r.node); i = r.next; continue; }
        if (listInterrupts(s, top)) { closePara(); const r = collectList(lines, i, defs); emit(r.node); if (r.trailingBlankConsumed) sawBlank = true; i = r.next; continue; }
        const hb = htmlBlockStart(s);
        if (hb >= 1 && hb <= 6) { closePara(); const r = collectHtml(lines, i, hb, endsNL); emit(r.node); i = r.next; continue; }
      }
      para.push(line);
      i++;
      continue;
    }
    const ah = atxHead(s);
    if (ah) { emit({ t: 'head', level: ah.level, lines: [mkLine(ah.text)] }); i++; continue; }
    const fs = fenceStart(s);
    if (fs) { const r = collectFence(lines, i, fs); emit(r.node); i = r.next; continue; }
    if (hrLine(s)) { emit({ t: 'hr' }); i++; continue; }
    if (/^ {0,3}>/.test(s)) { const r = collectQuote(lines, i, defs); emit(r.node); i = r.next; continue; }
    if (listMarkerAt(s)) { const r = collectList(lines, i, defs); emit(r.node); if (r.trailingBlankConsumed) sawBlank = true; i = r.next; continue; }
    const hb = htmlBlockStart(s);
    if (hb >= 1 && hb <= 7) { const r = collectHtml(lines, i, hb, endsNL); emit(r.node); i = r.next; continue; }
    if (colIndent(s) >= 4) { const r = collectCode(lines, i); emit(r.node); i = r.next; continue; }
    if (!speculative) {
      const d = tryDef(lines, i);
      if (d) {
        if (sawBlank && nodes.length) hasBlankBeforeDef = true;
        if (!defs.has(d.def.label)) defs.set(d.def.label, { href: d.def.href, title: d.def.title });
        i = d.next;
        continue;
      }
    }
    para = [line];
    i++;
  }
  closePara();
  nodes.hasBlankSep = hasBlankSep;
  nodes.hasBlankBeforeDef = hasBlankBeforeDef;
  return nodes;
}

// Collect a fenced code block starting at lines[i]. Returns { node, next }.
function collectFence(lines, i, fs) {
  const n = lines.length;
  let text = '';
  // Only backtick fences strip the fence indent from content lines; a
  // tilde fence keeps the content's leading spaces as-is (marked quirk).
  const findent = fs.ch === '`' ? colIndent(lines[i].s) : 0;
  i++;
  while (i < n) {
    const s = lines[i].s;
    if (fenceEnd(s, fs.ch, fs.len)) { i++; break; }
    text += stripCols(s, findent) + '\n';
    i++;
  }
  // Strip exactly one trailing newline when the last content line is
  // empty (text ends with '\n\n', or the whole content is a single '\n').
  // A last line containing spaces is not empty, so its newline is kept.
  if (text.endsWith('\n\n') || text === '\n') text = text.slice(0, -1);
  let info = fs.info.replace(/^[ \t]+/, '');
  let w = '';
  let k = 0;
  while (k < info.length) {
    const ch = info[k];
    if (ch === '\\' && k + 1 < info.length && /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~]/.test(info[k + 1])) { w += info[k + 1]; k += 2; continue; }
    if (ch === ' ' || ch === '\t') break;
    w += ch; k++;
  }
  return { node: { t: 'fence', lang: w, text: text }, next: i };
}

// Collect an indented code block starting at lines[i]. Returns { node, next }.
function collectCode(lines, i) {
  const n = lines.length;
  let text = '';
  let j = i;
  while (j < n) {
    const s = lines[j].s;
    if (isBlankLine(lines[j])) {
      let k = j;
      while (k < n && isBlankLine(lines[k])) k++;
      if (k < n && colIndent(lines[k].s) >= 4) {
        while (j < k) { text += stripCodeIndent(lines[j].s) + '\n'; j++; }
        continue;
      }
      break;
    }
    if (colIndent(s) >= 4) { text += stripCodeIndent(s) + '\n'; j++; continue; }
    break;
  }
  return { node: { t: 'code', text: text }, next: j };
}

// Collect an HTML block starting at lines[i]. Returns { node, next }.
function collectHtml(lines, i, type, endsNL) {
  const n = lines.length;
  const content = [];
  content.push(lines[i].s);
  i++;
  if (type >= 1 && type <= 5) {
    if (htmlBlockEnd(lines[i - 1].s, type)) {
      // Single-line block.
    } else {
      while (i < n) {
        content.push(lines[i].s);
        i++;
        if (htmlBlockEnd(lines[i - 1].s, type)) break;
      }
    }
  } else {
    while (i < n) {
      if (isBlankLine(lines[i])) break;
      content.push(lines[i].s);
      i++;
    }
  }
  // Drop trailing blank content lines (an unclosed block running to EOF).
  let trailingBlanks = 0;
  while (content.length > 1 && /^[ \t]*$/.test(content[content.length - 1])) {
    content.pop();
    trailingBlanks++;
  }
  let text = content.join('\n');
  // A trailing '\n' is kept when the block consumed to EOF and the input
  // ends with exactly one '\n' (no blank-line terminator was consumed), or
  // for types 1-5 when the next line is a non-blank line (the closing tag's
  // line ending is a single '\n' that marked keeps).
  if (i === n && endsNL && trailingBlanks === 0) text += '\n';
  else if (type >= 1 && type <= 5 && i < n && lines[i].s !== '') text += '\n';
  return { node: { t: 'html', text }, next: i };
}

// Collect a blockquote starting at lines[i]. Returns { node, next }.
function collectQuote(lines, i, defs) {
  const n = lines.length;
  const inner = [];
  let j = i;
  let prevLazy = false;
  while (j < n) {
    const s = lines[j].s;
    const m = /^ {0,3}>/.exec(s);
    if (m) {
      // Expand the whole whitespace run after '>' to spaces (tab-expanding
      // relative to the '>' column), then drop exactly one space.
      const col0 = m[0].length;
      let rest = s.slice(col0);
      let k = 0, c = col0, expanded = '';
      while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
        if (rest[k] === ' ') { expanded += ' '; c++; }
        else { const w = 4 - (c % 4); expanded += ' '.repeat(w); c += w; }
        k++;
      }
      if (expanded.length > 0) expanded = expanded.slice(1);
      rest = expanded + rest.slice(k);
      const ln = mkLine(rest, false);
      // A marker line that leaves only whitespace is paragraph content (a
      // space), not a blank line.
      if (rest.length > 0 && /^[ \t]+$/.test(rest)) ln.ws = true;
      inner.push(ln);
      prevLazy = false;
      j++;
      continue;
    }
    if (isBlankLine(lines[j])) break;
    // a lazy line that starts a block (hr, heading, fence, list, html) ends the blockquote
    if (hrLine(s) || atxHead(s) || fenceStart(s) || listMarkerAt(s) || htmlBlockStart(s)) break;
    if (!endsWithOpenParagraph(inner, defs)) break;
    let ls = s;
    const isSetext = setextLevel(s) > 0;
    if (isSetext && prevLazy) ls = '    ' + s.replace(/^ {0,3}/, '');
    else if (!isSetext && colIndent(ls) >= 4) ls = stripColsExpand(ls, 4);
    inner.push(mkLine(ls, true, isSetext, false));
    prevLazy = true;
    j++;
  }
  const children = parseBlocks(inner, defs, false, false, false);
  return { node: { t: 'quote', children: children }, next: j };
}

// Whether a line starts a block that ends a list item's content (tested at the item content indent R).
function itemBreakLine(s, R) {
  const L = Math.max(0, Math.min(3, R - 1));
  if (colIndent(s) > L) return false;
  if (fenceStart(s)) return true;
  if (atxHead(s)) return true;
  if (htmlBlockStart(s)) return true;
  if (/^ {0,3}>/.test(s)) return true;
  if (listMarkerAt(s)) return true;
  if (hrLine(s)) return true;
  return false;
}
// Does prevLine + '\n' + line form a valid setext heading? (single-line paragraph + underline)
function lheadingTest(prev, line) {
  if (!prev || !prev.trim()) return false;
  if (colIndent(prev) >= 4) return false;
  if (atxHead(prev) || fenceStart(prev) || hrLine(prev)) return false;
  if (/^ {0,3}>/.test(prev)) return false;
  if (listMarkerAt(prev)) return false;
  if (htmlBlockStart(prev)) return false;
  return setextLevel(line) > 0;
}

// Collect a list starting at lines[i]. Returns { node, next }.
function collectList(lines, i, defs) {
  const n = lines.length;
  const first = lines[i].s;
  const mk0 = listMarkerAt(first);
  const ordered = mk0.ordered;
  const bullet = mk0.bullet;
  const startNum = mk0.start;
  const items = [];
  let j = i;
  let blankBetween = false;
  const baseIndent = colIndent(first);
  let prevIndent = baseIndent;
  let prevTrailingBlank = false;
  while (j < n) {
    const s = lines[j].s;
    if (hrLine(s)) break; // an hr line ends the list even if it looks like a list item
    const mk = listMarkerAt(s);
    if (!mk) break;
    if (mk.ordered !== ordered) break;
    if (ordered) { if (mk.bullet.slice(-1) !== bullet.slice(-1)) break; }
    else if (mk.bullet !== bullet) break;
    // A sibling item may be indented at most one column more than the
    // previous item, and never less than the first item's indent; a deeper
    // indent starts a nested list inside the previous item instead. After a
    // blank line, an item indented up to 3 past the base indent is a
    // sibling (an indent of 4+ is a code block instead).
    const ind = colIndent(s);
    // A sibling may sit at a smaller indent than the first item (down to
    // the container's indent); only an excessive increase breaks the list.
    if (prevTrailingBlank) { if (ind - baseIndent > 3) break; }
    else if (ind > prevIndent + 1) break;
    prevIndent = ind;
    const indent = colIndent(s);
    const b = indent + mk.bullet.length;
    const g = s.slice(indent + mk.bullet.length);
    let m = g;
    const lw = /^[ \t]+/.exec(g);
    if (lw) {
      let col = b, out = '';
      for (const ch of lw[0]) {
        if (ch === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
        else { out += ' '; col++; }
      }
      m = out + g.slice(lw[0].length);
    }
    let R = 0;
    while (R < m.length && m[R] === ' ') R++;
    const emptyFirst = R >= m.length;
    if (emptyFirst) R = 1;
    else if (R > 4) R = 1;
    const contentIndent = R + b;
    const firstContent = emptyFirst ? '' : m.slice(R);
    const itemLines = [];
    if (!emptyFirst) itemLines.push(mkLine(firstContent, false));
    let prevContent = firstContent;
    let prevBlank = emptyFirst;
    let hasContent = !emptyFirst;
    let blankSeen = false;
    let k = j + 1;
    while (k < n) {
      const ls = lines[k].s;
      if (itemBreakLine(ls, contentIndent)) break;
      if (colIndent(ls) >= contentIndent || isBlankLine(lines[k])) {
        // An empty item ends at a real blank line; following content is a new block.
        if (blankSeen && !hasContent && !isBlankLine(lines[k])) break;
        const stripped = isBlankLine(lines[k]) ? '' : stripColsExpand(ls, contentIndent);
        if (stripped !== '') hasContent = true;
        if (isBlankLine(lines[k])) blankSeen = true;
        itemLines.push(mkLine(stripped, false));
        prevBlank = isBlankLine(lines[k]);
        prevContent = stripped;
        k++;
        continue;
      }
      if (prevBlank) break;
      if (colIndent(prevContent) >= 4) break;
      if (fenceStart(prevContent) || atxHead(prevContent) || hrLine(prevContent) || htmlBlockStart(prevContent)) break;
      const isSetext = setextLevel(ls) > 0;
      let ss = false;
      if (isSetext && lheadingTest(prevContent, ls)) ss = true;
      // A lazy continuation line indented 4+ has its leading whitespace
      // stripped (it reads as indentation); one indented less than 4
      // keeps its leading spaces as paragraph content (e.g. ">    Naïve"
      // inside a blockquote keeps 3 spaces, cm-291's 4-space line loses them).
      const strippedLazy = colIndent(ls) >= 4 ? stripColsExpand(ls, contentIndent) : ls;
      itemLines.push(mkLine(strippedLazy, true, ss, false));
      prevBlank = false;
      prevContent = strippedLazy;
      k++;
    }
    let trailingBlank = false;
    while (itemLines.length && itemLines[itemLines.length - 1].s === '') { itemLines.pop(); trailingBlank = true; }
    for (let q = 0; q < itemLines.length; q++) {
      if (itemLines[q].ss && q < itemLines.length - 1) itemLines[q].extraNL = true;
    }
    let task = null;
    if (itemLines.length && itemLines[0].s) {
      const tm = /^\[([ xX])\][ \t]+\S/.exec(itemLines[0].s);
      if (tm) {
        task = tm[1] === ' ' ? 'unchecked' : 'checked';
        itemLines[0] = mkLine(itemLines[0].s.replace(/^\[[ xX]\][ \t]+/, ''), itemLines[0].lazy, itemLines[0].ss, itemLines[0].extraNL);
      }
    }
    const children = parseBlocks(itemLines, defs, false, false, false);
    const hasBlankSep = !!children.hasBlankSep;
    items.push({ t: 'item', children: children, task: task, trailingBlank: trailingBlank, hasBlankSep: hasBlankSep, hasBlankBeforeDef: !!children.hasBlankBeforeDef, startNum: mk.start });
    const nextMk = k < n ? listMarkerAt(lines[k].s) : null;
    const nextInd = k < n ? colIndent(lines[k].s) : -1;
    const isNextItem = !!nextMk && nextMk.ordered === ordered &&
      (ordered ? nextMk.bullet.slice(-1) === bullet.slice(-1) : nextMk.bullet === bullet) &&
      (trailingBlank ? nextInd - baseIndent <= 3 : nextInd <= prevIndent + 1);
    if (trailingBlank && isNextItem) blankBetween = true;
    // A blank line before a link reference definition inside this item
    // separates it from the next item (the def itself emits no block).
    if (isNextItem && items[items.length - 1].hasBlankBeforeDef) blankBetween = true;
    prevTrailingBlank = trailingBlank;
    j = k;
  }
  const trailingBlankConsumed = items.length ? items[items.length - 1].trailingBlank : false;
  if (items.length) items[items.length - 1].trailingBlank = false;
  for (let q = 0; q < items.length - 1; q++) {
    const it = items[q];
    if (it.trailingBlank && it.children.length) {
      const lastChild = it.children[it.children.length - 1];
      if (lastChild.t === 'para' && lastChild.lines.length) {
        const ll = lastChild.lines[lastChild.lines.length - 1];
        if (ll.ss) ll.extraNL = true;
      }
    }
  }
  let loose = blankBetween;
  for (const it of items) if (it.hasBlankSep) loose = true;
  return { node: { t: 'list', ordered: ordered, start: startNum, tight: !loose, children: items }, next: j, trailingBlankConsumed: trailingBlankConsumed };
}

// ---------- Rendering ----------
function renderNodes(nodes, ctx) {
  let out = '';
  for (const node of nodes) out += renderNode(node, ctx);
  return out;
}
function renderNode(node, ctx) {
  switch (node.t) {
    case 'para':
      return '<p>' + parseInline(paraText(node.lines), ctx.defs) + '</p>\n';
    case 'head': {
      const text = paraText(node.lines).trim();
      return '<h' + node.level + '>' + parseInline(text, ctx.defs) + '</h' + node.level + '>\n';
    }
    case 'code':
      return '<pre><code>' + escAll(node.text) + '</code></pre>\n';
    case 'fence': {
      const lang = node.lang ? ' class="language-' + esc(node.lang) + '"' : '';
      return '<pre><code' + lang + '>' + escAll(node.text) + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'hr':
      return '<hr>\n';
    case 'quote':
      return '<blockquote>\n' + renderNodes(node.children, ctx) + '</blockquote>\n';
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const startAttr = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      let out = '<' + tag + startAttr + '>\n';
      for (const item of node.children) out += renderItem(item, node.tight, ctx);
      out += '</' + tag + '>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < node.head.length; c++) {
        const a = node.align[c];
        const al = a === 1 ? ' align="left"' : a === 2 ? ' align="center"' : a === 3 ? ' align="right"' : '';
        out += '<th' + al + '>' + parseInline(node.head[c], ctx.defs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length === 0) { out += '</table>\n'; return out; }
      out += '<tbody>';
      for (const row of node.rows) {
        out += '<tr>\n';
        for (let c = 0; c < node.head.length; c++) {
          const a = node.align[c];
          const al = a === 1 ? ' align="left"' : a === 2 ? ' align="center"' : a === 3 ? ' align="right"' : '';
          out += '<td' + al + '>' + parseInline(row[c] ?? '', ctx.defs) + '</td>\n';
        }
        out += '</tr>\n';
      }
      out += '</tbody></table>\n';
      return out;
    }
  }
  return '';
}
function renderItem(item, tight, ctx) {
  let inner = '';
  const children = item.children;
  for (let c = 0; c < children.length; c++) {
    const ch = children[c];
    if (tight && ch.t === 'para') {
      let html = parseInline(paraText(ch.lines), ctx.defs);
      if (c === 0 && item.task) html = checkboxHtml(item.task) + ' ' + html;
      inner += html;
    } else {
      let html = renderNode(ch, ctx);
      if (c === 0 && item.task && ch.t === 'para') {
        html = html.replace(/^<p>/, '<p>' + checkboxHtml(item.task) + ' ');
      }
      inner += html;
    }
  }
  if (children.length === 0) return '<li></li>\n';
  return '<li>' + inner + '</li>\n';
}
function checkboxHtml(task) {
  return task === 'checked' ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
}

// ---------- Entry point ----------
function parse(src) {
  src = src.replace(/\r\n?/g, '\n');
  const rawLines = src.split('\n');
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((s) => mkLine(s, false));
  const defs = new Map();
  const nodes = parseBlocks(lines, defs, false, src.endsWith('\n'), true);
  const ctx = { defs: defs };
  return renderNodes(nodes, ctx);
}
export { parse };
