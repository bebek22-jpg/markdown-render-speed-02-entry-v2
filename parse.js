// parse.js — a fast, dependency-free replacement for marked 18.1.3
// (GFM, default options) for the make.fun markdown-render-speed-02
// competition. parse(markdown) returns exactly the HTML marked renders.
//
// Design: a line-oriented block parser (containers, leaves, lists,
// tables, HTML blocks) feeding a single-pass inline scanner. The inline
// scanner collects text runs, code spans, links, autolinks and delimiter
// markers, then resolves emphasis with marked's own opener-driven
// algorithm. Where marked's behaviour differs from the CommonMark spec
// (its masking gate, its autolink backpedalling, its lazy list rules),
// this code follows marked.
//
// Speed: charCodeAt loops and indexOf scans instead of regexes on hot
// paths, a precomputed ASCII char-class table, lazy emphasis masking
// cached per paragraph, and minimal allocation in the scan loops.

'use strict';

// ---------------------------------------------------------------------------
// Character classes (CommonMark flanking rules)
// ---------------------------------------------------------------------------

const CC_OTHER = 0, CC_SPACE = 1, CC_PUNCT = 2;

const ASCII_CLASS = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) ASCII_CLASS[c] = CC_SPACE;
for (let c = 33; c <= 47; c++) ASCII_CLASS[c] = CC_PUNCT;
for (let c = 58; c <= 64; c++) ASCII_CLASS[c] = CC_PUNCT;
for (let c = 91; c <= 96; c++) ASCII_CLASS[c] = CC_PUNCT;
for (let c = 123; c <= 126; c++) ASCII_CLASS[c] = CC_PUNCT;

const NON_ASCII_CLASS = new Map();
const RE_NON_ASCII_SPACE = /\s/;
const RE_NON_ASCII_PUNCT = /[\p{P}\p{S}]/u;

function classOfCodePoint(cp) {
  let v = NON_ASCII_CLASS.get(cp);
  if (v === undefined) {
    const ch = String.fromCodePoint(cp);
    v = RE_NON_ASCII_SPACE.test(ch) ? CC_SPACE
      : (RE_NON_ASCII_PUNCT.test(ch) ? CC_PUNCT : CC_OTHER);
    NON_ASCII_CLASS.set(cp, v);
  }
  return v;
}

// Class of the code point starting at i (past the end counts as space).
function classAt(s, i) {
  if (i >= s.length) return CC_SPACE;
  const c = s.charCodeAt(i);
  if (c < 128) return ASCII_CLASS[c];
  return classOfCodePoint(s.codePointAt(i));
}

// Class of the code point ending just before i (i == 0 counts as space).
function classBefore(s, i) {
  if (i <= 0) return CC_SPACE;
  const c = s.charCodeAt(i - 1);
  if (c < 128) return ASCII_CLASS[c];
  if (c >= 0xDC00 && c <= 0xDFFF && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) {
      return classOfCodePoint(0x10000 + ((hi - 0xD800) << 10) + (c - 0xDC00));
    }
  }
  return classOfCodePoint(c);
}

function isWordChar(c) { // [A-Za-z0-9_]
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
function isHexDigit(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
function hexVal(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  return c - 87;
}
function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Whether s contains a non-whitespace char at or after i.
function hasNonWhitespaceAfter(s, i) {
  for (let k = i; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10 || c === 13) continue;
    if (c > 127 && classOfCodePoint(s.codePointAt(k)) === CC_SPACE) {
      if (c >= 0xD800 && c <= 0xDBFF) k++;
      continue;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '&': '&amp;' };
const RE_NEEDS_FULL_ESCAPE = /[&<>"']/;

// Escape every one of & < > " ' (code spans/blocks, image alt text).
function escapeFull(s) {
  if (!RE_NEEDS_FULL_ESCAPE.test(s)) return s;
  return s.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

// Text escape (marked's escape with encode=false): valid entity references
// are decoded (numeric) or passed through (named); bare & < > " ' escaped.
function escapeText(s) {
  let special = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { special = true; break; }
  }
  if (!special) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const nxt = s.charCodeAt(i + 1);
      if (nxt === 35) { // &#...
        let j = i + 2;
        let hex = false;
        if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
        const maxD = hex ? 6 : 7;
        let val = 0, digits = 0;
        while (digits < maxD) {
          const d = s.charCodeAt(j);
          if (hex ? isHexDigit(d) : (d >= 48 && d <= 57)) {
            val = val * (hex ? 16 : 10) + (hex ? hexVal(d) : d - 48);
            j++; digits++;
          } else break;
        }
        if (digits > 0 && s.charCodeAt(j) === 59) { // ;
          out += s.slice(last, i);
          if (val === 0 || val > 0x10FFFF || (val >= 0xD800 && val <= 0xDFFF)) out += '\uFFFD';
          else {
            const ch = String.fromCodePoint(val);
            out += ESCAPE_MAP[ch] || ch;
          }
          i = j;
          last = j + 1;
          continue;
        }
      } else {
        let j = i + 1;
        while (j < s.length && isWordChar(s.charCodeAt(j))) j++;
        if (j > i + 1 && s.charCodeAt(j) === 59) { // &word; — pass through
          i = j;
          continue;
        }
      }
      out += s.slice(last, i) + '&amp;';
      last = i + 1;
    } else if (c === 60) { out += s.slice(last, i) + '&lt;'; last = i + 1; }
    else if (c === 62) { out += s.slice(last, i) + '&gt;'; last = i + 1; }
    else if (c === 34) { out += s.slice(last, i) + '&quot;'; last = i + 1; }
    else if (c === 39) { out += s.slice(last, i) + '&#39;'; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Attribute escape (href/title): & escaped unless part of a valid entity
// reference (named or numeric, passed through as-is, NOT decoded).
function escapeAttr(s) {
  let special = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { special = true; break; }
  }
  if (!special) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const nxt = s.charCodeAt(i + 1);
      let entity = false;
      if (nxt === 35) { // &#...
        let j = i + 2;
        let hex = false;
        if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
        const maxD = hex ? 6 : 7;
        let digits = 0;
        while (digits < maxD) {
          const d = s.charCodeAt(j);
          if (hex ? isHexDigit(d) : (d >= 48 && d <= 57)) { j++; digits++; } else break;
        }
        if (digits > 0 && s.charCodeAt(j) === 59) { entity = true; i = j; }
      } else {
        let j = i + 1;
        while (j < s.length && isWordChar(s.charCodeAt(j))) j++;
        if (j > i + 1 && s.charCodeAt(j) === 59) { entity = true; i = j; }
      }
      if (entity) continue;
      out += s.slice(last, i) + '&amp;';
      last = i + 1;
    } else if (c === 60) { out += s.slice(last, i) + '&lt;'; last = i + 1; }
    else if (c === 62) { out += s.slice(last, i) + '&gt;'; last = i + 1; }
    else if (c === 34) { out += s.slice(last, i) + '&quot;'; last = i + 1; }
    else if (c === 39) { out += s.slice(last, i) + '&#39;'; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}

// ---------------------------------------------------------------------------
// URLs and labels
// ---------------------------------------------------------------------------

// marked's cleanUrl: encodeURI, %25 back to %, no scheme filtering.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (_e) {
    return null;
  }
}

// marked's label normalization: trim, collapse whitespace, lower/upper/lower.
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove backslashes before ASCII punctuation (marked's anyPunctuation).
function unescapePunct(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let last = 0;
  for (let k = 0; k < s.length; k++) {
    if (s.charCodeAt(k) === 92 && k + 1 < s.length && isAsciiPunct(s.charCodeAt(k + 1))) {
      out += s.slice(last, k);
      last = k + 1;
      k++;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

function isAsciiPunct(c) {
  return c < 128 && ASCII_CLASS[c] === CC_PUNCT;
}

// Count backslashes immediately before position i in s.
function countBackslashesBefore(s, i) {
  let c = 0;
  let j = i - 1;
  while (j >= 0 && s.charCodeAt(j) === 92) { c++; j--; }
  return c;
}

// ---------------------------------------------------------------------------
// Marked's emStrong masking (the ze() last-closer gate)
// ---------------------------------------------------------------------------
// Before lexing inline content, marked masks code spans, link labels and
// HTML tags in a COPY of the source, then records the last index at which
// each delimiter char could close. An opener with no possible closer at or
// after it never forms emphasis. The masking regexes can OVER-match when
// backtick runs are mismatched, hiding delimiters that sit outside any
// code span — a marked quirk this must replicate (a backtick label plus a
// later code span can hide a `_` closer, so `_issue table_` stays literal).

const RE_MASK_REFLINK = new RegExp("!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()", 'g');
const RE_MASK_ANYPUNCT = new RegExp("(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])", 'gu');
const RE_MASK_BLOCKSKIP = new RegExp("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", 'g');
const RE_BACKTICK_G = new RegExp(String.fromCharCode(96), 'g');

// marked's linkInText: does text contain a link (inline or reflink)
// whose label does not itself contain a link? Used by the mask
// replacement to decide whether to recurse into a reflink label.
function linkInText(e, refs) {
  if (!e.includes('[')) return false;
  RE_MASK_BLOCKSKIP.lastIndex = 0;
  let m;
  while ((m = RE_MASK_BLOCKSKIP.exec(e)) !== null) {
    // A blockSkip match starting with `[` is an inline link (code spans
    // start with backtick, HTML with `<`).
    if (m[0].charCodeAt(0) === 91 && e.charAt(m.index - 1) !== '!') return true;
  }
  RE_MASK_REFLINK.lastIndex = 0;
  while ((m = RE_MASK_REFLINK.exec(e)) !== null) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (s.charAt(0) === '!' || !refs.has(normalizeLabel(s.slice(r + 1, -1)))) continue;
    if (r > 1 && linkInText(s.slice(1, r - 1), refs)) continue;
    return true;
  }
  return false;
}

// marked's mask replacement: a resolving reflink is masked whole, UNLESS
// its label contains a link — then only the ref part is masked and the
// label is recursed into (so delimiters in the label stay visible to the
// emStrong scan).
function reflinkMaskReplace(m, refs) {
  const o = m.lastIndexOf('[');
  if (o === -1) return m;
  if (!refs.has(normalizeLabel(m.slice(o + 1, -1)))) return m;
  if (o > 1 && m.charAt(0) !== '!') {
    const label = m.slice(1, o - 1);
    if (linkInText(label, refs)) {
      RE_MASK_REFLINK.lastIndex = 0;
      const maskedLabel = label.replace(RE_MASK_REFLINK, (x) => reflinkMaskReplace(x, refs));
      return '[' + maskedLabel + '][' + 'a'.repeat(m.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(m.length - 2) + ']';
}

// Mask a source string the way marked's Lexer does. refs is the
// document's link-reference map (normalized label -> ref).
function maskEmStrongSource(src, refs) {
  let t = src;
  if (refs && src.indexOf('[') !== -1) {
    RE_MASK_REFLINK.lastIndex = 0;
    t = t.replace(RE_MASK_REFLINK, (m) => reflinkMaskReplace(m, refs));
  }
  RE_MASK_ANYPUNCT.lastIndex = 0;
  t = t.replace(RE_MASK_ANYPUNCT, (n, s, r) =>
    r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(RE_BACKTICK_G, '+') + s : n);
  RE_MASK_BLOCKSKIP.lastIndex = 0;
  t = t.replace(RE_MASK_BLOCKSKIP, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(Math.max(0, n.length - o - 2)) + ']';
  });
  return t;
}

// marked's fe(): last index at which each delimiter could close — a run
// whose preceding char is not whitespace. Returns {42, 95, 126} (-1 none).
function lastCloserIndices(masked) {
  const idx = { 42: -1, 95: -1, 126: -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked.charCodeAt(s);
    if (r !== 42 && r !== 95 && r !== 126) continue;
    const o = s === 0 ? 10 : masked.charCodeAt(s - 1);
    let i = s + 1;
    while (i < n && masked.charCodeAt(i) === r) i++;
    if (o !== 32 && o !== 9 && o !== 10 && o !== 13 && o !== 12) idx[r] = s;
    s = i - 1;
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Inline helpers: HTML tags and autolinks
// ---------------------------------------------------------------------------

// HTML block tag names (CommonMark condition 6 list) — also used by the
// block parser. Lowercase for comparison.
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'meta', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param',
  'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'title', 'tr', 'track', 'ul',
]);

const SCRIPT_PRE_STYLE = new Set(['script', 'pre', 'style', 'textarea']);

// Try to match an inline HTML tag at s[i] (s[i] === '<').
// Returns the end index (exclusive) or -1. Mirrors marked's inline.tag:
// comment, PI, declaration, CDATA, open/close tag with valid attr grammar.
function matchHtmlTag(s, i) {
  const n = s.length;
  if (i + 1 >= n) return -1;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 33) { // !
    if (s.charCodeAt(i + 2) === 45 && s.charCodeAt(i + 3) === 45) { // <!--
      // <!--> and <!---> are complete comments.
      if (s.charCodeAt(i + 4) === 62) return i + 5;
      if (s.charCodeAt(i + 4) === 45 && s.charCodeAt(i + 5) === 62) return i + 6;
      const end = s.indexOf('-->', i + 4);
      return end === -1 ? -1 : end + 3;
    }
    if (s.charCodeAt(i + 2) === 91) { // <![CDATA[
      if (s.startsWith('[CDATA[', i + 2)) {
        const end = s.indexOf(']]>', i + 9);
        return end === -1 ? -1 : end + 3;
      }
      return -1;
    }
    // <!A — declaration: <! + letter + [^>]* >
    const c2 = s.charCodeAt(i + 2);
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) {
      const end = s.indexOf('>', i + 3);
      return end === -1 ? -1 : end + 1;
    }
    return -1;
  }
  if (c1 === 63) { // <? — PI: up to ?>
    const end = s.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  if (c1 === 47) { // </ — close tag: </name\s*> (no space after /)
    const m = /^[A-Za-z][A-Za-z0-9-]*/.exec(s.slice(i + 2));
    if (!m) return -1;
    let j = i + 2 + m[0].length;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 13) j++;
      else break;
    }
    if (j < n && s.charCodeAt(j) === 62) return j + 1;
    return -1;
  }
  // Open tag: < name (attr)* /? >
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) return -1;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  // Attribute loop
  for (;;) {
    let k = j;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c === 13) k++;
      else break;
    }
    if (k >= n) return -1;
    const c = s.charCodeAt(k);
    if (c === 62) return k + 1; // >
    if (c === 47) { // / — must be followed by >
      if (s.charCodeAt(k + 1) === 62) return k + 2;
      return -1;
    }
    if (k === j) return -1; // attribute must be preceded by whitespace
    // attribute name: [A-Za-z_:][A-Za-z0-9_.:-]*
    const a0 = s.charCodeAt(k);
    if (!((a0 >= 65 && a0 <= 90) || (a0 >= 97 && a0 <= 122) || a0 === 95 || a0 === 58)) return -1;
    j = k + 1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    // optional = value
    let m = j;
    while (m < n) {
      const d = s.charCodeAt(m);
      if (d === 32 || d === 9 || d === 10 || d === 13) m++;
      else break;
    }
    if (m < n && s.charCodeAt(m) === 61) { // =
      m++;
      while (m < n) {
        const d = s.charCodeAt(m);
        if (d === 32 || d === 9 || d === 10 || d === 13) m++;
        else break;
      }
      if (m >= n) return -1;
      const q = s.charCodeAt(m);
      if (q === 34 || q === 39) { // quoted value
        const end = s.indexOf(String.fromCharCode(q), m + 1);
        if (end === -1) return -1;
        j = end + 1;
      } else { // unquoted value: [^\s"'=<>`/]+
        let e = m;
        while (e < n) {
          const d = s.charCodeAt(e);
          if (d === 32 || d === 9 || d === 10 || d === 13 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          e++;
        }
        if (e === m) return -1;
        j = e;
      }
    }
    // No value: j stays right after the name so the next iteration's
    // whitespace scan finds the separating whitespace.
  }
}

// Try to match an autolink <...> at s[i] (s[i] === '<').
// Returns {end, href, text} or null. Scheme: [A-Za-z][A-Za-z0-9.+-]{1,31}:
// followed by [^\s<>]*; email: local@domain with at least one dot.
function matchAutolink(s, i) {
  const n = s.length;
  const gt = s.indexOf('>', i + 1);
  if (gt === -1) return null;
  const inner = s.slice(i + 1, gt);
  if (inner.length === 0) return null;
  // No whitespace, control chars, or '<' allowed inside.
  if (/\s/.test(inner)) return null;
  for (let k = 0; k < inner.length; k++) {
    const c = inner.charCodeAt(k);
    if (c < 32 || c === 60) return null;
  }
  const colon = inner.indexOf(':');
  if (colon > 0) {
    // scheme autolink: scheme = [A-Za-z][A-Za-z0-9.+-]{1,31}
    const scheme = inner.slice(0, colon);
    if (scheme.length >= 2 && scheme.length <= 32) {
      const c0 = scheme.charCodeAt(0);
      if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
        let ok = true;
        for (let k = 1; k < scheme.length; k++) {
          const d = scheme.charCodeAt(k);
          if (!((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 46 || d === 43 || d === 45)) { ok = false; break; }
        }
        if (ok) return { end: gt + 1, href: inner, text: inner, mailto: false };
      }
    }
  }
  // email autolink — domain must have at least one dot
  const at = inner.indexOf('@');
  if (at > 0) {
    const local = inner.slice(0, at);
    const domain = inner.slice(at + 1);
    let ok = true;
    for (let k = 0; k < local.length; k++) {
      const d = local.charCodeAt(k);
      if (!((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) ||
            d === 46 || d === 33 || d === 35 || d === 36 || d === 37 || d === 38 ||
            d === 39 || d === 42 || d === 43 || d === 47 || d === 61 || d === 63 ||
            d === 94 || d === 95 || d === 96 || d === 123 || d === 124 || d === 125 || d === 126 || d === 45)) { ok = false; break; }
    }
    if (ok) {
      const labels = domain.split('.');
      if (labels.length < 2) ok = false;
      for (const lab of labels) {
        if (lab.length === 0 || lab.length > 63) { ok = false; break; }
        const f = lab.charCodeAt(0), l = lab.charCodeAt(lab.length - 1);
        if (!((f >= 65 && f <= 90) || (f >= 97 && f <= 122) || (f >= 48 && f <= 57))) { ok = false; break; }
        if (!((l >= 65 && l <= 90) || (l >= 97 && l <= 122) || (l >= 48 && l <= 57))) { ok = false; break; }
        for (let k = 1; k < lab.length - 1; k++) {
          const d = lab.charCodeAt(k);
          if (!((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45)) { ok = false; break; }
        }
        if (!ok) break;
      }
    }
    if (ok) return { end: gt + 1, href: 'mailto:' + inner, text: inner, mailto: true };
  }
  return null;
}

// Match a GFM email address starting at s[i] (bare email or after
// mailto:/xmpp:). Returns the end index (exclusive) or -1.
// email = [A-Za-z0-9._+-]+ @ [A-Za-z0-9-_]+ (?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+ (?![\w-])
function matchGfmEmail(s, i, allowTrailingUnderscore) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const d = s.charCodeAt(j);
    if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) ||
        d === 46 || d === 95 || d === 43 || d === 45) j++;
    else break;
  }
  if (j === i || j >= n || s.charCodeAt(j) !== 64) return -1; // need @
  j++; // @
  // first domain label: [A-Za-z0-9-_]+
  const labStart = j;
  while (j < n) {
    const d = s.charCodeAt(j);
    if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45 || d === 95) j++;
    else break;
  }
  if (j === labStart) return -1;
  // one or more .label where label = [A-Za-z0-9-_]*[A-Za-z0-9]
  let dots = 0;
  while (j < n && s.charCodeAt(j) === 46) {
    let k = j + 1;
    while (k < n) {
      const d = s.charCodeAt(k);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45 || d === 95) k++;
      else break;
    }
    // label must be non-empty and end alnum
    if (k === j + 1) break;
    const last = s.charCodeAt(k - 1);
    if (!((last >= 65 && last <= 90) || (last >= 97 && last <= 122) || (last >= 48 && last <= 57))) {
      // label ends with - or _ : back off to the last alnum
      let m = k - 1;
      while (m > j + 1) {
        const d = s.charCodeAt(m - 1);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57)) break;
        m--;
      }
      if (m === j + 1) break;
      k = m;
    }
    j = k;
    dots++;
  }
  if (dots === 0) return -1;
  // (?![\w-]) — but a trailing `_` is OK if it's an emphasis closer:
  // marked lexes emphasis before autolinks, so inside `_..._` the
  // email never sees the closing `_`.
  if (j < n) {
    const d = s.charCodeAt(j);
    if (d === 95 && allowTrailingUnderscore) return j;
    if (isWordChar(d) || d === 45) return -1;
  }
  return j;
}

// Match a GFM extended autolink starting at s[i]. The caller decides
// whether position i is eligible (preceding-char rules). Returns
// {end, href, text} or null. Alternatives (in marked's order):
//   1. mailto:email / xmpp:email(/path)?
//   2. (http|https|ftp):// or www. + domain + [^\s<]* (backpedalled)
//   3. bare email
function matchGfmAutolink(s, i, allowTrailingUnderscore) {
  const n = s.length;
  const c = s.charCodeAt(i);
  // Alternative 1: mailto: / xmpp: (case-sensitive in marked's regex)
  if (c === 109 && s.startsWith('mailto:', i)) { // m
    const e = matchGfmEmail(s, i + 7, allowTrailingUnderscore);
    if (e !== -1) return { end: e, href: s.slice(i, e), text: s.slice(i, e) };
  }
  if (c === 120 && s.startsWith('xmpp:', i)) { // x
    const e = matchGfmEmail(s, i + 5, allowTrailingUnderscore);
    if (e !== -1) {
      let end = e;
      if (s.charCodeAt(end) === 47) { // optional /[A-Za-z0-9@.]+
        let p = end + 1;
        while (p < n) {
          const d = s.charCodeAt(p);
          if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 64 || d === 46) p++;
          else break;
        }
        if (p > end + 1) end = p;
      }
      return { end, href: s.slice(i, end), text: s.slice(i, end) };
    }
  }
  // Alternative 2: scheme:// or www.
  let prefixEnd = -1;
  let isWww = false;
  // Case-insensitive scheme check (marked's protocol regex is
  // case-insensitive via char classes).
  if (c === 104 || c === 72 || c === 102 || c === 70) {
    const c1 = s.charCodeAt(i + 1) | 32, c2 = s.charCodeAt(i + 2) | 32, c3 = s.charCodeAt(i + 3) | 32;
    if (c1 === 116 && c2 === 116 && c3 === 112) { // ttp
      if (s.charCodeAt(i + 4) === 58 && s.charCodeAt(i + 5) === 47 && s.charCodeAt(i + 6) === 47) prefixEnd = i + 7;
      else if ((s.charCodeAt(i + 4) | 32) === 115 && s.charCodeAt(i + 5) === 58 && s.charCodeAt(i + 6) === 47 && s.charCodeAt(i + 7) === 47) prefixEnd = i + 8;
    } else if ((c === 102 || c === 70) && c1 === 116 && c2 === 112 &&
               s.charCodeAt(i + 3) === 58 && s.charCodeAt(i + 4) === 47 && s.charCodeAt(i + 5) === 47) {
      prefixEnd = i + 6;
    }
  }
  if (prefixEnd === -1 && c === 119 && s.startsWith('www.', i)) {
    prefixEnd = i + 4;
    isWww = true;
  }
  if (prefixEnd !== -1) {
    // domain: (?:[a-zA-Z0-9-]+\.?)+
    let j = prefixEnd;
    let matched = false;
    for (;;) {
      const labStart = j;
      while (j < n) {
        const d = s.charCodeAt(j);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45) j++;
        else break;
      }
      if (j === labStart) break;
      matched = true;
      if (j < n && s.charCodeAt(j) === 46) j++; // optional .
      else break;
    }
    if (matched) {
      // tail: [^\s<]*
      let end = j;
      while (end < n) {
        const d = s.charCodeAt(end);
        if (d === 32 || d === 9 || d === 10 || d === 13 || d === 60) break;
        if (d > 127 && classOfCodePoint(s.codePointAt(end)) === CC_SPACE) break;
        end++;
      }
      end = backpedalUrl(s, i, end);
      if (end > prefixEnd) {
        const text = s.slice(i, end);
        return { end, href: isWww ? 'http://' + text : text, text };
      }
      return null;
    }
    return null;
  }
  // Alternative 3: bare email
  if (isWordChar(c) || c === 46 || c === 43 || c === 45) {
    const e = matchGfmEmail(s, i, allowTrailingUnderscore);
    if (e !== -1) {
      const text = s.slice(i, e);
      return { end: e, href: 'mailto:' + text, text };
    }
  }
  return null;
}

// Backpedal a URL end per marked's _backpedal regex:
//   /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/
// applied repeatedly until stable (marked's url tokenizer loops it). This
// is a FORWARD regex match, not a backward trim: a `)` in the middle is
// kept (matched by the punct alternative), and a trailing `)` inside a
// `(...)` group is kept too. A backward paren-count trim is NOT equivalent.
function isBackpedalPunct(c) {
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
    c === 42 || c === 95 || c === 39 || c === 34 || c === 126 || c === 41;
}

// One application of the _backpedal match: longest valid prefix of s[start, end).
function backpedalOnce(s, start, end) {
  let i = start;
  let lastGood = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === 40) { // ( — try \([^)]*\)
      let j = i + 1;
      while (j < end && s.charCodeAt(j) !== 41) j++;
      if (j < end) { i = j + 1; lastGood = i; continue; }
      break; // no closing ) — no alternative matches (
    }
    if (c === 38) { // & — &(?!word;$) — word; only blocks at the URL end
      let j = i + 1;
      while (j < end && isAlnum(s.charCodeAt(j))) j++;
      if (j < end && s.charCodeAt(j) === 59 && j + 1 === end) break;
      i++;
      lastGood = i;
      continue;
    }
    if (isBackpedalPunct(c)) { // [?!.,:;*_'\"~)]+(?!$)
      let j = i;
      while (j < end && isBackpedalPunct(s.charCodeAt(j))) j++;
      if (j === end) {
        // Run reaches the end: the regex backtracks the + to leave one
        // char, then the next chunk fails — the match ends at end-1.
        lastGood = end - 1;
        break;
      }
      i = j;
      lastGood = i;
      continue;
    }
    // [^?!.,:;*_'\"~()&]+ — normal chars.
    let j = i;
    while (j < end) {
      const d = s.charCodeAt(j);
      if (d === 40 || d === 38 || isBackpedalPunct(d)) break;
      j++;
    }
    i = j;
    lastGood = i;
  }
  return lastGood;
}

function backpedalUrl(s, start, end) {
  let e = end;
  for (;;) {
    const ne = backpedalOnce(s, start, e);
    if (ne === e) return e;
    e = ne;
    if (e <= start) return e;
  }
}

// Decode numeric character references only: &#123; / &#x1F; — named
// entities are left as-is. Used for plain-text mode.
function decodeNumericRefs(s) {
  if (s.indexOf('&#') === -1) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 38 && s.charCodeAt(i + 1) === 35) {
      let j = i + 2;
      let hex = false;
      if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
      const maxD = hex ? 6 : 7;
      let val = 0, digits = 0;
      while (digits < maxD) {
        const d = s.charCodeAt(j);
        if (hex ? isHexDigit(d) : (d >= 48 && d <= 57)) {
          val = val * (hex ? 16 : 10) + (hex ? hexVal(d) : d - 48);
          j++; digits++;
        } else break;
      }
      if (digits > 0 && s.charCodeAt(j) === 59) {
        out += s.slice(last, i);
        if (val === 0 || val > 0x10FFFF || (val >= 0xD800 && val <= 0xDFFF)) out += '\uFFFD';
        else if (val === 38) out += '&amp;';
        else out += String.fromCodePoint(val);
        i = j;
        last = j + 1;
      }
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Find the end (exclusive) of a code span starting at s[i] (a backtick
// run of length runLen), searching only up to `limit`. Returns -1 if
// none. The closing run must be a maximal run of exactly runLen
// backticks, and the content must be non-empty.
function findCodeSpanEnd(s, i, runLen, limit) {
  let j = i + runLen;
  for (;;) {
    const bt = s.indexOf('`', j);
    if (bt === -1 || bt >= limit) return -1;
    let k = bt;
    while (k < limit && s.charCodeAt(k) === 96) k++;
    const len = k - bt;
    if (len === runLen && bt > i + runLen) {
      if (k >= limit || s.charCodeAt(k) !== 96) return k;
      return -1;
    }
    j = k;
  }
}

// Process a code span's content: newlines -> spaces; if it has a
// non-space char and starts+ends with a space, strip one space each end.
function codeSpanContent(raw) {
  let n = raw.indexOf('\n') === -1 ? raw : raw.replace(/\n/g, ' ');
  if (n.length >= 2 && n.charCodeAt(0) === 32 && n.charCodeAt(n.length - 1) === 32) {
    let hasNonSpace = false;
    for (let k = 0; k < n.length; k++) {
      if (n.charCodeAt(k) !== 32) { hasNonSpace = true; break; }
    }
    if (hasNonSpace) n = n.substring(1, n.length - 1);
  }
  return n;
}

// Check whether a link with this label is blocked by an HTML tag/autolink
// starting inside the label but extending beyond it (marked's Be).
function labelBlockedByTag(s, labelStart, labelEnd) {
  let i = labelStart;
  while (i < labelEnd) {
    const c = s.charCodeAt(i);
    if (c === 92) { i += 2; continue; } // escape
    if (c === 96) { // backtick — skip a code span within the label
      let j = i;
      while (j < labelEnd && s.charCodeAt(j) === 96) j++;
      const runLen = j - i;
      const end = findCodeSpanEnd(s, i, runLen, labelEnd);
      if (end !== -1) { i = end; continue; }
      i = j;
      continue;
    }
    if (c !== 60) { i++; continue; } // not <
    const tagEnd = matchHtmlTag(s, i);
    if (tagEnd !== -1) {
      if (tagEnd > labelEnd) return true;
      i = tagEnd;
      continue;
    }
    const al = matchAutolink(s, i);
    if (al) {
      if (al.end > labelEnd) return true;
      i = al.end;
      continue;
    }
    i++;
  }
  return false;
}

// Validate a link label per marked's label regex: backticks are only
// allowed as complete code spans (any-length runs) or as 2+ backticks
// immediately before the closing `]`. A lone backtick (or an unmatched
// run) invalidates the whole label, so no link forms.
function isValidLinkLabel(s, labelStart, labelEnd) {
  let i = labelStart;
  while (i < labelEnd) {
    const c = s.charCodeAt(i);
    if (c === 91) { // [ — nested bracket: skip to its matching ]
      let depth = 1;
      i++;
      while (i < labelEnd && depth > 0) {
        const d = s.charCodeAt(i);
        if (d === 92) i += 2;
        else if (d === 91) { depth++; i++; }
        else if (d === 93) { depth--; i++; }
        else i++;
      }
      if (depth > 0) return false;
    } else if (c === 92) { // escape
      i += 2;
    } else if (c === 96) { // backtick run
      let j = i;
      while (j < labelEnd && s.charCodeAt(j) === 96) j++;
      const runLen = j - i;
      if (runLen >= 2 && j === labelEnd) { i = j; continue; }
      // Find a closing backtick run (any length) with no backticks between.
      let k = j;
      while (k < labelEnd && s.charCodeAt(k) !== 96) k++;
      if (k >= labelEnd) return false;
      let m = k;
      while (m < labelEnd && s.charCodeAt(m) === 96) m++;
      i = m;
    } else if (c === 93) { // ] inside a label
      return false;
    } else {
      i++;
    }
  }
  return true;
}

// Parse an inline link destination starting at s[i] (s[i] === '(').
// Returns {href, title, end} (end = index after the closing ')') or null.
function parseInlineDestination(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) j++;
    else break;
  }
  if (j >= n) return null;
  let href = '';
  let hrefEnd = j;
  if (s.charCodeAt(j) === 60) { // < — angle-bracketed destination
    let k = j + 1;
    let closed = false;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 92) { k += 2; continue; } // escape
      if (c === 10 || c === 60) break;
      if (c === 62) { closed = true; break; }
      k++;
    }
    if (!closed) return null;
    // the '>' must not be escaped (odd number of backslashes before it)
    if (countBackslashesBefore(s, k) % 2 === 1) return null;
    href = s.slice(j + 1, k);
    hrefEnd = k + 1;
  } else {
    // bare destination: maximal run of [^ \t\n\x00-\x1f]
    let k = j;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c < 32) break;
      k++;
    }
    href = s.slice(j, k);
    hrefEnd = k;
    if (href.length === 0) {
      // empty destination — only valid if immediately followed by ')'
      if (s.charCodeAt(k) !== 41) return null;
    }
  }
  // After the href: optional (whitespace + title), then whitespace*, then ')'.
  // Try the full-href parse first; if it fails, backtrack to the last ')'
  // inside a bare href.
  let title = '';
  let end = -1;
  {
    let k = hrefEnd;
    let p = k;
    let ws = 0, nl = 0;
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 32 || c === 9) { ws++; p++; }
      else if (c === 10) { nl++; ws++; p++; }
      else break;
    }
    if (nl <= 1 && p < n && s.charCodeAt(p) === 41 && ws >= 0) {
      end = p + 1;
    } else if (ws > 0 && nl <= 1) {
      const t = parseLinkTitle(s, p);
      if (t) {
        let q = t.end;
        while (q < n) {
          const c = s.charCodeAt(q);
          if (c === 32 || c === 9 || c === 10) q++;
          else break;
        }
        if (q < n && s.charCodeAt(q) === 41) {
          title = t.title;
          end = q + 1;
        }
      }
    }
  }
  if (end === -1) {
    // Backtrack: find the last ')' inside a bare href.
    if (s.charCodeAt(j) === 60) return null; // angle href can't backtrack
    const close = href.lastIndexOf(')');
    if (close === -1) return null;
    href = href.slice(0, close);
    title = '';
    end = j + close + 1;
  }
  // The closing ')' must not be escaped.
  if (countBackslashesBefore(s, end - 1) % 2 === 1) return null;
  // Paren-balance check on a bare href (marked's ke).
  if (s.charCodeAt(j) !== 60) {
    const bal = parenBalance(href);
    if (bal === -2) return null;
    if (bal >= 0) {
      // unmatched ')' at index bal — truncate href there, drop title.
      href = href.slice(0, bal);
      title = '';
      end = j + bal + 1;
    }
  }
  href = unescapePunct(href);
  if (title) title = unescapePunct(title);
  return { href, title, end };
}

// Paren balance of a bare destination: -1 if no parens or balanced,
// -2 if more '(' than ')', else the index of the first unmatched ')'.
function parenBalance(href) {
  let depth = 0;
  let hasParen = false;
  for (let k = 0; k < href.length; k++) {
    const c = href.charCodeAt(k);
    if (c === 92) { k++; continue; }
    if (c === 40) { depth++; hasParen = true; }
    else if (c === 41) {
      hasParen = true;
      if (depth === 0) return k;
      depth--;
    }
  }
  if (!hasParen) return -1;
  return depth === 0 ? -1 : -2;
}

// Parse a link title starting at s[i]: "..." or '...' or (...), with
// backslash escapes. Returns {title, end} or null.
function parseLinkTitle(s, i) {
  const n = s.length;
  const q = s.charCodeAt(i);
  let close;
  if (q === 34) close = 34;       // "
  else if (q === 39) close = 39;  // '
  else if (q === 40) close = 41;  // ( ... )
  else return null;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === close) return { title: s.slice(i + 1, j), end: j + 1 };
    if (close === 41 && c === 40) return null; // ( title can't contain (
    j++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main inline parser
// ---------------------------------------------------------------------------
//
// Two-phase design (the standard CommonMark inline algorithm, tuned to
// marked's quirks):
//   Phase 1: single left-to-right scan. Text runs, code spans, escapes,
//   HTML tags, autolinks and (eager) GFM autolinks become parts
//   immediately. Delimiter runs (* _ ~) and brackets ([ ![) become marker
//   objects kept in linked lists. Links/images resolve when ']' is hit.
//   Phase 2: emphasis resolution walks the delimiter list opener-first,
//   as marked's emStrong does (after links resolve, with stack_bottom at
//   link boundaries).
//
// Parts array entries: strings, or marker objects:
//   Delim:   {k:1, ch, n, off, open, close, prev, next, ot, ct, pi, pos}
//     ot = accumulated open tags (newest first), ct = close tags (in
//     order), pi = index of this marker's slot in the parts array.
//   Bracket: {k:2, img, pi, bottom, links, inRaw, inLink, labelStart}
//     bottom = delimiter marker that was the list tail when '[' opened.
//   GFM autolink: {k:3, raw, html} — revertible inside links.
//   HTML tag: {k:4, html, name, open}

// The `inLink` state leaks across blocks in marked: an unclosed `<a>`
// tag in one paragraph suppresses GFM autolinks in all later blocks
// until a `</a>` appears. Reset per document in parse().
let gInLink = false;

function parseInline(s, refs, plain) {
  const n = s.length;
  const parts = [];
  let delimHead = null;
  let delimTail = null;
  // Cached: does the live delimiter list contain an open `_`? (A
  // trailing `_` after an email is OK then.) Set on push, recomputed on
  // truncate; avoids an O(d) scan per scanned char.
  let hasOpenUnderscore = false;
  const brackets = [];
  let linksEmitted = 0;
  let inLink = plain ? false : gInLink;
  let inRaw = false;
  let i = 0;
  let textStart = 0;

  function flushText(end) {
    if (end > textStart) {
      const raw = s.slice(textStart, end);
      parts.push(plain ? (inRaw ? raw : decodeNumericRefs(raw))
                       : (inRaw ? raw : escapeText(raw)));
    }
    textStart = end;
  }

  function pushDelim(ch, runLen, pos, prevClass, nextClass) {
    const leftFlanking = nextClass !== CC_SPACE &&
      (nextClass !== CC_PUNCT || prevClass === CC_SPACE || prevClass === CC_PUNCT);
    const rightFlanking = prevClass !== CC_SPACE &&
      (prevClass !== CC_PUNCT || nextClass === CC_SPACE || nextClass === CC_PUNCT);
    let open, close;
    if (ch === 95) { // _
      open = leftFlanking && (!rightFlanking || prevClass === CC_PUNCT);
      close = rightFlanking && (!leftFlanking || nextClass === CC_PUNCT);
    } else { // * and ~
      open = leftFlanking;
      close = rightFlanking;
    }
    const m = {
      k: 1, ch, n: runLen, off: 0, open, close, prev: delimTail, next: null,
      ot: '', ct: '', pi: parts.length, pos,
    };
    if (delimTail) delimTail.next = m;
    else delimHead = m;
    delimTail = m;
    if (ch === 95 && open) hasOpenUnderscore = true;
    parts.push(m);
  }

  // Previous-char class for a delimiter at i, with marked's quirk: if the
  // previous char is '_' belonging to a delimiter run that cannot open,
  // marked's text tokenizer consumed that run as text and its "previous
  // char" tracking still points before the run.
  function prevClassForDelim(pos) {
    if (pos > 0 && s.charCodeAt(pos - 1) === 95 && delimTail &&
        delimTail.ch === 95 && delimTail.pos + delimTail.n === pos && !delimTail.open) {
      return classBefore(s, delimTail.pos);
    }
    return classBefore(s, pos);
  }

  // Opener-driven emphasis/del resolution (marked's emStrong/del).
  // Unlike cmark's closer-driven stack, marked decides at each OPENER by
  // scanning forward for a closer, accounting for intervening openers
  // (which raise the needed count) and the %3 rule (which skips ambiguous
  // closers). The inner text is then resolved recursively, so delimiters
  // inside a formed em/strong can never match delimiters outside it.
  //
  // The ze() gate (masking + lastCloserIndices) is computed lazily once
  // per parseInline call: an opener with no possible closer at/after it
  // in the MASKED source never forms emphasis. The mask is computed on
  // the lexed substring: the whole string at top level, the label
  // substring inside a link (marked re-masks per recursive inlineTokens
  // call). Indices are offset back to full-string coordinates. Cached
  // for the top-level range only. The mask ALSO gates the scan itself:
  // marked's emStrong scans the MASKED source, so delimiters hidden by
  // the mask are invisible to the scan entirely, not just to the ze()
  // check.
  let maskCache = null;
  function getMask(lo, hi) {
    if (lo === 0 && hi === n && maskCache !== null) return maskCache;
    const masked = maskEmStrongSource(s.slice(lo, hi), refs);
    const idx = lastCloserIndices(masked);
    if (idx[42] !== -1) idx[42] += lo;
    if (idx[95] !== -1) idx[95] += lo;
    if (idx[126] !== -1) idx[126] += lo;
    const res = { masked, idx, lo };
    if (lo === 0 && hi === n) maskCache = res;
    return res;
  }

  // Resolve emphasis/del for delimiters after stackBottom (exclusive).
  // (maskLo, maskHi) bounds the substring the ze() gate masks.
  function processEmphasis(stackBottom, maskLo, maskHi) {
    const delims = [];
    let d = stackBottom ? stackBottom.next : delimHead;
    while (d) { delims.push(d); d = d.next; }
    if (delims.length === 0) return;
    const mask = getMask(maskLo, maskHi);
    // Drop delimiters hidden by the mask (marked scans the masked
    // source — they can neither open nor close). They stay literal.
    const vis = [];
    for (let k = 0; k < delims.length; k++) {
      const dm = delims[k];
      const mp = dm.pos - mask.lo;
      if (mp >= 0 && mp < mask.masked.length &&
          mask.masked.charCodeAt(mp) === dm.ch) {
        vis.push(dm);
      }
    }
    if (vis.length === 0) return;
    resolveRange(vis, 0, vis.length - 1, mask.idx);
  }

  // Resolve delimiters in delims[lo..hi] (inclusive), leftmost opener
  // first. Matches are applied outermost-first, so open tags append to
  // `ot` and close tags prepend to `ct`.
  function resolveRange(delims, lo, hi, closerIdx) {
    let i = lo;
    while (i <= hi) {
      const opener = delims[i];
      const effN = opener.n - opener.off;
      if (effN <= 0 || !opener.open) { i++; continue; }
      // ze() gate: no possible closer at/after the opener in the masked
      // source means this opener can never match (marked returns early).
      if (closerIdx[opener.ch] < opener.pos + opener.off + effN) { i++; continue; }
      const match = findEmphasisMatch(delims, i, hi, opener);
      if (!match) {
        // No match: marked's lexer advances ONE char and retries
        // emStrong at the next position (the run shortens by one from
        // the front). Peel one delimiter and retry; when only one is
        // left, it's literal.
        if (effN > 1) {
          opener.off++;
          parts[opener.pi] = delimPartString(opener);
          continue;
        }
        i++;
        continue;
      }
      const closer = delims[match.j];
      // Apply the pair FIRST (outermost-first tag order). Leftover
      // delimiters on either side pair up in turn (marked's recursive
      // lexing of the inner text does the same for ***foo***).
      let use = match.use;
      let first = true;
      for (;;) {
        const oN = opener.n - opener.off;
        const cN = closer.n - closer.off;
        if (use <= 0 || oN <= 0 || cN <= 0) break;
        let openTag, closeTag;
        if (opener.ch === 126) {
          openTag = plain ? '' : '<del>';
          closeTag = plain ? '' : '</del>';
        } else if (use === 2) {
          openTag = plain ? '' : '<strong>';
          closeTag = plain ? '' : '</strong>';
        } else {
          openTag = plain ? '' : '<em>';
          closeTag = plain ? '' : '</em>';
        }
        opener.n -= use;
        closer.n -= use;
        // First application: bUse-use closer delimiters are inside the
        // match but survive the slice — they sit before the close tag.
        // Leftover pairings consume from that inside pool.
        if (first && match.bUse !== undefined) {
          closer.inLeft = (closer.inLeft || 0) + match.bUse - use;
          first = false;
        } else if (!first) {
          closer.inLeft = Math.max(0, (closer.inLeft || 0) - use);
        }
        opener.ot = opener.ot + openTag;
        closer.ct = closeTag + closer.ct;
        parts[opener.pi] = delimPartString(opener);
        parts[closer.pi] = delimPartString(closer);
        if (opener.ch === 126) break; // del uses the whole run at once
        if (opener.n - opener.off <= 0 || closer.n - closer.off <= 0) break;
        // Leftover pair: same rule (odd min -> em, even min -> strong).
        use = Math.min(opener.n - opener.off, closer.n - closer.off) % 2 === 1 ? 1 : 2;
        if (use > opener.n - opener.off || use > closer.n - closer.off) use = 1;
      }
      // Then resolve the inner range INCLUDING the opener and closer
      // markers: their leftover delimiters are part of the inner text,
      // so an inner opener can pair with the closer's leftovers and the
      // opener's leftovers can pair with an inner closer. Inner
      // delimiters can't match outside this range.
      if (match.j > i) resolveRange(delims, i, match.j, closerIdx);
      // The opener's and closer's leftovers (if any) are inside the
      // formed pair — they never match a later closer. Always advance
      // past the closer.
      i = match.j + 1;
    }
  }

  // Marked's emStrong/del forward scan for the opener at delims[i].
  // Returns {j, use} (index of the closer, delimiters used per side) or
  // null. The scan walks the delimiter list (not the raw string):
  //   pure opener (open && !close)  -> m += b   (needs more closers)
  //   pure closer (close && !open)  -> m -= b
  //   ambiguous (open && close)     -> %3 check (or break if prev char
  //                                    is the same delimiter), else m -= b
  //   neither                       -> skipped (RDelim doesn't match it)
  // For `*`, runs inside a `__...__` pair are hidden (the RDelim skip
  // pattern); for `_`, runs inside `**...**` are hidden.
  function findEmphasisMatch(delims, i, hi, opener) {
    const ch = opener.ch;
    const effPos = opener.pos + opener.off;
    const k = opener.n - opener.off; // effective run length
    const isDel = ch === 126;
    // y = run length incl. preceding same delimiters (back over the raw
    // string from the effective start); o = previous char is the same
    // delimiter.
    let y = k;
    let p = effPos;
    while (p > 0 && s.charCodeAt(p - 1) === ch) { y++; p--; }
    const o = effPos > 0 && s.charCodeAt(effPos - 1) === ch;
    // R = opener can close (marked's formula): non-space before AND
    // (punct after OR (* AND non-punct before)).
    const prevCls = classBefore(s, p);
    const nextCls = classAt(s, effPos + k);
    const R = !isDel && prevCls !== CC_SPACE &&
      (nextCls === CC_PUNCT || (ch === 42 && prevCls !== CC_PUNCT));
    let m = k;
    let f = 0;
    // Skip ranges for the RDelim skip pattern: [startPos, endPos) spans
    // between a double run of the other char and its closer.
    let skipUntil = -1;
    const otherCh = ch === 42 ? 95 : ch === 95 ? 42 : -1;
    for (let j = i + 1; j <= hi; j++) {
      const d = delims[j];
      const dN = d.n - d.off; // effective length
      if (dN <= 0) continue;
      if (otherCh !== -1 && d.ch === otherCh && dN >= 2 && d.open && skipUntil === -1) {
        // Possible skip-region opener: look for its closer (next double
        // run of the other char that can close). Same-char runs inside
        // the region are exactly what the skip pattern hides, so they
        // don't end the search.
        for (let e = j + 1; e <= hi; e++) {
          const dc = delims[e];
          if (dc.ch === otherCh && dc.n - dc.off >= 2 && dc.close) {
            skipUntil = dc.pos + dc.off;
            break;
          }
        }
        continue;
      }
      if (d.ch !== ch) continue;
      if (skipUntil !== -1) {
        if (d.pos + d.off < skipUntil) continue; // hidden by the skip pattern
        skipUntil = -1;
      }
      const b = dN;
      if (isDel) {
        if (b !== k) continue; // del requires equal lengths
        if (d.open && !d.close) { m += b; continue; }
        if (!d.open && !d.close) continue;
        m -= b;
        if (m > 0) continue;
        return { j, use: k };
      }
      if (d.open && !d.close) { m += b; continue; } // pure opener
      if (!d.open && !d.close) continue; // neither — not in RDelim
      // Closer (pure or ambiguous).
      if ((d.open && d.close) || R) {
        if (o && d.open && d.close) return null; // break: no match
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; } // %3 skip
      }
      m -= b;
      if (m > 0) continue;
      const bUse = Math.min(b, b + m + f);
      const use = Math.min(k, bUse) % 2 === 1 ? 1 : 2;
      return { j, use, bUse };
    }
    return null;
  }

  // Part order: close tags, peeled literal delimiters (from failed match
  // attempts — they sit BEFORE the em), open tags, remaining effective
  // delimiters (inside the em, after the open tag). `n` is the total
  // remaining count (reduced by matches only); `off` is the peeled
  // count; the effective run is `n - off` delimiters at `pos + off`.
  function delimPartString(m) {
    const ch = String.fromCharCode(m.ch);
    const peeled = m.off > 0 ? ch.repeat(m.off) : '';
    // `inLeft` delimiters of a closer sit INSIDE the em/strong (before
    // the close tag): marked's match includes bUse delimiters of the
    // closer run but the slice only removes `use`, so the bUse-use
    // front delimiters land in the inner text. The rest of the run
    // (never in the match) renders after the close tag.
    const total = m.n - m.off;
    const inL = Math.min(m.inLeft || 0, Math.max(0, total));
    const inStr = inL > 0 ? ch.repeat(inL) : '';
    const outStr = total > inL ? ch.repeat(total - inL) : '';
    return inStr + m.ct + peeled + m.ot + outStr;
  }

  // Finalize a delimiter marker's part (called for markers left in the
  // list at the end, and for markers inside a resolved link's label).
  function finalizeDelim(m) {
    parts[m.pi] = delimPartString(m);
  }

  function partToString(part) {
    if (typeof part === 'string') return part;
    if (part.k === 1) return delimPartString(part);
    if (part.k === 2) return part.img ? '![' : '[';
    if (part.k === 3) return part.html;
    return part.html; // k:4 tag
  }

  // Would the innermost bracket form a link if `]` were at closeIdx?
  // Mirrors tryLink's decision without side effects (used to bound
  // code spans and GFM autolinks inside a prospective label).
  function linkFormsAt(closeIdx) {
    if (brackets.length === 0) return false;
    const br = brackets[brackets.length - 1];
    const labelStart = br.labelStart;
    const labelEnd = closeIdx;
    if (!isValidLinkLabel(s, labelStart, labelEnd)) return false;
    if (labelBlockedByTag(s, labelStart, labelEnd)) return false;
    if (!br.img && linksEmitted > br.links) return false;
    const after = closeIdx + 1;
    if (after < n && s.charCodeAt(after) === 40) { // ( — inline link
      if (parseInlineDestination(s, after)) return true;
      return refs.has(normalizeLabel(s.slice(labelStart, labelEnd)));
    }
    if (after < n && s.charCodeAt(after) === 91) { // [ — full/collapsed ref
      let j = after + 1;
      let refEnd = -1;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c === 92) { j += 2; continue; }
        if (c === 91 || c === 93) {
          if (c === 93) refEnd = j;
          break;
        }
        if (c === 10) {
          let k = j + 1;
          while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
          if (k < n && s.charCodeAt(k) === 10) break;
          j = k;
          continue;
        }
        j++;
      }
      if (refEnd === -1) return false;
      const refText = s.slice(after + 1, refEnd);
      if (refText.length === 0) return refs.has(normalizeLabel(s.slice(labelStart, labelEnd)));
      if (/^\s*$/.test(refText)) return false;
      return refs.has(normalizeLabel(refText));
    }
    return refs.has(normalizeLabel(s.slice(labelStart, labelEnd)));
  }

  // Try to resolve a link/image at ']' (position closeIdx). Returns the
  // new index (after the consumed destination) or -1 if no link forms.
  function tryLink(closeIdx) {
    if (brackets.length === 0) return -1;
    const br = brackets[brackets.length - 1];
    const labelStart = br.labelStart;
    const labelEnd = closeIdx;
    // A label cannot contain a lone backtick: marked's label regex only
    // allows backticks as complete code spans or 2+ backticks right
    // before `]`.
    if (!isValidLinkLabel(s, labelStart, labelEnd)) {
      brackets.pop();
      return -1;
    }
    const after = closeIdx + 1;
    let href = null;
    let title = '';
    let end = -1;

    if (after < n && s.charCodeAt(after) === 40) { // ( — inline link
      const dest = parseInlineDestination(s, after);
      if (dest) {
        href = dest.href;
        title = dest.title;
        end = dest.end;
      } else {
        // Inline link failed — fall back to a shortcut reference link.
        // Marked's nolink regex has no (?!\() guard.
        const ref = refs.get(normalizeLabel(s.slice(labelStart, labelEnd)));
        if (ref) { href = ref.href; title = ref.title; end = after; }
      }
    } else if (after < n && s.charCodeAt(after) === 91) { // [ — full/collapsed ref
      // scan the ref: escapes, non-bracket chars, newlines (not blank lines)
      let j = after + 1;
      let refEnd = -1;
      let hasContent = false;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c === 92) { j += 2; hasContent = true; continue; }
        if (c === 91 || c === 93) {
          if (c === 93) refEnd = j;
          break;
        }
        if (c === 10) {
          // newline: allowed unless followed by a blank line
          let k = j + 1;
          while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
          if (k < n && s.charCodeAt(k) === 10) break; // blank line — invalid
          j = k;
          hasContent = true;
          continue;
        }
        hasContent = true;
        j++;
      }
      if (refEnd !== -1) {
        const refText = s.slice(after + 1, refEnd);
        // collapsed ref ([]) uses the label; empty/whitespace-only ref is
        // not a valid full ref (the regex's (?!\s*\]) guard).
        if (refText.length === 0) {
          const ref = refs.get(normalizeLabel(s.slice(labelStart, labelEnd)));
          if (ref) { href = ref.href; title = ref.title; end = refEnd + 1; }
        } else if (!/^\s*$/.test(refText)) {
          const ref = refs.get(normalizeLabel(refText));
          if (ref) { href = ref.href; title = ref.title; end = refEnd + 1; }
        }
      }
    } else {
      // shortcut ref
      const ref = refs.get(normalizeLabel(s.slice(labelStart, labelEnd)));
      if (ref) { href = ref.href; title = ref.title; end = after; }
    }

    if (href === null) {
      // No link — deactivate this bracket.
      brackets.pop();
      return -1;
    }
    // A link inside the label blocks an outer link (not an image).
    if (!br.img && linksEmitted > br.links) {
      brackets.pop();
      return -1;
    }
    // A tag/autolink starting inside the label but extending beyond it
    // blocks the link.
    if (labelBlockedByTag(s, labelStart, labelEnd)) {
      brackets.pop();
      return -1;
    }

    // Resolve emphasis inside the label, then finalize the label's
    // remaining delimiters and drop them from the delimiter list.
    // The ze() gate masks the label substring (marked re-masks per
    // recursive label lexing).
    processEmphasis(br.bottom, labelStart, labelEnd);
    let d = br.bottom ? br.bottom.next : delimHead;
    while (d) {
      finalizeDelim(d);
      d = d.next;
    }
    // Truncate the delimiter list at the bracket's bottom.
    delimTail = br.bottom;
    if (delimTail) delimTail.next = null;
    else delimHead = null;
    // Truncation may have removed the open `_` — recompute the flag.
    hasOpenUnderscore = false;
    for (let dd = delimHead; dd; dd = dd.next) {
      if (dd.ch === 95 && dd.open) { hasOpenUnderscore = true; break; }
    }

    // Revert GFM autolinks inside the label (marked parses link labels
    // with inLink=true, which suppresses them — but a </a> inside the
    // label re-enables them). Only for links in HTML mode.
    if (!plain && !br.img) {
      let labelInLink = true;
      for (let p = br.pi + 1; p < parts.length; p++) {
        const part = parts[p];
        if (part && typeof part === 'object') {
          if (part.k === 4) { // HTML tag
            if (part.name === 'a') labelInLink = part.open;
          } else if (part.k === 3) { // GFM autolink
            if (labelInLink) parts[p] = escapeText(part.raw);
          }
        }
      }
    }

    // Build the link/image part from the label's parts.
    let labelHtml = '';
    for (let p = br.pi + 1; p < parts.length; p++) {
      const part = parts[p];
      labelHtml += typeof part === 'string' ? part : partToString(part);
    }
    brackets.pop();
    // Restore the inLink/inRaw state to the bracket's (marked restores
    // them after the label parse).
    inLink = br.inLink;
    inRaw = br.inRaw;

    let out;
    if (plain) {
      out = labelHtml;
      // A plain-mode link still counts as a link for the nested-link
      // rejection (the image alt must see the inner link).
      if (!br.img) linksEmitted++;
    } else if (br.img) {
      const alt = escapeAttr(parseInline(s.slice(labelStart, labelEnd), refs, true));
      const url = cleanUrl(href);
      if (url === null) {
        out = alt;
      } else {
        out = '<img src="' + escapeAttr(url) + '" alt="' + alt + '"';
        if (title) out += ' title="' + escapeAttr(title) + '"';
        out += '>';
      }
    } else {
      const url = cleanUrl(href);
      if (url === null) {
        out = labelHtml;
      } else {
        out = '<a href="' + escapeAttr(url) + '"';
        if (title) out += ' title="' + escapeAttr(title) + '"';
        out += '>' + labelHtml + '</a>';
        linksEmitted++;
      }
    }
    // Replace the bracket + label parts with the single link part.
    parts.splice(br.pi, parts.length - br.pi, out);
    return end;
  }

  // ---- main scan loop ----
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      const nx = s.charCodeAt(i + 1);
      if (nx === 10) { // \<newline> — hard break (if non-ws follows)
        if (hasNonWhitespaceAfter(s, i + 2)) {
          flushText(i);
          parts.push(plain ? '' : '<br>');
          i += 2;
          while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (nx < 128 && ASCII_CLASS[nx] === CC_PUNCT) {
        flushText(i);
        parts.push(plain ? String.fromCharCode(nx) : escapeText(String.fromCharCode(nx)));
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) { // backtick — code span
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      const runLen = j - i;
      // Inside a link label, a code span must close before the label's
      // `]` — otherwise it swallows the `]` and the link never forms
      // (marked matches the whole link first, then lexes the label).
      // But only when the bracket WILL form a link; if it won't, the
      // code span may span across the `]`.
      let limit = n;
      if (brackets.length > 0) {
        let q = s.indexOf(']', j);
        while (q !== -1 && q > j && s.charCodeAt(q - 1) === 92) q = s.indexOf(']', q + 1);
        if (q !== -1 && linkFormsAt(q)) limit = q;
      }
      const closeEnd = findCodeSpanEnd(s, i, runLen, limit);
      if (closeEnd !== -1) {
        flushText(i);
        const content = codeSpanContent(s.slice(j, closeEnd - runLen));
        parts.push(plain ? content : '<code>' + escapeFull(content) + '</code>');
        i = closeEnd;
        textStart = i;
        continue;
      }
      i = j; // literal backticks stay in the text run
      continue;
    }
    if (c === 42 || c === 95 || c === 126) { // * _ ~
      let j = i;
      while (j < n && s.charCodeAt(j) === c) j++;
      const runLen = j - i;
      if (c === 126 && runLen > 2) {
        i = j; // ~~~+ is literal text
        continue;
      }
      flushText(i);
      const prevClass = prevClassForDelim(i);
      const nextClass = classAt(s, j);
      pushDelim(c, runLen, i, prevClass, nextClass);
      i = j;
      textStart = i;
      continue;
    }
    if (c === 91) { // [ — bracket
      flushText(i);
      const br = {
        k: 2, img: false, pi: parts.length, bottom: delimTail,
        links: linksEmitted, inRaw, inLink, labelStart: i + 1,
      };
      parts.push(br);
      brackets.push(br);
      i++;
      textStart = i;
      continue;
    }
    if (c === 33) { // ! — maybe image bracket
      if (s.charCodeAt(i + 1) === 91) {
        flushText(i);
        const br = {
          k: 2, img: true, pi: parts.length, bottom: delimTail,
          links: linksEmitted, inRaw, inLink, labelStart: i + 2,
        };
        parts.push(br);
        brackets.push(br);
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 93) { // ] — try to resolve a link
      flushText(i); // the label's trailing text must be in parts first
      const end = tryLink(i);
      if (end !== -1) {
        i = end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 60) { // < — HTML tag or autolink
      const tagEnd = matchHtmlTag(s, i);
      if (tagEnd !== -1) {
        flushText(i);
        const raw = s.slice(i, tagEnd);
        // Identify the tag for inLink/inRaw tracking. Marked's rules:
        // startATag = /^<a /i (a SPACE after `a` — bare `<a>` and
        // `<a/>` do NOT open a link, but `<a href="x"/>` does);
        // endATag = /^<\/a>/i; raw tags are pre|code|kbd|script
        // (no `style`), opened by `<name` + whitespace-or-`>`.
        let name = '';
        let open = true;
        const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(raw);
        if (m) {
          name = m[1].toLowerCase();
          open = raw.charCodeAt(1) !== 47;
        }
        parts.push({ k: 4, html: raw, name, open });
        if (name === 'a' && open && raw.length > 2 && raw.charCodeAt(2) === 32) {
          if (!inLink) inLink = true;
        } else if (name === 'a' && !open) {
          if (inLink) inLink = false;
        } else if (name === 'pre' || name === 'code' || name === 'kbd' || name === 'script') {
          // The char after the name must be whitespace or `>`.
          const after = raw.length > 1 + name.length + (open ? 0 : 1)
            ? raw.charCodeAt(1 + name.length + (open ? 0 : 1)) : 0;
          if (after === 62 || after === 32 || after === 9 || after === 10 || after === 13) {
            inRaw = open;
          }
        }
        i = tagEnd;
        textStart = i;
        continue;
      }
      const al = matchAutolink(s, i);
      if (al) {
        flushText(i);
        if (plain) {
          parts.push(al.text);
        } else {
          const url = cleanUrl(al.href);
          if (url === null) parts.push(escapeAttr(al.text));
          else parts.push('<a href="' + escapeAttr(url) + '">' + escapeAttr(al.text) + '</a>');
        }
        i = al.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 10) { // newline — hard or soft break
      // Count trailing spaces in the current text run.
      let sp = 0;
      let k = i - 1;
      while (k >= textStart && s.charCodeAt(k) === 32) { sp++; k--; }
      if (sp >= 2 && hasNonWhitespaceAfter(s, i + 1)) {
        flushText(i - sp);
        parts.push(plain ? '' : '<br>');
        i++;
        while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      }
      i++; // soft break — the \n stays in the text run
      continue;
    }
    // GFM autolinks (only when not inLink)
    if (!inLink) {
      let gfm = null;
      // A trailing `_` after an email is OK if an open `_` delimiter
      // exists (the `_` will close the emphasis, so marked's email
      // lexer never sees it). Cached in hasOpenUnderscore.
      const allowTrailingUnderscore = hasOpenUnderscore;
      if (c === 119 && s.startsWith('www.', i)) { // w — www. needs a preceding start/space/*/_/~/(
        if (i === 0) gfm = matchGfmAutolink(s, i, allowTrailingUnderscore);
        else {
          const pc = s.charCodeAt(i - 1);
          if (pc === 32 || pc === 9 || pc === 10 || pc === 13 || pc === 42 || pc === 95 || pc === 126 || pc === 40 ||
              (pc > 127 && classBefore(s, i) === CC_SPACE)) {
            gfm = matchGfmAutolink(s, i, allowTrailingUnderscore);
          }
        }
      } else if (c === 104 || c === 72 || c === 102 || c === 70) { // h/H/f/F — scheme
        gfm = matchGfmAutolink(s, i, allowTrailingUnderscore);
      } else if (c === 109 || c === 120) { // m/x — mailto:/xmpp: need a preceding non-alnum
        if (i === 0 || !isAlnum(s.charCodeAt(i - 1))) gfm = matchGfmAutolink(s, i, allowTrailingUnderscore);
      }
      // Bare email: s[i] is a narrow-local char and the previous char is not.
      if (!gfm && (isWordChar(c) || c === 46 || c === 43 || c === 45)) {
        if (i === 0 || !(isWordChar(s.charCodeAt(i - 1)) || s.charCodeAt(i - 1) === 46 ||
            s.charCodeAt(i - 1) === 43 || s.charCodeAt(i - 1) === 45)) {
          gfm = matchGfmAutolink(s, i, allowTrailingUnderscore);
        }
      }
      if (gfm) {
        // Inside a link label, a GFM autolink must not swallow the `]`
        // that closes the label (marked lexes the label with inLink=true,
        // so no autolink is matched there at all). Truncate at the first
        // unescaped `]` — the label's revert logic then turns the
        // truncated autolink back into plain text. But only when the
        // bracket WILL form a link: if the `[` in scope is a literal
        // bracket (a previous link failed), the autolink keeps the
        // `](...)` in its URL.
        if (brackets.length > 0) {
          let q = s.indexOf(']', i);
          if (q !== -1 && q < gfm.end) {
            // Skip escaped `\]` (doesn't close the label).
            while (q !== -1 && q < gfm.end && q > i && s.charCodeAt(q - 1) === 92) {
              q = s.indexOf(']', q + 1);
            }
            if (q !== -1 && q < gfm.end && linkFormsAt(q)) {
              // Backpedal the truncated text too: it may end with
              // punctuation that belongs to a delimiter run (e.g.
              // `www.x.com~~` before the `]` — the `~~` is a del closer,
              // not part of the URL; without this the autolink swallows
              // it and the del never forms).
              const be = backpedalUrl(s, i, q);
              const text = s.slice(i, be);
              let href = text;
              if (gfm.href === 'mailto:' + gfm.text) href = 'mailto:' + text;
              else if (gfm.href === 'http://' + gfm.text) href = 'http://' + text;
              gfm = { end: be, href, text };
            }
          }
        }
        flushText(i);
        if (plain) {
          parts.push(gfm.text);
        } else {
          const url = cleanUrl(gfm.href);
          if (url === null) parts.push(escapeAttr(gfm.text));
          else parts.push({ k: 3, raw: gfm.text, html: '<a href="' + escapeAttr(url) + '">' + escapeAttr(gfm.text) + '</a>' });
        }
        i = gfm.end;
        textStart = i;
        continue;
      }
    }
    i++;
  }

  flushText(n);
  processEmphasis(null, 0, n);
  // Finalize any remaining delimiters.
  let d = delimHead;
  while (d) {
    finalizeDelim(d);
    d = d.next;
  }
  // Join all parts.
  let out = '';
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    out += typeof part === 'string' ? part : partToString(part);
  }
  if (!plain) gInLink = inLink;
  return out;
}

// ---------------------------------------------------------------------------
// Block parser (line-oriented, single pass)
// ---------------------------------------------------------------------------

// Expand tabs in the leading whitespace of a line to spaces (tab stops
// every 4 columns). Returns {indent, contentStart}.
function lineIndent(line) {
  let indent = 0;
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c === 32) { indent++; k++; }
    else if (c === 9) { indent += 4 - (indent % 4); k++; }
    else break;
  }
  return { indent, contentStart: k };
}

// Strip n columns of indent from a line (given its precomputed indent and
// contentStart). Returns the remaining line (with leftover indent as
// spaces when a tab was only partly consumed).
function stripIndent(line, info, n) {
  if (n <= 0) return line;
  if (info.indent <= n) return line.slice(info.contentStart);
  // Container stripping (list items): the remaining indent is spaces —
  // marked expands the leading tabs when building the item's text.
  return ' '.repeat(info.indent - n) + line.slice(info.contentStart);
}

// Code-content stripping (indented/fenced code): a tab that survives
// intact stays a tab; only a tab straddling the cut becomes spaces.
// Marked's codeRemoveIndent does not expand tabs.
function stripIndentPreserve(line, info, n) {
  if (n <= 0) return line;
  if (info.indent <= n) return line.slice(info.contentStart);
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

// Is the line blank (only spaces/tabs)?
function isBlankLine(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ATX heading: {0,3}#{1,6}(space|end) text. Returns {level, text} or null.
function matchATX(content) {
  const info = lineIndent(content);
  if (info.indent > 3) return null;
  let k = info.contentStart;
  if (content.charCodeAt(k) !== 35) return null;
  let level = 0;
  while (k < content.length && content.charCodeAt(k) === 35 && level < 6) { level++; k++; }
  if (level === 0) return null;
  if (k < content.length) {
    const c = content.charCodeAt(k);
    if (c !== 32 && c !== 9) return null; // #foo is not a heading
  }
  let text = content.slice(k).trim();
  // Strip a closing sequence of #s (only if preceded by space/tab or empty).
  if (text.endsWith('#')) {
    let e = text.length;
    while (e > 0 && text.charCodeAt(e - 1) === 35) e--;
    if (e === 0 || text.charCodeAt(e - 1) === 32 || text.charCodeAt(e - 1) === 9) {
      text = text.slice(0, e).trim();
    }
  }
  return { level, text };
}

// Fenced code block opener: {0,3}(`{3,}|~{3,}) info.
// Returns {ch, len, info, indent, indentChars} or null.
// A backtick fence's info string must not contain a backtick.
function matchFence(content) {
  const info = lineIndent(content);
  if (info.indent > 3) return null;
  const k = info.contentStart;
  const ch = content.charCodeAt(k);
  if (ch !== 96 && ch !== 126) return null;
  let len = 0;
  while (k + len < content.length && content.charCodeAt(k + len) === ch) len++;
  if (len < 3) return null;
  const infoStr = content.slice(k + len);
  if (ch === 96 && infoStr.indexOf('`') !== -1) return null;
  // Marked unescapes backslash-punctuation in the info string.
  // indentChars = character count of the leading whitespace (marked
  // strips fence indent by CHARACTER count, not columns).
  return { ch: String.fromCharCode(ch), len, info: unescapePunct(infoStr.trim()), indent: info.indent, indentChars: info.contentStart };
}

// Strip up to n leading whitespace CHARACTERS (spaces/tabs count as 1
// each) — marked's fence-indent strip. Unlike stripIndentPreserve this
// is character-based, not column-based.
function stripFenceIndent(line, n) {
  if (n <= 0) return line;
  let i = 0;
  while (i < n && i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  return line.slice(i);
}

// Is this a closing fence for the given fence? Same char, length >=
// opener, info string empty (only spaces/tabs).
function isClosingFence(content, fence) {
  const info = lineIndent(content);
  if (info.indent > 3) return false;
  const k = info.contentStart;
  if (content.charCodeAt(k) !== fence.ch.charCodeAt(0)) return false;
  let len = 0;
  while (k + len < content.length && content.charCodeAt(k + len) === fence.ch.charCodeAt(0)) len++;
  if (len < fence.len) return false;
  const rest = content.slice(k + len);
  for (let m = 0; m < rest.length; m++) {
    const c = rest.charCodeAt(m);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Horizontal rule: {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$
function matchHR(content) {
  const info = lineIndent(content);
  if (info.indent > 3) return false;
  const k = info.contentStart;
  const ch = content.charCodeAt(k);
  if (ch !== 45 && ch !== 95 && ch !== 42) return false;
  let count = 0;
  for (let m = k; m < content.length; m++) {
    const c = content.charCodeAt(m);
    if (c === ch) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

// Setext underline: {0,3}(=+|-+)[ \t]*$ — returns 1 for =, 2 for -, else 0.
function matchSetext(content) {
  const info = lineIndent(content);
  if (info.indent > 3) return 0;
  const k = info.contentStart;
  const ch = content.charCodeAt(k);
  if (ch !== 61 && ch !== 45) return 0;
  // A setext underline is a run of `=`/`-` then ONLY trailing spaces.
  let m = k;
  while (m < content.length && content.charCodeAt(m) === ch) m++;
  while (m < content.length) {
    const c = content.charCodeAt(m);
    if (c !== 32 && c !== 9) return 0;
    m++;
  }
  return ch === 61 ? 1 : 2;
}

// Blockquote marker: {0,3}>[ \t]? — returns the stripped content or null.
function matchBlockquote(content) {
  const info = lineIndent(content);
  if (info.indent > 3) return null;
  const k = info.contentStart;
  if (content.charCodeAt(k) !== 62) return null;
  // Marked expands ALL whitespace after `>` column-aware, then strips
  // the `>` + one space. So `>   \tfoo` -> the `   \t` expands from
  // col 1 to 7 spaces, minus 1 = 6 spaces + foo.
  let j = k + 1;
  let wsEnd = j;
  while (wsEnd < content.length && (content.charCodeAt(wsEnd) === 32 || content.charCodeAt(wsEnd) === 9)) wsEnd++;
  if (wsEnd === j) return content.slice(j);
  const expanded = expandLeadingTabs(content.slice(j, wsEnd), info.indent + 1);
  return expanded.slice(1) + content.slice(wsEnd);
}

// List item marker: {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$).
// Returns {ordered, delim, num, markerLen, markerEnd} or null.
// markerLen = the marker length INCLUDING leading spaces (for R
// computation). markerEnd = index just after the marker.
function matchListItem(content) {
  const info = lineIndent(content);
  if (info.indent > 3) return null;
  const k = info.contentStart;
  const c = content.charCodeAt(k);
  let ordered = false;
  let delim = '';
  let num = 0;
  let mEnd;
  if (c === 42 || c === 43 || c === 45) {
    // The bullet CHAR is the delimiter: `-` and `+` are separate lists.
    delim = String.fromCharCode(c);
    mEnd = k + 1;
  } else if (c >= 48 && c <= 57) {
    let j = k;
    while (j < content.length && content.charCodeAt(j) >= 48 && content.charCodeAt(j) <= 57) j++;
    if (j - k > 9) return null;
    if (j >= content.length) return null;
    const d = content.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    ordered = true;
    delim = String.fromCharCode(d);
    num = parseInt(content.slice(k, j), 10);
    mEnd = j + 1;
  } else {
    return null;
  }
  // After the marker: end of line, or a space/tab.
  if (mEnd < content.length) {
    const nc = content.charCodeAt(mEnd);
    if (nc !== 32 && nc !== 9) return null;
  }
  const markerLen = mEnd; // index after the marker == length incl. leading spaces
  return { ordered, delim, num, markerLen, markerEnd: mEnd };
}

// Compute a list item's content indent R and first-line content,
// mirroring marked's list tokenizer. `content` is the full line, `item`
// the matchListItem result. Returns {R, firstContent, empty}.
function listItemContent(content, item) {
  const after = content.slice(item.markerEnd); // text after the bullet
  // Expand leading tabs (starting column = markerLen).
  const expanded = expandLeadingTabs(after, item.markerLen);
  const trimmed = expanded.trim();
  if (trimmed === '') {
    return { R: item.markerLen + 1, firstContent: '', empty: true };
  }
  // R = index of the first non-space char in the expanded text.
  let R = 0;
  while (R < expanded.length && (expanded.charCodeAt(R) === 32 || expanded.charCodeAt(R) === 9)) R++;
  if (R > 4) R = 1;
  const firstContent = expanded.slice(R);
  return { R: R + item.markerLen, firstContent, empty: false };
}

// Expand tabs in the leading whitespace of s, starting at column startCol.
function expandLeadingTabs(s, startCol) {
  let col = startCol;
  let out = '';
  let k = 0;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 32) { out += ' '; col++; k++; }
    else if (c === 9) {
      const r = 4 - (col % 4);
      out += ' '.repeat(r);
      col += r;
      k++;
    } else break;
  }
  return out + s.slice(k);
}

// HTML block start, kinds 1-6 only (the set that can interrupt a
// paragraph or stop table rows). Returns {kind, end, name,
// closedOnStart} or null.
// kind 1: script/pre/style/textarea (end = '</name>', case-insensitive).
// kind 2: <!-- (end = '-->'; '<!-->' / '<!--->' close on the start line).
// kind 3: <? (end = '?>'). kind 4: <!A-Z (end = '>').
// kind 5: <![CDATA[ (end = ']]>'). kind 6: block tag (ends at blank line).
function matchHtmlBlock(content) {
  const info = lineIndent(content);
  if (info.indent > 3) return null;
  const k = info.contentStart;
  if (content.charCodeAt(k) !== 60) return null;
  const c1 = content.charCodeAt(k + 1);
  if (c1 === 33) { // !
    if (content.charCodeAt(k + 2) === 45 && content.charCodeAt(k + 3) === 45) {
      // <!--> and <!---> are complete comments on the start line.
      const closedOnStart = content.charCodeAt(k + 4) === 62 ||
        (content.charCodeAt(k + 4) === 45 && content.charCodeAt(k + 5) === 62);
      return { kind: 2, end: '-->', closedOnStart };
    }
    if (content.startsWith('[CDATA[', k + 2)) return { kind: 5, end: ']]>' };
    const c2 = content.charCodeAt(k + 2);
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) return { kind: 4, end: '>' };
    return null;
  }
  if (c1 === 63) return { kind: 3, end: '?>' }; // <?
  // Tag name (open or close).
  let j = k + 1;
  const isClose = content.charCodeAt(j) === 47;
  if (isClose) j++; // /
  const nameStart = j;
  while (j < content.length) {
    const c = content.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (j === nameStart) return null;
  const name = content.slice(nameStart, j).toLowerCase();
  // The char after the name must be space/tab/end/> or /> (for kind 6);
  // kind 1 requires space/tab/end/> only (no '/').
  const after = j < content.length ? content.charCodeAt(j) : -1;
  if (after === 47) {
    // '/' must be followed by '>'.
    if (content.charCodeAt(j + 1) !== 62) return null;
    // '/>' is not a kind-1 opener.
    if (SCRIPT_PRE_STYLE.has(name)) return null;
  } else if (after !== -1 && after !== 32 && after !== 9 && after !== 62) {
    return null;
  }
  if (SCRIPT_PRE_STYLE.has(name)) {
    // Kind 1 is OPEN tags only; a close tag (</pre>) is kind 7, which
    // does not interrupt a paragraph.
    if (isClose) return null;
    return { kind: 1, name };
  }
  if (BLOCK_TAGS.has(name)) {
    return { kind: 6, end: null, name };
  }
  return null;
}

// HTML block start, kinds 1-7 (for block starts when no paragraph is
// open). Kind 7 is any open tag (except script/pre/style/textarea) or
// any close tag, alone on the line (only spaces/tabs after it). Kind 7
// does NOT interrupt paragraphs, so it is kept out of matchHtmlBlock.
function matchHtmlBlockStart(content) {
  const h = matchHtmlBlock(content);
  if (h) return h;
  const info = lineIndent(content);
  if (info.indent > 3) return null;
  const k = info.contentStart;
  if (content.charCodeAt(k) !== 60) return null;
  const c1 = content.charCodeAt(k + 1);
  // Open tag: <letter... ; close tag: </letter...
  if (c1 === 47) {
    // Close tag: </name\s*> then only spaces/tabs to EOL.
    const e = matchHtmlTag(content, k);
    if (e === -1) return null;
    for (let p = e; p < content.length; p++) {
      const c = content.charCodeAt(p);
      if (c !== 32 && c !== 9) return null;
    }
    return { kind: 7, end: null };
  }
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) return null;
  // Tag name (must not be script/pre/style/textarea).
  let j = k + 1;
  while (j < content.length) {
    const c = content.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  const name = content.slice(k + 1, j).toLowerCase();
  if (SCRIPT_PRE_STYLE.has(name)) return null;
  const e = matchHtmlTag(content, k);
  if (e === -1) return null;
  for (let p = e; p < content.length; p++) {
    const c = content.charCodeAt(p);
    if (c !== 32 && c !== 9) return null;
  }
  return { kind: 7, end: null };
}

// Case-insensitive search for an end tag `</name>` (name lowercase).
// Returns the index of '<' or -1.
function indexOfEndTag(line, name) {
  const nl = name.length;
  let i = 0;
  for (;;) {
    const lt = line.indexOf('<', i);
    if (lt === -1 || lt + 2 + nl >= line.length) return -1;
    if (line.charCodeAt(lt + 1) !== 47) { i = lt + 1; continue; }
    let ok = true;
    for (let k = 0; k < nl; k++) {
      let c = line.charCodeAt(lt + 2 + k);
      if (c >= 65 && c <= 90) c += 32;
      if (c !== name.charCodeAt(k)) { ok = false; break; }
    }
    if (ok && line.charCodeAt(lt + 2 + nl) === 62) return lt;
    i = lt + 1;
  }
}

// Does a kinds 1-5 HTML block end on its start line?
function htmlEndsOnStart(content, html) {
  if (html.kind === 1) return indexOfEndTag(content, html.name) !== -1;
  if (html.kind === 2) return !!html.closedOnStart || content.indexOf('-->') !== -1;
  if (html.kind >= 3 && html.kind <= 5) return content.indexOf(html.end) !== -1;
  return false;
}

// Table delimiter row: {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)
// Must contain : or |. Returns the alignment array or null.
function matchTableDelimiter(content) {
  const info = lineIndent(content);
  if (info.indent > 3) return null;
  const line = content.slice(info.contentStart);
  let k = 0;
  const n = line.length;
  // optional leading pipe + spaces
  if (line.charCodeAt(k) === 124) {
    k++;
    while (k < n && line.charCodeAt(k) === 32) k++;
  }
  const aligns = [];
  for (;;) {
    // cell: :? -+ :?
    let left = false, right = false;
    if (line.charCodeAt(k) === 58) { left = true; k++; }
    let dashes = 0;
    while (k < n && line.charCodeAt(k) === 45) { dashes++; k++; }
    if (dashes === 0) return null;
    if (line.charCodeAt(k) === 58) { right = true; k++; }
    while (k < n && line.charCodeAt(k) === 32) k++;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
    if (k < n && line.charCodeAt(k) === 124) {
      k++;
      while (k < n && line.charCodeAt(k) === 32) k++;
      if (k >= n) break; // trailing pipe
      continue;
    }
    break;
  }
  if (k < n) return null; // trailing junk
  // Must contain : or |.
  if (line.indexOf(':') === -1 && line.indexOf('|') === -1) return null;
  return aligns;
}

// Split a table row into cells (marked's table cell split).
function splitTableRow(line, expected) {
  // Replace unescaped | with ' |', then split on ' |'.
  let t = '';
  let last = 0;
  for (let k = 0; k < line.length; k++) {
    if (line.charCodeAt(k) === 124) {
      let bs = 0;
      let p = k - 1;
      while (p >= 0 && line.charCodeAt(p) === 92) { bs++; p--; }
      if (bs % 2 === 0) { // unescaped pipe
        t += line.slice(last, k) + ' |';
        last = k + 1;
      }
    }
  }
  t += line.slice(last);
  const cells = t.split(' |');
  // Drop a leading empty cell (from a leading pipe) and a trailing one.
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (expected !== undefined) {
    if (cells.length > expected) cells.length = expected;
    while (cells.length < expected) cells.push('');
  }
  for (let s = 0; s < cells.length; s++) {
    cells[s] = cells[s].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Block parsing driver
// ---------------------------------------------------------------------------

function parseBlocks(src) {
  src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const endsWithNewline = src.endsWith('\n');
  if (endsWithNewline) lines.pop();
  const nLines = lines.length;
  // Precompute per-line indent info.
  const infos = lines.map(lineIndent);

  const refs = new Map();
  const root = { t: 'root', children: [] };
  // Container stack: root + quotes/lists/items. Each non-root container:
  //   quote: {t:'quote', children:[]}
  //   list:  {t:'list', ordered, delim, start, children:[], loose}
  //   item:  {t:'item', children:[], R, task, checked, emptyFirst}
  const stack = [root];
  let leaf = null; // current open leaf block
  // Depth (in `stack`) of the container a pending blank line belongs to,
  // or -1. A blank line makes a list loose iff the next block is a new
  // item of that list (blankDepth > list depth) or a direct child of one
  // of its items (blankDepth === item depth).
  let blankDepth = -1;

  // Append a finished block to the current (deepest) container.
  // (Looseness is decided at block START, not at emit: a block that
  // started before the blank line must not be blamed for it.)
  function emit(block) {
    stack[stack.length - 1].children.push(block);
  }

  // Called when a new block STARTS (at the top of the block-start
  // section): if a blank line is pending at this container level and the
  // container is a list item, the item's list is loose. Any new block
  // starting at or above the blank line's level consumes it.
  function noteBlockStart() {
    // If the top is a list, this line is a new item of it (closeContainers
    // already closed any list the line doesn't join) — openListItem
    // handles the blank line (between-items looseness).
    if (stack[stack.length - 1].t === 'list') return;
    if (blankDepth !== -1 && stack.length - 1 <= blankDepth) {
      if (stack.length - 1 === blankDepth && stack[stack.length - 1].t === 'item') {
        stack[stack.length - 2].loose = true;
      }
      blankDepth = -1;
    }
  }

  // Finalize the current leaf (if any) into a block and emit it.
  // `keepNL` — for HTML blocks: whether to keep a trailing newline.
  function closeLeaf(keepNL) {
    if (!leaf) return;
    const lf = leaf;
    leaf = null;
    if (lf.t === 'p') {
      if (lf.lines.length === 0) return;
      emit({ t: 'p', text: lf.lines.join('\n') });
    } else if (lf.t === 'fence') {
      // Marked's fence token text is the raw joined lines (no added \n);
      // the renderer strips one trailing \n and adds one back, so trailing
      // blank lines inside the fence survive.
      emit({ t: 'code', lang: lf.info, text: lf.lines.join('\n') });
    } else if (lf.t === 'icode') {
      // Strip trailing blank lines (whitespace-only counts);
      // ensure exactly one trailing \n at render.
      let lines2 = lf.lines;
      while (lines2.length > 0 && isBlankLine(lines2[lines2.length - 1])) lines2.pop();
      emit({ t: 'code', lang: '', text: lines2.join('\n') + (lines2.length ? '\n' : '') });
    } else if (lf.t === 'html') {
      let text = lf.lines.join('\n');
      if (keepNL && lf.lastTerminated) text += '\n';
      emit({ t: 'html', text });
    } else if (lf.t === 'table') {
      emit({ t: 'table', head: lf.head, aligns: lf.aligns, rows: lf.rows });
    } else if (lf.t === 'h') {
      emit(lf);
    }
  }

  // Close containers down to (but not including) depth `to`.
  // Finalizes the leaf if it lives in a closing container.
  function closeContainers(to) {
    // The leaf belongs to the deepest container; if that container is
    // closing, close the leaf first (an HTML block finalized by a container
    // close loses its trailing newline).
    if (leaf && stack.length - 1 > to) closeLeaf(false);
    while (stack.length - 1 > to) {
      const c = stack.pop();
      if (c.t === 'quote') {
        // A blank line inside a closing quote is consumed by the quote
        // (the quote's raw is untrimmed, so the blank line never becomes
        // a separator at the parent level). After the pop,
        // stack.length is the quote's own depth.
        if (blankDepth >= stack.length) blankDepth = -1;
        emit({ t: 'quote', children: c.children });
      } else if (c.t === 'item') {
        // The item is a child of the list on the new top.
        stack[stack.length - 1].children.push(finishItem(c));
      } else if (c.t === 'list') {
        emit(finishList(c));
      }
    }
    // A pending blank line inside a closed container is now a separator
    // at the nearest enclosing ITEM level (a blank line inside a nested
    // list separates the nested list from the next block in the outer
    // item). Do not cross a list boundary: the between-items check in
    // openListItem needs the deep value.
    if (blankDepth > to) {
      for (let d = to; d >= 1; d--) {
        if (stack[d].t === 'item') { blankDepth = d; break; }
        if (stack[d].t === 'list') break;
      }
    }
  }

  function finishItem(item) {
    return { t: 'item', children: item.children, task: item.task, checked: item.checked };
  }

  function finishList(list) {
    return {
      t: 'list', ordered: list.ordered, start: list.start,
      loose: list.loose, children: list.children,
    };
  }

  // --- link definition parsing (lookahead over lines) ---
  // Tries to parse a def starting at line `li` (content = the line after
  // container stripping). Returns {label, href, title, lines} or null.
  function matchDefAt(li, content) {
    const info = lineIndent(content);
    if (info.indent > 3) return null;
    let k = info.contentStart;
    if (content.charCodeAt(k) !== 91) return null; // [
    // Scan the label: escapes + non-bracket chars + newlines (not
    // followed by a blank line), until ]. The label may span lines.
    const defStartLine = li;
    let labelLine = li;
    let labelCur = content;
    let j = k + 1;
    let label = '';
    let hasContent = false;
    let labelDone = false;
    for (;;) {
      while (j < labelCur.length) {
        const c = labelCur.charCodeAt(j);
        if (c === 92 && j + 1 < labelCur.length) { label += labelCur.slice(j, j + 2); j += 2; hasContent = true; continue; }
        if (c === 93) { labelDone = true; break; } // ]
        if (c === 91) return null;
        label += labelCur[j];
        if (c !== 32 && c !== 9) hasContent = true;
        j++;
      }
      if (labelDone) break;
      // End of line — continue on the next line unless it's blank.
      if (labelLine + 1 >= nLines) return null;
      const nextLine = lines[labelLine + 1];
      if (isBlankLine(nextLine)) return null;
      label += '\n';
      labelLine++;
      labelCur = nextLine;
      j = 0;
    }
    if (!hasContent) return null; // empty label (whitespace-only) is invalid
    if (labelCur.charCodeAt(j + 1) !== 58) return null; // :
    let p = j + 2;
    // The rest of the def (dest, title) continues on the label's last line.
    content = labelCur;
    li = labelLine;
    // Skip spaces/tabs, then an optional newline+indent (dest on next line).
    let lineIdx = li;
    let cur = content;
    let pos = p;
    const skipWs = () => {
      for (;;) {
        while (pos < cur.length && (cur.charCodeAt(pos) === 32 || cur.charCodeAt(pos) === 9)) pos++;
        return;
      }
    };
    skipWs();
    if (pos >= cur.length) {
      // End of line — the destination may be on the next line.
      if (lineIdx + 1 >= nLines) return null;
      lineIdx++;
      cur = lines[lineIdx];
      pos = 0;
      skipWs();
      if (pos >= cur.length) return null; // blank line — no destination
    }
    // Destination: <...> or bare.
    let href = '';
    if (cur.charCodeAt(pos) === 60) { // <
      const gt = cur.indexOf('>', pos + 1);
      if (gt === -1) return null;
      href = cur.slice(pos + 1, gt);
      pos = gt + 1;
    } else {
      const start = pos;
      while (pos < cur.length) {
        const c = cur.charCodeAt(pos);
        if (c === 32 || c === 9) break;
        pos++;
      }
      if (pos === start) return null;
      href = cur.slice(start, pos);
      // Bare destination: paren balance check (marked's ke, via def()).
      if (parenBalance(href) !== -1) return null;
    }
    href = unescapePunct(href);
    // Optional title: spaces (with optional newline) + "..." | '...' | (...).
    const destLine = lineIdx;
    let title = null;
    let titleLine = lineIdx;
    let titlePos = pos;
    let titleCur = cur;
    // Skip spaces/tabs on this line.
    while (titlePos < titleCur.length && (titleCur.charCodeAt(titlePos) === 32 || titleCur.charCodeAt(titlePos) === 9)) titlePos++;
    if (titlePos >= titleCur.length) {
      // End of line — the title may be on the next line.
      if (titleLine + 1 < nLines) {
        const nextLine = lines[titleLine + 1];
        let q = 0;
        while (q < nextLine.length && (nextLine.charCodeAt(q) === 32 || nextLine.charCodeAt(q) === 9)) q++;
        const qc = nextLine.charCodeAt(q);
        if (qc === 34 || qc === 39 || qc === 40) {
          titleLine++;
          titleCur = nextLine;
          titlePos = q;
        }
      }
    }
    if (titlePos < titleCur.length) {
      // A title on the SAME line as the destination must be preceded by
      // whitespace (`[foo]: <bar>(baz)` is not a def). A title on the
      // next line is separated by the newline itself.
      if (titleLine === lineIdx && titlePos === pos) return null;
      // A title that starts on a LATER line than the destination and
      // fails to parse (or has junk after it) does NOT kill the def —
      // the def stands without a title and the line stays a paragraph.
      // A same-line failure does kill it.
      const nextLineTitle = titleLine > destLine;
      const t = parseLinkTitle(titleCur, titlePos);
      if (t) {
        // After the title: only spaces to the end of the line.
        let q = t.end;
        while (q < titleCur.length && (titleCur.charCodeAt(q) === 32 || titleCur.charCodeAt(q) === 9)) q++;
        if (q >= titleCur.length) {
          title = unescapePunct(t.title);
          lineIdx = titleLine;
        } else if (nextLineTitle) {
          lineIdx = destLine; // junk after a next-line title: no title
        } else {
          return null; // junk after the title
        }
      } else if (titleCur.charCodeAt(titlePos) === 34 || titleCur.charCodeAt(titlePos) === 39 ||
                 titleCur.charCodeAt(titlePos) === 40) {
        // Multi-line title: join up to 4 following lines and retry. A
        // ' title stops at a blank line.
        const qch = titleCur.charCodeAt(titlePos);
        let win = titleCur.slice(titlePos);
        const lineStarts = [0];
        let winEndLine = titleLine;
        for (let extra = 1; extra <= 4 && titleLine + extra < nLines; extra++) {
          const nl = lines[titleLine + extra];
          if (qch === 39 && isBlankLine(nl)) break;
          lineStarts.push(win.length + 1);
          win += '\n' + nl;
          winEndLine = titleLine + extra;
        }
        const t2 = parseLinkTitle(win, 0);
        if (!t2) {
          if (nextLineTitle) lineIdx = destLine; // no title
          else return null;
        } else {
          // Which line does the title end on?
          let endLine = titleLine;
          for (let k = 0; k < lineStarts.length; k++) {
            if (lineStarts[k] <= t2.end) endLine = titleLine + k;
            else break;
          }
          const endLineStr = endLine === titleLine ? titleCur : lines[endLine];
          const endPosInLine = t2.end - lineStarts[endLine - titleLine];
          let r = endPosInLine;
          while (r < endLineStr.length && (endLineStr.charCodeAt(r) === 32 || endLineStr.charCodeAt(r) === 9)) r++;
          if (r >= endLineStr.length) {
            title = unescapePunct(t2.title);
            lineIdx = endLine;
          } else if (nextLineTitle) {
            lineIdx = destLine; // junk after a next-line title: no title
          } else {
            return null; // junk after the title
          }
        }
      } else if (nextLineTitle) {
        lineIdx = destLine; // next-line content isn't a title: no title
      } else {
        return null; // junk after the destination
      }
    } else {
      lineIdx = titleLine;
    }
    // The def ends at the end of lineIdx (trailing spaces allowed).
    return { label: normalizeLabel(label), href, title, lines: lineIdx - defStartLine + 1 };
  }

  // Container matching (outermost to innermost) for one line against
  // the current stack. Returns {content, contentInfo, matched} where
  // `content` is the line after stripping matched container markers and
  // `matched` is the stack depth matched (root = 0).
  function matchContainers(rawLine, info) {
    let content = rawLine;
    let contentInfo = info;
    let matched = 0;
    for (let d = 1; d < stack.length; d++) {
      const c = stack[d];
      if (c.t === 'quote') {
        const stripped = matchBlockquote(content);
        if (stripped === null) break;
        content = stripped;
        contentInfo = lineIndent(content);
        matched = d;
      } else if (c.t === 'list') {
        if (d === stack.length - 1) {
          // The list is the deepest container (its item just closed):
          // it matches a blank line, or a new item of the same list.
          // Blankness is judged on the stripped content.
          if (isBlankLine(content)) {
            matched = d;
          } else {
            const li2 = matchListItem(content);
            // An hr line (`* * *`) is NOT a new item — hr precedes list
            // in marked's block order.
            if (li2 && li2.ordered === c.ordered && li2.delim === c.delim && !matchHR(content)) {
              matched = d;
            } else {
              break;
            }
          }
        } else {
          matched = d; // transparent — the item below decides
        }
      } else if (c.t === 'item') {
        if (isBlankLine(content)) {
          // A blank line matches an item (it stays open). Blankness is
          // judged on the stripped content.
          matched = d;
          continue;
        }
        if (contentInfo.indent >= c.R) {
          content = stripIndent(content, contentInfo, c.R);
          contentInfo = lineIndent(content);
          matched = d;
        } else {
          // The item doesn't match. The enclosing list stays open only
          // if this line is a new item of that list (and not an hr).
          const list = stack[d - 1];
          const li2 = matchListItem(content);
          if (li2 && li2.ordered === list.ordered && li2.delim === list.delim && !matchHR(content)) {
            matched = d - 1; // the list stays; the item closes
          } else {
            matched = d - 2; // both the item and the list close
          }
          break;
        }
      }
    }
    return { content, contentInfo, matched };
  }

  // --- main line loop ---
  let li = 0;
  while (li < nLines) {
    const rawLine = lines[li];
    const info = infos[li];
    const rawBlank = isBlankLine(rawLine);

    // 1. Container matching (outermost to innermost).
    const mc = matchContainers(rawLine, info);
    let content = mc.content;
    let contentInfo = mc.contentInfo;
    const matched = mc.matched;
    const allMatched = matched === stack.length - 1;
    // A line is blank if its content after container stripping is blank
    // (e.g. a lone `>` line inside a blockquote).
    const blank = isBlankLine(content);

    // 2. Lazy continuation: paragraph + non-blank line that doesn't start
    //    a new block, even though containers didn't all match. But a line
    //    that is a new item of an already-open list is never lazy, and a
    //    list-item line is never lazy when it would close an enclosing
    //    list.
    if (!allMatched && leaf && leaf.t === 'p' && !blank &&
        stack[matched].t !== 'list') {
      let listClosed = false;
      const li2 = matchListItem(content);
      if (li2) {
        for (let d = matched + 1; d < stack.length; d++) {
          if (stack[d].t === 'list') { listClosed = true; break; }
        }
      }
      if (!listClosed && !startsNewBlock(content, true)) {
        let line = paraContinuationLine(content, contentInfo, true);
        // A lazy setext-looking line is indented 4 spaces so it stays
        // paragraph text (marked's blockquoteSetextReplace).
        if (matchSetext(content)) line = '    ' + line;
        leaf.lines.push(line);
        li++;
        continue;
      }
    }

    // 2b. Lazy fence continuation: a fenced code block inside a list
    //     item keeps plain-text lines even when they don't match the
    //     item's indent (marked's list tokenizer adds them as lazy
    //     content). But only after at least one content line: a lazy
    //     line cannot follow the fence OPENER (marked's list tokenizer
    //     breaks when the previous line was a fence start). A block
    //     start (fence/heading/hr/html/quote/list) still breaks the
    //     item, and a failed blockquote ends the fence (no lazy fence
    //     content in quotes).
    if (!allMatched && leaf && leaf.t === 'fence' && !blank && leaf.lines.length > 0) {
      let quoteFailed = false;
      for (let d = matched + 1; d < stack.length; d++) {
        if (stack[d].t === 'quote') { quoteFailed = true; break; }
      }
      if (!quoteFailed && !startsNewBlock(content, true)) {
        leaf.lines.push(content);
        li++;
        continue;
      }
    }

    // 3. Close unmatched containers.
    if (!allMatched) {
      closeContainers(matched);
    }

    // 4. Blank line handling.
    if (blank) {
      if (leaf && leaf.t === 'fence') {
        // A "blank" line may carry spaces that survive (minus the fence
        // indent, by characters).
        leaf.lines.push(stripFenceIndent(content, leaf.indentChars));
        li++;
        continue;
      }
      if (leaf && leaf.t === 'html' && leaf.kind <= 5) {
        leaf.lines.push(content);
        li++;
        continue;
      }
      if (leaf && leaf.t === 'icode') {
        // Same for indented code (minus 4 columns).
        leaf.lines.push(stripIndentPreserve(content, contentInfo, 4));
        li++;
        continue;
      }
      if (leaf && leaf.t === 'table' && content.indexOf('\t') !== -1) {
        // A tab-only line is a table ROW, not a blank line (marked's
        // row regex matches the tab; a spaces-only line ends the table).
        // The row's cells are all empty.
        leaf.rows.push(splitTableRow(content, leaf.head.length));
        li++;
        continue;
      }
      // A whitespace-only line that is the LAST line of a blockquote
      // joins the open paragraph (marked's paragraph regex excludes
      // `[ \t]+\n` continuations but allows a trailing whitespace line
      // with no `\n` after it — the quote's inner text ends there).
      // Only when the paragraph's innermost container is a quote with
      // no list-item ancestor (item text is trimmed) and the next line
      // doesn't keep that quote open (two trailing whitespace lines
      // don't join — the first is followed by `\n`).
      if (leaf && leaf.t === 'p' && content.length > 0) {
        let qd = -1;
        let hasItemAncestor = false;
        if (stack[stack.length - 1].t === 'quote') {
          qd = stack.length - 1;
          for (let d = qd - 1; d >= 1; d--) {
            if (stack[d].t === 'item') { hasItemAncestor = true; break; }
          }
        }
        if (qd !== -1 && !hasItemAncestor) {
          let nextKeepsQuote = false;
          if (li + 1 < nLines) {
            const nm = matchContainers(lines[li + 1], infos[li + 1]);
            nextKeepsQuote = nm.matched >= qd;
          }
          if (!nextKeepsQuote) {
            leaf.lines.push(content);
            li++;
            continue;
          }
        }
      }
      // A blank line ends paragraphs, HTML kind 6-7 blocks, and tables.
      // An HTML block ending at a blank line keeps NO trailing newline
      // (the regex match swallows the blank lines).
      closeLeaf(false);
      // Record the blank line's level for loose-list detection (keep the
      // deepest level across consecutive blank lines).
      if (blankDepth === -1 || stack.length - 1 > blankDepth) {
        blankDepth = stack.length - 1;
      }
      // An item whose first line was empty and which has no content yet
      // is closed by a following blank line (content cannot come later).
      const topC = stack[stack.length - 1];
      if (topC.t === 'item' && topC.emptyFirst && topC.children.length === 0) {
        stack.pop();
        stack[stack.length - 1].children.push(finishItem(topC));
      }
      li++;
      continue;
    }

    // 5. Leaf continuation / new blocks. Loop because closing a leaf may
    //    expose a new block start on the same line.
    for (;;) {
      if (leaf && leaf.t === 'fence') {
        if (isClosingFence(content, leaf)) {
          closeLeaf(true);
          li++;
          break;
        }
        // Strip up to the opening fence's indent (by characters) from
        // the content line.
        leaf.lines.push(stripFenceIndent(content, leaf.indentChars));
        li++;
        break;
      }
      if (leaf && leaf.t === 'html' && leaf.kind <= 5) {
        leaf.lines.push(content);
        leaf.lastTerminated = li < nLines - 1 || endsWithNewline;
        const ended = leaf.kind === 1
          ? indexOfEndTag(content, leaf.name) !== -1
          : content.indexOf(leaf.end) !== -1;
        if (ended) closeLeaf(nextLineContinues());
        li++;
        break;
      }
      if (leaf && leaf.t === 'html' && (leaf.kind === 6 || leaf.kind === 7)) {
        // Kinds 6-7 continue to a blank line (blank lines handled above).
        leaf.lines.push(content);
        leaf.lastTerminated = li < nLines - 1 || endsWithNewline;
        li++;
        break;
      }
      if (leaf && leaf.t === 'icode') {
        if (contentInfo.indent >= 4) {
          leaf.lines.push(stripIndentPreserve(content, contentInfo, 4));
          li++;
          break;
        }
        // Not indented enough — close and re-process this line.
        closeLeaf(true);
        continue;
      }
      if (leaf && leaf.t === 'table') {
        // A row line: not blank (handled above) and doesn't start
        // hr/heading/blockquote/code/fence/list/html.
        if (!startsTableStopBlock(content)) {
          leaf.rows.push(splitTableRow(content, leaf.head.length));
          li++;
          break;
        }
        closeLeaf(true);
        continue;
      }
      if (leaf && leaf.t === 'p') {
        // Setext underline?
        const setext = matchSetext(content);
        if (setext) {
          const text = leaf.lines.join('\n').trim();
          leaf = null;
          emit({ t: 'h', level: setext, text });
          li++;
          break;
        }
        // Table delimiter row (header = the paragraph's last line)?
        const aligns = matchTableDelimiter(content);
        if (aligns) {
          const headerLine = leaf.lines[leaf.lines.length - 1];
          const headerCells = splitTableRow(headerLine);
          if (headerCells.length === aligns.length) {
            leaf.lines.pop();
            if (leaf.lines.length === 0) {
              leaf = null;
            } else {
              const text = leaf.lines.join('\n');
              leaf = null;
              emit({ t: 'p', text });
            }
            leaf = { t: 'table', head: headerCells, aligns, rows: [] };
            li++;
            break;
          }
        }
        // Interrupting block?
        if (startsNewBlock(content, true)) {
          closeLeaf(true);
          continue; // re-process this line as a new block
        }
        leaf.lines.push(paraContinuationLine(content, contentInfo));
        li++;
        break;
      }
      // No open leaf — try new blocks in marked's order. A new block is
      // about to start (whatever it is), so a pending blank line is
      // decided here.
      noteBlockStart();
      // (a) Indented code (only when no paragraph is open — we're here
      //     because there's no leaf at all).
      if (contentInfo.indent >= 4) {
        leaf = { t: 'icode', lines: [stripIndentPreserve(content, contentInfo, 4)] };
        li++;
        break;
      }
      // (b) Fence.
      const fence = matchFence(content);
      if (fence) {
        // Tilde fences get NO indent compensation (marked's fence strip
        // only matches backtick fences); backtick fences strip the
        // opener's indent from content lines.
        leaf = { t: 'fence', ch: fence.ch, len: fence.len, info: fence.info, indent: fence.ch === '`' ? fence.indent : 0, indentChars: fence.ch === '`' ? fence.indentChars : 0, lines: [] };
        li++;
        break;
      }
      // (c) ATX heading.
      const atx = matchATX(content);
      if (atx) {
        emit({ t: 'h', level: atx.level, text: atx.text });
        li++;
        break;
      }
      // (d) HR.
      if (matchHR(content)) {
        emit({ t: 'hr' });
        li++;
        break;
      }
      // (e) Blockquote.
      const bq = matchBlockquote(content);
      if (bq !== null) {
        const q = { t: 'quote', children: [] };
        stack.push(q);
        content = bq;
        contentInfo = lineIndent(content);
        // Re-process this line inside the blockquote (it may be blank
        // content — a lone '>' line — which is a blank line inside).
        if (isBlankLine(content)) {
          // A lone `>` line: a blank line inside the new blockquote.
          blankDepth = stack.length - 1;
          li++;
          break;
        }
        continue;
      }
      // (f) List.
      const listItem = matchListItem(content);
      if (listItem) {
        const firstContent = openListItem(content, listItem);
        if (firstContent !== null) {
          // The item's first line is re-processed as a block start
          // inside the item (it may be a fence, heading, blockquote,
          // nested list, indented code, html, or paragraph).
          content = firstContent;
          contentInfo = lineIndent(content);
          continue;
        }
        li++;
        break;
      }
      // (g) HTML block (kinds 1-7).
      const html = matchHtmlBlockStart(content);
      if (html) {
        const lastTerminated = li < nLines - 1 || endsWithNewline;
        leaf = { t: 'html', kind: html.kind, end: html.end || null, name: html.name || null, lines: [content], lastTerminated };
        if (html.kind <= 5 && htmlEndsOnStart(content, html)) closeLeaf(nextLineContinues());
        li++;
        break;
      }
      // (h) Link definition.
      const def = matchDefAt(li, content);
      if (def) {
        if (!refs.has(def.label)) {
          refs.set(def.label, { href: def.href, title: def.title });
        }
        li += def.lines;
        break;
      }
      // (i) Table (header = this line, delimiter = next line).
      if (li + 1 < nLines) {
        const nextContent = lines[li + 1];
        const aligns2 = matchTableDelimiter(nextContent);
        if (aligns2) {
          const headerCells = splitTableRow(content);
          if (headerCells.length === aligns2.length) {
            leaf = { t: 'table', head: headerCells, aligns: aligns2, rows: [] };
            li += 2;
            break;
          }
        }
      }
      // (j) Paragraph.
      leaf = { t: 'p', lines: [content] };
      li++;
      break;
    }
  }

  // End of input: close everything.
  if (leaf) {
    // At EOF, an HTML block keeps its trailing newline iff the source
    // ends with one AND the block is not the last block in a container.
    closeLeaf(endsWithNewline && stack.length === 1);
  }
  closeContainers(0);

  return { root, refs };

  // --- helpers (closures over the parser state) ---

  // A paragraph continuation line with indent >= 4 loses a 4-column code
  // indent when it is LAZY (no container marker matched — the line is
  // re-lexed as indented code and merged back into the paragraph) or
  // when the innermost container is a LIST ITEM (marked re-lexes item
  // content with `text` tokens). A MARKED line in a BLOCKQUOTE keeps its
  // indent. The innermost container decides for marked lines: item-in-
  // quote strips, quote-in-item keeps.
  function paraContinuationLine(content, contentInfo, lazy) {
    if (contentInfo.indent >= 4 &&
        (lazy || (stack.length > 1 && stack[stack.length - 1].t === 'item'))) {
      return stripIndent(content, contentInfo, 4);
    }
    return content;
  }

  // For a kinds 1-5 HTML block ending on line `li`: does its text keep a
  // trailing newline? Yes iff the next line is non-blank and still inside
  // the same containers (or EOF with a trailing newline at top level).
  function nextLineContinues() {
    if (li + 1 >= nLines) return endsWithNewline && stack.length === 1;
    const nextRaw = lines[li + 1];
    let content2 = nextRaw;
    let info2 = infos[li + 1];
    for (let d = 1; d < stack.length; d++) {
      const c = stack[d];
      if (c.t === 'quote') {
        const stripped = matchBlockquote(content2);
        if (stripped === null) return false;
        content2 = stripped;
        info2 = lineIndent(content2);
      } else if (c.t === 'item') {
        if (isBlankLine(nextRaw)) {
          // A blank line matches an item; content stays the blank line.
        } else if (info2.indent >= c.R) {
          content2 = stripIndent(content2, info2, c.R);
          info2 = lineIndent(content2);
        } else {
          return false;
        }
      }
      // list: transparent
    }
    // The trailing `\n` is kept iff the next line is non-EMPTY (a
    // spaces-only or tab-only line keeps it; only a truly empty line
    // drops it).
    return content2.length > 0;
  }

  // Does `content` start a block that can interrupt a paragraph?
  // (ATX, fence, hr, blockquote, list (bullet or 1. WITH content after
  // the marker), HTML 1-6, table.)
  function startsNewBlock(content, forInterrupt) {
    if (matchATX(content)) return true;
    if (matchFence(content)) return true;
    if (matchHR(content)) return true;
    if (matchBlockquote(content) !== null) return true;
    const li2 = matchListItem(content);
    if (li2) {
      // Inside a list item, ANY ordered start interrupts a paragraph
      // (the item's text is re-lexed, and the nested list wins); at the
      // top level or in a blockquote, only 1. does.
      const inItem = stack[stack.length - 1].t === 'item';
      if (!li2.ordered || li2.num === 1 || inItem) {
        // The marker must be followed by space/tab AND non-space content
        // (a lone `*` or `1.` does not interrupt a paragraph).
        const rest = content.slice(li2.markerLen);
        let k = 0;
        while (k < rest.length && (rest.charCodeAt(k) === 32 || rest.charCodeAt(k) === 9)) k++;
        if (k > 0 && k < rest.length) return true;
      }
      return false;
    }
    if (matchHtmlBlock(content)) return true;
    return false;
  }

  // Does `content` start a block that stops table rows?
  // (hr, heading, blockquote, indented code, fence, list (bullet or 1.,
  // with a space/tab after the marker), HTML block.)
  function startsTableStopBlock(content) {
    if (matchHR(content)) return true;
    if (matchATX(content)) return true;
    if (matchBlockquote(content) !== null) return true;
    if (lineIndent(content).indent >= 4) return true;
    if (matchFence(content)) return true;
    const li2 = matchListItem(content);
    if (li2 && (!li2.ordered || li2.num === 1)) {
      // The marker must be followed by a space/tab (not EOL).
      if (content.length > li2.markerLen) return true;
    }
    if (matchHtmlBlock(content)) return true;
    return false;
  }

  // Open (or continue) a list with the given item. Assumes `content` is
  // the item's line (after container stripping) and `listItem` its match.
  // Returns the item's first-line content (after the marker and task
  // marker) for the caller to re-process as a block start, or null if
  // the item's first line is empty.
  function openListItem(content, listItem) {
    const lic = listItemContent(content, listItem);
    // Find the enclosing list (if the top of the stack is a list of the
    // same type/delimiter, reuse it; else create a new one).
    let list = null;
    const top = stack[stack.length - 1];
    if (top.t === 'list' && top.ordered === listItem.ordered &&
        top.delim === listItem.delim) {
      list = top;
      // A blank line anywhere inside this list before the new item makes
      // it loose (a blank line inside a nested list still separates the
      // outer items). A blank line inside a nested QUOTE is consumed
      // when the quote closes, so it never reaches this check.
      if (blankDepth !== -1 && blankDepth > stack.length - 1) list.loose = true;
      blankDepth = -1;
    } else {
      list = {
        t: 'list', ordered: listItem.ordered, delim: listItem.delim,
        start: listItem.ordered ? listItem.num : 0,
        loose: false, children: [],
      };
      stack.push(list);
    }
    // Task marker?
    let task = false;
    let checked = false;
    let firstContent = lic.firstContent;
    const taskMatch = /^\[[ xX]\][ \t]+\S/.exec(firstContent);
    if (taskMatch) {
      task = true;
      checked = firstContent.charCodeAt(1) === 120 || firstContent.charCodeAt(1) === 88;
      firstContent = firstContent.replace(/^\[[ xX]\][ \t]+/, '');
    }
    const item = {
      t: 'item', children: [], R: lic.R, task, checked,
      emptyFirst: lic.empty,
    };
    stack.push(item);
    if (lic.empty) return null;
    return firstContent;
  }
}

// ---------------------------------------------------------------------------
// Rendering: block tree -> HTML (byte-identical to marked 18.1.3 defaults)
// ---------------------------------------------------------------------------

function renderBlocks(blocks, refs, out) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    switch (b.t) {
      case 'p':
        out.push('<p>', parseInline(b.text, refs, false), '</p>\n');
        break;
      case 'h':
        out.push('<h', String(b.level), '>', parseInline(b.text, refs, false), '</h', String(b.level), '>\n');
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'code': {
        let lang = '';
        if (b.lang) {
          // First word of the info string.
          let e = 0;
          while (e < b.lang.length) {
            const c = b.lang.charCodeAt(e);
            if (c === 32 || c === 9 || c === 10 || c === 13) break;
            e++;
          }
          lang = b.lang.slice(0, e);
        }
        // marked's endingNewline is /\n$/ (ONE trailing newline).
        const text = b.text ? b.text.replace(/\n$/, '') + '\n' : '';
        if (lang) {
          out.push('<pre><code class="language-', escapeAttr(lang), '">', escapeFull(text), '</code></pre>\n');
        } else {
          out.push('<pre><code>', escapeFull(text), '</code></pre>\n');
        }
        break;
      }
      case 'html':
        out.push(b.text);
        break;
      case 'quote':
        out.push('<blockquote>\n');
        renderBlocks(b.children, refs, out);
        out.push('</blockquote>\n');
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out.push('<', tag);
        if (b.ordered && b.start !== 1) out.push(' start="', String(b.start), '"');
        out.push('>\n');
        for (let j = 0; j < b.children.length; j++) {
          renderItem(b.children[j], b.loose, refs, out);
        }
        out.push('</', tag, '>\n');
        break;
      }
      case 'table': {
        out.push('<table>\n<thead>\n<tr>\n');
        for (let j = 0; j < b.head.length; j++) {
          const a = b.aligns[j];
          out.push(a ? `<th align="${a}">` : '<th>', parseInline(b.head[j], refs, false), '</th>\n');
        }
        out.push('</tr>\n</thead>\n');
        if (b.rows.length > 0) {
          out.push('<tbody>');
          for (let r = 0; r < b.rows.length; r++) {
            const row = b.rows[r];
            out.push('<tr>\n');
            for (let j = 0; j < row.length; j++) {
              const a = b.aligns[j];
              out.push(a ? `<td align="${a}">` : '<td>', parseInline(row[j], refs, false), '</td>\n');
            }
            out.push('</tr>\n');
          }
          out.push('</tbody>');
        }
        out.push('</table>\n');
        break;
      }
    }
  }
}

function renderItem(item, loose, refs, out) {
  const checkbox = item.task
    ? (item.checked
      ? '<input checked="" disabled="" type="checkbox"> '
      : '<input disabled="" type="checkbox"> ')
    : '';
  out.push('<li>');
  const children = item.children;
  if (checkbox) {
    if (!loose) {
      // Tight list: the checkbox is a block-level token at the start.
      out.push(checkbox);
    } else if (children.length > 0 && children[0].t === 'p') {
      // Loose list, first child a paragraph: checkbox goes inside <p>.
      out.push('<p>', checkbox, parseInline(children[0].text, refs, false), '</p>\n');
      renderBlocks(children.slice(1), refs, out);
      out.push('</li>\n');
      return;
    } else {
      // Loose list, no leading paragraph: a synthetic paragraph holds it.
      out.push('<p>', checkbox, '</p>\n');
    }
  }
  // Render children; in a tight list, direct-child paragraphs unwrap.
  for (let i = 0; i < children.length; i++) {
    const b = children[i];
    if (!loose && b.t === 'p') {
      out.push(parseInline(b.text, refs, false));
    } else {
      renderBlocks([b], refs, out);
    }
  }
  out.push('</li>\n');
}

/** The HTML marked 18.1.3 renders for `markdown`, with its defaults. */
export function parse(markdown) {
  gInLink = false;
  const { root, refs } = parseBlocks(markdown);
  const out = [];
  renderBlocks(root.children, refs, out);
  return out.join('');
}
