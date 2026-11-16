// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM renderer
// written from scratch to match marked 18.1.3's default output exactly.
// ES module. Exports: parse(markdown) -> string (HTML).

// ---------------------------------------------------------------- utilities

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
const isSpaceOrTab = (c) => c === ' ' || c === '\t';
const isDigit = (c) => c >= '0' && c <= '9';
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isWord = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';

// ASCII punctuation (CommonMark): ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
const isPunct = (c) => PUNCT.has(c);

// Unicode letter / alphanumeric test (for emphasis flanking).
// Uses Unicode property escapes; Node 22 supports them.
const RE_LETTER = /^\p{L}$/u;
const RE_ALNUM = /^[\p{L}\p{N}]$/u;
const RE_PUNCT = /^[\p{P}\p{S}]$/u;
const isLetter = (c) => c.length === 1 && RE_LETTER.test(c);
const isAlnum = (c) => c.length === 1 && RE_ALNUM.test(c);
const isUnicodePunct = (c) => c.length === 1 && RE_PUNCT.test(c);

// Whitespace per JS \s (used by the www. preceding-char check and others).
const RE_WS = /^\s$/;
const isWS = (c) => c.length === 1 && RE_WS.test(c);

// --- entities ---------------------------------------------------------------
// marked: named entities pass through UNCHANGED (no decoding); numeric
// references are decoded. Entity-like pattern: &\w+;  or  &#digits; / &#xhex;

// Try to match an entity-like sequence starting at s[i] == '&'.
// Returns the index just past the ';' if valid, else -1.
// Valid: &\w+;  (word chars) or &#<1-7 decimal digits>; or &#[xX]<1-6 hex>;
function entityEnd(s, i) {
  // s[i] === '&'
  const n = s.length;
  let j = i + 1;
  if (j >= n) return -1;
  const c = s[j];
  if (c === '#') {
    j++;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) {
      j++;
      const start = j;
      while (j < n && j - start < 6 && /[0-9a-fA-F]/.test(s[j])) j++;
      if (j === start) return -1;
      if (j < n && s[j] === ';') return j + 1;
      return -1;
    }
    const start = j;
    while (j < n && j - start < 7 && isDigit(s[j])) j++;
    if (j === start) return -1;
    if (j < n && s[j] === ';') return j + 1;
    return -1;
  }
  if (!isWord(c)) return -1;
  while (j < n && isWord(s[j])) j++;
  if (j < n && s[j] === ';') return j + 1;
  return -1;
}

// Decode a numeric character reference starting at s[i] == '&'.
// Returns { ch, end } or null if not a valid numeric ref.
function decodeNumericRef(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n || s[j] !== '#') return null;
  j++;
  let hex = false;
  if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
  const start = j;
  const maxLen = hex ? 6 : 7;
  while (j < n && j - start < maxLen) {
    const c = s[j];
    if (hex ? /[0-9a-fA-F]/.test(c) : isDigit(c)) j++;
    else break;
  }
  if (j === start) return null;
  if (j >= n || s[j] !== ';') return null;
  let cp = parseInt(s.slice(start, j), hex ? 16 : 10);
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
  return { ch: String.fromCodePoint(cp), end: j + 1 };
}

// --- escaping ---------------------------------------------------------------
// Entity-aware escape (text, hrefs, titles, fence info, alt):
// & passes through when it starts a valid entity-like sequence; otherwise &amp;.
// < > " ' always escaped.
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') {
      if (entityEnd(s, i) !== -1) continue; // passes through unchanged
      rep = '&amp;';
    } else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    else continue;
    if (start < i) out += s.slice(start, i);
    out += rep;
    start = i + 1;
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

// Blind escape (code spans/blocks, autolink hrefs/text): every & < > " ' escaped.
function escBlind(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    else continue;
    if (start < i) out += s.slice(start, i);
    out += rep;
    start = i + 1;
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

// cleanUrl: encodeURI, then %25 -> % (so % is never encoded), then
// entity-aware attribute escaping. Returns null if encodeURI throws
// (lone surrogate in dest).
function cleanUrl(dest) {
  let u;
  try {
    u = encodeURI(dest);
  } catch (_e) {
    return null;
  }
  if (u.indexOf('%25') !== -1) u = u.replace(/%25/g, '%');
  return esc(u);
}

// cleanUrlBlind: same as cleanUrl but with blind (non-entity-aware)
// escaping — used for autolink hrefs.
function cleanUrlBlind(dest) {
  let u;
  try {
    u = encodeURI(dest);
  } catch (_e) {
    return null;
  }
  if (u.indexOf('%25') !== -1) u = u.replace(/%25/g, '%');
  return escBlind(u);
}

// --- label folding -----------------------------------------------------------
// Full Unicode case folding (marked folds SS <-> ß, so toLowerCase alone
// is not enough). Apply toLowerCase first, then the full-folding table
// (lowercase forms only).
const FOLD_TABLE = {
  '\u00DF': 'ss', '\u0149': '\u02BCn', '\u01F0': 'j\u030C',
  '\u0390': '\u03B9\u0308\u0301', '\u03B0': '\u03C5\u0308\u0301',
  '\u0587': '\u0565\u0582', '\uFB00': 'ff', '\uFB01': 'fi',
  '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl',
  '\uFB05': 'st', '\uFB06': 'st', '\uFB13': '\u0574\u0576',
  '\uFB14': '\u0574\u0565', '\uFB15': '\u0574\u056B',
  '\uFB16': '\u057E\u0576', '\uFB17': '\u0574\u056D',
  '\u017F': 's',
};
function foldLabel(label) {
  // Collapse whitespace runs (space/tab/newline) to one space, trim,
  // then full case-fold. No entity/escape decoding.
  let s = label.replace(/[ \t\r\n]+/g, ' ').trim();
  s = s.toLowerCase();
  // Apply the full-folding table.
  let out = '';
  for (const ch of s) {
    const f = FOLD_TABLE[ch];
    out += f !== undefined ? f : ch;
  }
  return out;
}

// ---------------------------------------------------------------- inline

// Inline node type codes
const T_TEXT = 0, T_CODE = 1, T_EM = 2, T_STRONG = 3, T_DEL = 4,
      T_LINK = 5, T_IMAGE = 6, T_HTML = 7, T_BR = 8, T_SOFT = 9;

// Decode numeric character references in a plain-text span. Named entities
// pass through unchanged (marked does not decode them).
function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '&') continue;
    const d = decodeNumericRef(s, i);
    if (!d) continue;
    if (start < i) out += s.slice(start, i);
    out += d.ch;
    i = d.end - 1;
    start = d.end;
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

// --- autolink helpers -------------------------------------------------------

// Backpedal: trim trailing punctuation / entities / unmatched parens from a
// raw extended-autolink URL (already scanned as [^\s<]+). Returns the trimmed
// URL string.
function backpedal(raw) {
  let url = raw;
  for (;;) {
    if (url.length === 0) return url;
    const last = url[url.length - 1];
    // (1) trailing named entity &Alnum+;  (no underscore in the name)
    if (last === ';') {
      const m = /&[A-Za-z0-9]+;$/.exec(url);
      if (m) { url = url.slice(0, url.length - m[0].length); continue; }
    }
    // (2) trailing punctuation ? ! . , : ; * _ ~ ' "
    if ('?!.,:;*_~\'"'.indexOf(last) !== -1) { url = url.slice(0, -1); continue; }
    // (3) trailing ')': strip while there is more than one ')' after
    // the last '(' (or any ')' at all when there is no '(').
    if (last === ')') {
      const lastOpen = url.lastIndexOf('(');
      if (lastOpen === -1) { url = url.slice(0, -1); continue; }
      let closesAfter = 0;
      for (let k = lastOpen + 1; k < url.length; k++) if (url[k] === ')') closesAfter++;
      if (closesAfter > 1) { url = url.slice(0, -1); continue; }
      return url;
    }
    return url;
  }
}

// Truncate at the first '(' that has no ')' after it. Runs BEFORE
// backpedal, so a balancing ')' is not stripped first.
function parenTruncate(url) {
  const open = url.indexOf('(');
  if (open === -1) return url;
  // Truncate at the first '(' that has no ')' after it.
  if (url.indexOf(')', open + 1) === -1) return url.slice(0, open);
  return url;
}

// Extended email match at position i (start of a [\w.+-] run).
// Returns { end, email } or null.
// Extended email autolink (GFM): local [\w.+-]+, @, labels [\w-]+,
// the FINAL label must end with an alphanumeric; the char after the
// match must not be [\w-]. The regex engine backtracks to satisfy the
// lookahead (e.g. a@b.c.d- matches a@b.c).
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z0-9](?:[\w-]*[A-Za-z0-9])?(?![\w-])/y;
// Variant used when an open `_` emphasis delimiter precedes the email:
// the email may end right before a `_` closer (e.g. `__a@b.com__` and
// `_a@b.com_` link, but a bare `a@b.com_` does not).
const EMAIL_RE_U = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z0-9](?:[\w-]*[A-Za-z0-9])?(?![A-Za-z0-9-])/y;
function matchEmail(src, i, allowUnderscoreEnd) {
  const re = allowUnderscoreEnd ? EMAIL_RE_U : EMAIL_RE;
  re.lastIndex = i;
  const m = re.exec(src);
  if (!m) return null;
  return { end: i + m[0].length, email: m[0] };
}

// <...> autolink at position i (src[i] === '<'). Returns { end, href, text }
// or null. href/text are the raw (unescaped) values.
function matchAngleAutolink(src, i) {
  const n = src.length;
  // Find the closing '>' (no newlines/tabs/spaces allowed inside; '<' breaks it).
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === '>') break;
    if (c === '<' || c === '\n' || c === '\t' || c === ' ' || c === '\r' || c === '\f' || c === '\v') return null;
    j++;
  }
  if (j >= n || src[j] !== '>') return null;
  const inner = src.slice(i + 1, j);
  if (inner.length === 0) return null;
  // Scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
  const colon = inner.indexOf(':');
  if (colon !== -1) {
    const scheme = inner.slice(0, colon);
    if (scheme.length >= 2 && scheme.length <= 32 && isAlpha(scheme[0])) {
      let ok = true;
      for (let k = 1; k < scheme.length; k++) {
        const c = scheme[k];
        if (!(isAlpha(c) || isDigit(c) || c === '+' || c === '.' || c === '-')) { ok = false; break; }
      }
      if (ok) return { end: j + 1, href: inner, text: inner };
    }
    return null;
  }
  // Email: local@domain
  const at = inner.indexOf('@');
  if (at === -1) return null;
  const local = inner.slice(0, at);
  const domain = inner.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return null;
  // local part: atext minus '^'
  for (let k = 0; k < local.length; k++) {
    const c = local[k];
    if (isWord(c)) continue;
    if ('.!#$%&\'*+/=?`{|}~-'.indexOf(c) !== -1) continue;
    return null;
  }
  // domain: labels of [a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?, >= 2 labels
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  for (const lab of labels) {
    if (lab.length === 0 || lab.length > 63) return null;
    if (!isAlpha(lab[0]) && !isDigit(lab[0])) return null;
    if (!isAlpha(lab[lab.length - 1]) && !isDigit(lab[lab.length - 1])) return null;
    for (let k = 0; k < lab.length; k++) {
      const c = lab[k];
      if (!(isAlpha(c) || isDigit(c) || c === '-')) return null;
    }
  }
  return { end: j + 1, href: 'mailto:' + inner, text: inner };
}

// --- inline HTML ------------------------------------------------------------
// Parse an inline HTML tag starting at src[i] === '<'.
// Returns the end position (just past '>') or -1 if not a valid tag.
function matchHtmlTag(src, i) {
  const n = src.length;
  let j = i + 1;
  if (j >= n) return -1;
  const c = src[j];
  // CDATA <![CDATA[ ... ]]>
  if (c === '!' && src.slice(j + 1, j + 8) === '[CDATA[') {
    const end = src.indexOf(']]>', j + 8);
    if (end === -1) return -1;
    return end + 3;
  }
  // Comment: <!--> is valid; otherwise <!-- ... --> (first --> closes it).
  // The --> may overlap the opening <!-- (as in <!--->).
  if (c === '!' && src[j + 1] === '-' && src[j + 2] === '-') {
    if (src[j + 3] === '>') return j + 4; // <!-->
    const end = src.indexOf('-->', j + 2);
    if (end === -1) return -1;
    return end + 3;
  }
  // Processing instruction <? ... ?>
  if (c === '?') {
    const end = src.indexOf('?>', j + 1);
    if (end === -1) return -1;
    return end + 2;
  }
  // Declaration <!A...>
  if (c === '!') {
    const d = src[j + 1];
    if (d && isAlpha(d)) {
      // need 1+ chars then '>'
      const end = src.indexOf('>', j + 2);
      if (end === -1) return -1;
      if (end === j + 2) return -1; // 0 chars after the letter
      return end + 1;
    }
    return -1;
  }
  // Closing tag </name ...>
  if (c === '/') {
    let k = j + 1;
    if (k >= n || !isAlpha(src[k])) return -1;
    k++;
    while (k < n && (isAlpha(src[k]) || isDigit(src[k]) || src[k] === '-')) k++;
    while (k < n && isSpace(src[k])) k++;
    if (k < n && src[k] === '>') return k + 1;
    return -1;
  }
  // Open tag <name ...>
  if (!isAlpha(c)) return -1;
  let k = j + 1;
  while (k < n && (isAlpha(src[k]) || isDigit(src[k]) || src[k] === '-')) k++;
  // attributes
  for (;;) {
    // skip whitespace
    let hadWs = false;
    while (k < n && isSpace(src[k])) { k++; hadWs = true; }
    if (k >= n) return -1;
    if (src[k] === '>') return k + 1;
    if (src[k] === '/' && src[k + 1] === '>') return k + 2;
    if (!hadWs) return -1;
    // attribute name: [a-zA-Z_:][a-zA-Z0-9_.:-]*
    if (!(isAlpha(src[k]) || src[k] === '_' || src[k] === ':')) return -1;
    k++;
    while (k < n) {
      const a = src[k];
      if (isAlpha(a) || isDigit(a) || a === '_' || a === '.' || a === ':' || a === '-') k++;
      else break;
    }
    // optional = value
    let saveK = k;
    while (k < n && isSpace(src[k])) k++;
    if (k < n && src[k] === '=') {
      k++;
      while (k < n && isSpace(src[k])) k++;
      if (k >= n) return -1;
      const q = src[k];
      if (q === '"' || q === "'") {
        k++;
        while (k < n && src[k] !== q) k++;
        if (k >= n) return -1;
        k++; // closing quote
      } else {
        // unquoted value: 1+ chars, none of space " ' = < > `
        const vStart = k;
        while (k < n) {
          const v = src[k];
          if (v === ' ' || v === '\t' || v === '\n' || v === '\r' || v === '\f' || v === '\v' ||
              v === '"' || v === "'" || v === '=' || v === '<' || v === '>' || v === '`') break;
          k++;
        }
        if (k === vStart) return -1; // empty value
      }
    } else {
      k = saveK;
    }
  }
}

// --- link dest/title parsing ----------------------------------------------

// Parse a link destination starting at src[i]. Returns { dest, end } where
// end is the position just past the dest, or null.
// If angleOk, a <...> dest is tried first (with the lazy-> scan: each '>'
// is tried in turn by the caller via tryRest).
// Bare dest: no spaces/control chars/newlines; balanced parens;
// backslash escapes unescaped.
function parseBareDest(src, i) {
  const n = src.length;
  let j = i;
  let depth = 0;
  let dest = '';
  let start = i;
  while (j < n) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') break;
    const code = src.charCodeAt(j);
    if (code < 0x20 || code === 0x7f) break; // control char ends the dest
    if (c === '(') { depth++; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; j++; continue;
    }
    if (c === '\\' && j + 1 < n && isPunct(src[j + 1])) {
      dest += src.slice(start, j) + src[j + 1];
      j += 2;
      start = j;
      continue;
    }
    j++;
  }
  dest += src.slice(start, j);
  return { dest, end: j };
}

// Parse a link title starting at src[i] (the opening quote/paren).
// Returns { title, end } or null. Title may span lines.
function parseTitle(src, i) {
  const n = src.length;
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let j = i + 1;
  let title = '';
  let start = j;
  while (j < n) {
    const c = src[j];
    if (c === '\\' && j + 1 < n && isPunct(src[j + 1])) {
      title += src.slice(start, j) + src[j + 1];
      j += 2;
      start = j;
      continue;
    }
    if (c === close) {
      title += src.slice(start, j);
      return { title, end: j + 1 };
    }
    if (q === '(' && c === '(') return null; // unescaped ( in parens title
    j++;
  }
  return null;
}

// Skip spaces/tabs/newlines (but not across a blank line — the caller
// ensures the input has no blank line inside a link).
function skipInlineWs(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
    else break;
  }
  return i;
}

// Try to complete an inline link after the dest (at position i):
// optional whitespace + optional title + optional whitespace + ')'.
// Returns { title, end } or null.
function tryLinkRest(src, i) {
  const n = src.length;
  let j = skipInlineWs(src, i);
  let title = null;
  if (j < n && (src[j] === '"' || src[j] === "'" || src[j] === '(')) {
    const t = parseTitle(src, j);
    if (!t) return null;
    title = t.title;
    j = t.end;
    j = skipInlineWs(src, j);
  }
  if (j < n && src[j] === ')') return { title, end: j + 1 };
  return null;
}

// Parse an inline link "(...)" starting at src[i] === '('.
// Returns { dest, title, end } or null.
function parseInlineLink(src, i) {
  const n = src.length;
  let j = skipInlineWs(src, i + 1);
  if (j >= n) return null;
  // <...> dest: try each '>' in turn (lazy scan with retry).
  if (src[j] === '<') {
    let k = j + 1;
    // collect candidate '>' positions (no newlines allowed inside)
    while (k < n) {
      const c = src[k];
      if (c === '\n' || c === '\r') return null;
      if (c === '\\' && k + 1 < n && isPunct(src[k + 1])) { k += 2; continue; }
      if (c === '>') {
        // try completing the link with the dest ending here
        const rest = tryLinkRest(src, k + 1);
        if (rest) {
          // unescape the dest
          let dest = src.slice(j + 1, k);
          if (dest.indexOf('\\') !== -1) {
            dest = dest.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
          }
          return { dest, title: rest.title, end: rest.end };
        }
        // else: this '>' doesn't yield a valid link; keep scanning
      }
      k++;
    }
    return null;
  }
  // bare dest
  const d = parseBareDest(src, j);
  const rest = tryLinkRest(src, d.end);
  if (!rest) return null;
  return { dest: d.dest, title: rest.title, end: rest.end };
}

// Parse a link label "[...]" starting at src[i] === '['.
// Returns { label, end } (label is the raw source, undecoded) or null.
// The label may span lines but not a blank line; no unescaped [ or ].
function parseLinkLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === '\\' && j + 1 < n && isPunct(src[j + 1])) { j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') return { label: src.slice(i + 1, j), end: j + 1 };
    j++;
  }
  return null;
}

// Marked's link-label backtick pairing quirk: when marked looks for the
// ']' closing a link label, it pairs consecutive backtick runs
// (R1,R2), (R3,R4), ... as code spans. An unpaired leftover run blocks
// the inline and full-reference link forms unless it ends exactly at the
// ']' and has length >= 2. Shortcut and collapsed links are unaffected
// (they use a different rule). Returns true if the label (src between
// openPos '[' and closePos ']') blocks the link.
function labelPairingBlocks(src, openPos, closePos) {
  let runCount = 0;
  let lastRunEnd = -1, lastRunLen = 0;
  let i = openPos + 1;
  while (i < closePos) {
    const c = src[i];
    if (c === '\\' && i + 1 < closePos && isPunct(src[i + 1])) { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (j < closePos && src[j] === '`') j++;
      runCount++;
      lastRunEnd = j;
      lastRunLen = j - i;
      i = j;
      continue;
    }
    i++;
  }
  if (runCount % 2 === 0) return false;
  return !(lastRunEnd === closePos && lastRunLen >= 2);
}

// Find the ')' matching the '(' at src[openPos] (balanced parens, no
// string awareness). Returns the position of the matching ')' or -1.
function findParenEnd(src, openPos) {
  let depth = 0;
  for (let i = openPos; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Marked's findClosingBracket: find the ']' closing the bracket at
// src[openPos] ('['), pairing consecutive backtick runs as code spans
// (a ']' between a paired run pair is skipped). An unpaired leftover run
// only lets a ']' through if it ends exactly there and has length >= 2.
// Returns the position of the closing ']' or -1.
function findBracketClose(src, openPos) {
  const n = src.length;
  let depth = 0;
  let pendingEnd = -1, pendingLen = 0; // unpaired backtick run, if any
  let i = openPos + 1;
  while (i < n) {
    const c = src[i];
    if (c === '\\' && i + 1 < n && isPunct(src[i + 1])) { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      if (pendingEnd === -1) { pendingEnd = j; pendingLen = j - i; }
      else { pendingEnd = -1; pendingLen = 0; }
      i = j;
      continue;
    }
    if (c === '[') {
      if (pendingEnd === -1) depth++;
      i++;
      continue;
    }
    if (c === ']') {
      if (pendingEnd !== -1) {
        // ']' inside a potential code span: look for the partner run.
        let k = i + 1;
        while (k < n && src[k] !== '`') k++;
        if (k < n) { i++; continue; } // partner exists; ']' is inside
        // No partner: leftover run. Closer only if it ends right here
        // and has length >= 2.
        if (pendingEnd === i && pendingLen >= 2 && depth === 0) return i;
        return -1;
      }
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// Raw closing ']' position for a bracket (cached), or -1 if none.
// (bracketLinkClose returns the ']' only when the bracket forms a link.)
function bracketClosePos(src, bracket) {
  if (bracket.closePos === undefined) {
    bracket.closePos = findBracketClose(src, bracket.srcPos + (bracket.isImage ? 1 : 0));
  }
  return bracket.closePos;
}

// Does the bracket form a link? Returns the closing ']' position if so,
// else -1. Mirrors the ']' handler's decision (pairing rule, inline /
// full-reference / collapsed / shortcut forms).
function bracketLinkClose(src, bracket, refs) {
  const closePos = bracketClosePos(src, bracket);
  if (closePos === -1) return -1;
  const textStartPos = bracket.srcPos + (bracket.isImage ? 2 : 1);
  const pairingBlocked = labelPairingBlocks(src, textStartPos - 1, closePos);
  const next = closePos + 1 < src.length ? src[closePos + 1] : '';
  const labelKey = foldLabel(src.slice(textStartPos, closePos));
  const shortcut = labelKey !== '' && refs.get(labelKey);
  if (next === '(') {
    if (!pairingBlocked && parseInlineLink(src, closePos + 1)) return closePos;
    return shortcut ? closePos : -1;
  }
  if (next === '[') {
    const lab = parseLinkLabel(src, closePos + 1);
    if (lab && lab.label !== '' && pairingBlocked) {
      return shortcut ? closePos : -1;
    }
    if (lab) {
      const key = lab.label === '' ? labelKey : foldLabel(lab.label);
      return (key !== '' && refs.get(key)) ? closePos : -1;
    }
    return shortcut ? closePos : -1;
  }
  return shortcut ? closePos : -1;
}

// True if any currently-open bracket will form a link (so an autolink
// at the current position would be inside link text and must not form).
function anyBracketWillLink(src, brackets, refs) {
  for (let b = brackets.length - 1; b >= 0; b--) {
    if (!brackets[b].active) continue;
    if (brackets[b].linkClose === undefined) {
      brackets[b].linkClose = bracketLinkClose(src, brackets[b], refs);
    }
    if (brackets[b].linkClose !== -1) return true;
  }
  return false;
}

// Global backtick-run pairing (proper code-span matching, by length,
// left-to-right) across the paragraph. Marked pairs runs including those
// inside link labels; when a link consumes part of a paired region, the
// em/strong/del delimiters in the surviving part are still suppressed
// (they behave as if inside a code span). `exclude` is [start,end]
// ranges whose backticks do not participate (link destinations / ref
// labels). `masked` marks positions inside <...> tags (also excluded).
// Returns [start,end] regions.
function computeBacktickRegions(src, exclude, masked) {
  const n = src.length;
  const runs = [];
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '\\' && i + 1 < n && src[i + 1] === '`') {
      // Escaped backtick run: the first backtick is escaped, so the run
      // cannot open a code span, but marked's codespan regex still
      // accepts it as a closer. Record it as closer-only.
      let j = i + 1;
      while (j < n && src[j] === '`') j++;
      let ex = masked[i + 1] === 1;
      if (!ex) {
        for (let e = 0; e < exclude.length; e++) {
          if (i + 1 >= exclude[e][0] && i + 1 < exclude[e][1]) { ex = true; break; }
        }
      }
      if (!ex) runs.push([i + 1, j, true]);
      i = j;
      continue;
    }
    if (c === '\\' && i + 1 < n && isPunct(src[i + 1])) { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      let ex = masked[i] === 1;
      if (!ex) {
        for (let e = 0; e < exclude.length; e++) {
          if (i >= exclude[e][0] && i < exclude[e][1]) { ex = true; break; }
        }
      }
      if (!ex) runs.push([i, j, false]);
      i = j;
      continue;
    }
    i++;
  }
  const regions = [];
  let k = 0;
  while (k < runs.length) {
    if (runs[k][2]) { k++; continue; } // escaped run cannot open
    const len = runs[k][1] - runs[k][0];
    let j = k + 1;
    while (j < runs.length && runs[j][1] - runs[j][0] !== len) j++;
    if (j < runs.length) {
      regions.push([runs[k][0], runs[j][1]]);
      k = j + 1;
    } else {
      k++;
    }
  }
  return regions;
}

// --- emphasis processing ----------------------------------------------------

// Length of the next `*` run at or after index j in src (0 if none).
function nextStarRun(src, j) {
  const k = src.indexOf('*', j);
  if (k === -1) return 0;
  let e = k;
  while (e < src.length && src[e] === '*') e++;
  return e - k;
}

// Process the delimiter stack (delims) above index `bottom` (exclusive),
// forming em/strong/del nodes in `nodes`.
function processEmphasis(nodes, delims, bottom) {
  // Process closers left-to-right (the inner closer first), per the
  // CommonMark algorithm: the leftmost closer matches first.
  let current = bottom + 1;
  while (current < delims.length) {
    const closer = delims[current];
    if (!closer.active || !closer.canClose) { current++; continue; }
    // Effective bottom: the call's bottom or the closer's own bracket
    // boundary, whichever is higher.
    const effBottom = Math.max(bottom, closer.bottom);
    // Search backwards for a matching opener.
    let openerIdx = current - 1;
    let found = -1;
    while (openerIdx > effBottom) {
      const opener = delims[openerIdx];
      if (!opener.active || opener.ch !== closer.ch || !opener.canOpen) { openerIdx--; continue; }
      if (closer.ch === '~') {
        if (opener.len !== closer.len) { openerIdx--; continue; }
      } else {
        const odd = ((opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose)) &&
          ((opener.len + closer.len) % 3 === 0) &&
          (opener.len % 3 !== 0 || closer.len % 3 !== 0);
        if (odd) { openerIdx--; continue; }
        // Marked quirk: do not partially match a longer opener (e.g. **)
        // with a shorter closer (e.g. *) when a later closer could match
        // the opener fully; the shorter closer stays literal.
        if (opener.len > closer.len) {
          let laterFull = false;
          for (let k = current + 1; k < delims.length; k++) {
            const d = delims[k];
            if (d.active && d.ch === closer.ch && d.canClose && d.len >= opener.len) {
              laterFull = true;
              break;
            }
          }
          if (laterFull) { openerIdx--; continue; }
        }
      }
      found = openerIdx;
      break;
    }
    if (found === -1) { current++; continue; }
    const opener = delims[found];
    const use = closer.ch === '~' ? closer.len
      : (opener.len >= 2 && closer.len >= 2 ? 2 : 1);
    const oNode = opener.node;
    const cNode = closer.node;
    const oIdx = nodes.indexOf(oNode);
    const cIdx = nodes.indexOf(cNode);
    if (oIdx === -1 || cIdx === -1 || oIdx >= cIdx) { current++; continue; }
    opener.len -= use;
    closer.len -= use;
    oNode.s = oNode.s.slice(0, oNode.s.length - use);
    cNode.s = cNode.s.slice(use);
    const children = nodes.slice(oIdx + 1, cIdx);
    const emNode = { t: closer.ch === '~' ? T_DEL : (use === 2 ? T_STRONG : T_EM), c: children };
    // Marked quirk: a leftover closer run goes INSIDE the em/strong when
    // the last inner em/strong is followed only by non-space text
    // (`**a *b*c***` -> `<strong>a <em>b</em>c*</strong>`; but
    // `**a *b* c***` and `**a *b****` keep the leftover outside).
    let leftoverInside = false;
    if (cNode.s.length > 0 && closer.ch !== '~' && use === 2) {
      let lastEmIdx = -1;
      for (let k = children.length - 1; k >= 0; k--) {
        if (children[k].t === T_EM || children[k].t === T_STRONG || children[k].t === T_DEL) { lastEmIdx = k; break; }
      }
      if (lastEmIdx !== -1 && lastEmIdx < children.length - 1) {
        let ok = true;
        for (let k = lastEmIdx + 1; k < children.length; k++) {
          if (children[k].t !== T_TEXT || /\s/.test(children[k].s)) { ok = false; break; }
        }
        leftoverInside = ok;
      }
    }
    if (leftoverInside) {
      emNode.c.push(cNode);
      closer.active = false;
    }
    const replacement = [];
    if (oNode.s.length > 0) replacement.push(oNode);
    replacement.push(emNode);
    if (cNode.s.length > 0 && !leftoverInside) replacement.push(cNode);
    nodes.splice(oIdx, cIdx - oIdx + 1, ...replacement);
    // Delimiters between the opener and closer are now inside the em node
    // and can no longer match outside it.
    for (let k = found + 1; k < current; k++) delims[k].active = false;
    // Marked quirk: when an inner * em/strong forms whose opener was
    // preceded by whitespace (can open but not close) and whose closer is
    // followed by a word character, it blocks outer * delimiters of the
    // complementary length (1 for a strong, 2 for an em) from matching
    // across it — but only when the next * run after the inner closer is
    // that outer closer (no other * delimiter in between).
    if (closer.ch === '*' && opener.canOpen && !opener.canClose && closer.afterWord) {
      const blockLen = use === 2 ? 1 : 2;
      if (closer.nextStarLen === blockLen) {
        for (let k = 0; k < found; k++) {
          if (delims[k].ch === '*' && delims[k].len === blockLen && delims[k].canOpen) {
            delims[k].active = false;
          }
        }
      }
    }
    if (opener.len === 0) opener.active = false;
    if (closer.len === 0) { closer.active = false; current++; }
    // If the closer still has length, stay on it (loop again).
  }
}

// Render inline nodes to plain alt text (for images).
// HTML tags contribute their raw source; entities pass through (numeric
// refs were already decoded at parse time); hard breaks are removed;
// soft breaks become '\n'.
function renderAlt(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case T_TEXT: out += node.s; break;
      case T_CODE: out += node.s; break;
      case T_EM: case T_STRONG: case T_DEL: case T_LINK:
        out += renderAlt(node.c); break;
      case T_IMAGE: out += node.alt; break;
      case T_HTML: out += node.s; break;
      case T_BR: break; // removed
      case T_SOFT: out += '\n'; break;
    }
  }
  return out;
}

// Render inline nodes to HTML.
function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case T_TEXT: out += node.raw ? escBlind(node.s) : esc(node.s); break;
      case T_CODE: out += '<code>' + escBlind(node.s) + '</code>'; break;
      case T_EM: out += '<em>' + renderInline(node.c) + '</em>'; break;
      case T_STRONG: out += '<strong>' + renderInline(node.c) + '</strong>'; break;
      case T_DEL: out += '<del>' + renderInline(node.c) + '</del>'; break;
      case T_LINK: {
        out += '<a href="' + node.href + '"';
        if (node.title) out += ' title="' + esc(node.title) + '"';
        out += '>' + renderInline(node.c) + '</a>';
        break;
      }
      case T_IMAGE: {
        out += '<img src="' + node.href + '" alt="' + esc(node.alt) + '"';
        if (node.title) out += ' title="' + esc(node.title) + '"';
        out += '>';
        break;
      }
      case T_HTML: out += node.s; break;
      case T_BR: out += '<br>'; break;
      case T_SOFT: out += '\n'; break;
    }
  }
  return out;
}

// --- the inline parser ------------------------------------------------------

function parseInline(src, refs) {
  const n = src.length;
  const nodes = [];
  const delims = [];
  const brackets = [];
  let activeBrackets = 0; // count of active (not yet deactivated) brackets
  // Emphasis suppression: after a failed `[...](...)` link, marked renders
  // the whole span (label + parens) with emphasis disabled. Delimiters
  // created before this position are inactive.
  let suppressEmUntil = -1;
  // Ranges of formed links' tails (destination / ref label): backticks
  // inside them do not participate in the global backtick pairing.
  const destRanges = [];
  // True if a link/image formed whose label contains a backtick (the
  // global pairing may then shift and suppress emphasis after the link).
  let backtickLink = false;
  // Masked positions for emphasis delimiters: from a '<' (next char not a
  // space) to the next '>'. A second '<' before that '>' aborts the mask.
  const masked = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (src[i] === '<' && i + 1 < n && src[i + 1] !== ' ') {
      const gt = src.indexOf('>', i + 1);
      if (gt !== -1) {
        const lt2 = src.indexOf('<', i + 1);
        if (lt2 === -1 || lt2 > gt) {
          for (let k = i + 1; k < gt; k++) masked[k] = 1;
        }
      }
    }
  }
  let lastWasEscape = false;
  const isTokenNode = (node) => node && (node.t === T_CODE || node.t === T_LINK || node.t === T_IMAGE ||
    node.t === T_HTML || node.t === T_EM || node.t === T_STRONG || node.t === T_DEL);
  // Deactivate open brackets whose closing ']' was consumed by an
  // autolink spanning [start, end) (marked lets the autolink win, so the
  // bracket is dead text). Delimiters inside it may then match outside.
  const deactivateConsumed = (start, end) => {
    for (let b = 0; b < brackets.length; b++) {
      if (!brackets[b].active) continue;
      const cp = bracketClosePos(src, brackets[b]);
      if (cp !== -1 && cp >= start && cp < end) {
        brackets[b].active = false;
        activeBrackets--;
        let newBottom = -1;
        for (let b2 = brackets.length - 1; b2 >= 0; b2--) {
          if (brackets[b2].active) { newBottom = brackets[b2].delimCount - 1; break; }
        }
        for (let d = brackets[b].delimCount; d < delims.length; d++) {
          if (delims[d].bottom === brackets[b].delimCount - 1) delims[d].bottom = newBottom;
        }
      }
    }
  };

  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) {
      nodes.push({ t: T_TEXT, s: decodeEntities(src.slice(textStart, end)) });
      lastWasEscape = false;
    }
  };

  while (i < n) {
    const c = src[i];
    // --- newline: hard or soft break
    if (c === '\n') {
      // check trailing spaces (only if more text follows the newline)
      if (i + 1 < n) {
        let broke = false;
        if (textStart < i) {
          // pending unflushed text
          let sp = 0;
          let k = i - 1;
          while (k >= textStart && src[k] === ' ') { sp++; k--; }
          if (sp >= 2) {
            flushText(i - sp);
            nodes.push({ t: T_BR });
            lastWasEscape = false;
            broke = true;
          }
        } else {
          const last = nodes.length > 0 ? nodes[nodes.length - 1] : null;
          if (last && last.t === T_TEXT) {
            let sp = 0;
            let k = last.s.length - 1;
            while (k >= 0 && last.s[k] === ' ') { sp++; k--; }
            if (sp >= 2) {
              last.s = last.s.slice(0, last.s.length - sp);
              if (last.s.length === 0) nodes.pop();
              nodes.push({ t: T_BR });
              lastWasEscape = false;
              broke = true;
            }
          }
        }
        if (broke) {
          i++;
          // A hard break strips leading spaces/tabs from the next line.
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          textStart = i;
          continue;
        }
      }
      flushText(i);
      nodes.push({ t: T_SOFT });
      lastWasEscape = false;
      i++;
      textStart = i;
      continue;
    }
    // --- backslash escape / hard break
    if (c === '\\') {
      if (i + 1 < n && isPunct(src[i + 1])) {
        flushText(i);
        nodes.push({ t: T_TEXT, s: src[i + 1] });
        lastWasEscape = true;
        i += 2;
        textStart = i;
        continue;
      }
      if (i + 1 < n && src[i + 1] === '\n') {
        if (i + 2 < n) {
          flushText(i);
          nodes.push({ t: T_BR });
          lastWasEscape = false;
          i += 2;
          // A hard break strips leading spaces/tabs from the next line.
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          textStart = i;
          continue;
        }
        // trailing backslash-newline at end: literal backslash; the \n
        // is handled as a soft break next iteration.
        i++;
        continue;
      }
      i++;
      continue;
    }
    // --- code span
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const runLen = j - i;
      // Inside a bracket that will form a link, the code span cannot cross
      // the bracket's closing ']' (marked matches the link first, so the
      // code span is tokenized within the label).
      let searchEnd = n;
      if (activeBrackets > 0) {
        for (let b = brackets.length - 1; b >= 0; b--) {
          if (brackets[b].active) {
            if (brackets[b].linkClose === undefined) {
              brackets[b].linkClose = bracketLinkClose(src, brackets[b], refs);
            }
            if (brackets[b].linkClose !== -1) searchEnd = brackets[b].linkClose;
            break;
          }
        }
      }
      // find a closing run of exactly runLen backticks
      let close = -1;
      let k = j;
      while (k < searchEnd) {
        if (src[k] === '`') {
          let m = k;
          while (m < n && src[m] === '`') m++;
          if (m - k === runLen) { close = k; break; }
          k = m;
        } else k++;
      }
      if (close !== -1) {
        flushText(i);
        let content = src.slice(j, close);
        content = content.replace(/\n/g, ' ');
        if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ' &&
            content.trim() !== '') {
          content = content.slice(1, -1);
        }
        nodes.push({ t: T_CODE, s: content });
        lastWasEscape = false;
        i = close + runLen;
        textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    // --- emphasis / strikethrough delimiters
    if ((c === '*' || c === '_' || c === '~') && !masked[i]) {
      let j = i;
      while (j < n && src[j] === c) j++;
      const runLen = j - i;
      if (c === '~' && runLen > 2) { i = j; continue; } // literal text
      // flanking
      const before = i > 0 ? src[i - 1] : '';
      const after = j < n ? src[j] : '';
      const beforeWs = before === '' || isWS(before);
      const afterWs = after === '' || isWS(after);
      const beforePunct = before !== '' && (isPunct(before) || isUnicodePunct(before));
      const afterPunct = after !== '' && (isPunct(after) || isUnicodePunct(after));
      const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      if (!canOpen && !canClose) { i = j; continue; } // literal text
      flushText(i);
      const node = { t: T_TEXT, s: src.slice(i, j) };
      nodes.push(node);
      lastWasEscape = false;
      // A closer inside an open bracket cannot match an opener from before
      // that bracket (a link boundary blocks emphasis matching). Record the
      // bracket boundary at creation time; processEmphasis enforces it.
      let delimBottom = -1;
      for (let b = brackets.length - 1; b >= 0; b--) {
        if (brackets[b].active) { delimBottom = brackets[b].delimCount - 1; break; }
      }
      delims.push({ node, ch: c, len: runLen, canOpen, canClose, active: true,
        afterWord: after !== '' && isAlnum(after),
        nextStarLen: nextStarRun(src, j), bottom: delimBottom, pos: i });
      // Inside a failed-link span, emphasis delimiters stay literal.
      if (i < suppressEmUntil) delims[delims.length - 1].active = false;
      i = j;
      textStart = i;
      continue;
    }
    // --- link/image opener
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const isImage = c === '!';
      const len = isImage ? 2 : 1;
      flushText(i);
      const node = { t: T_TEXT, s: src.slice(i, i + len) };
      nodes.push(node);
      lastWasEscape = false;
      brackets.push({ node, srcPos: i, isImage, active: true, delimCount: delims.length });
      activeBrackets++;
      i += len;
      textStart = i;
      continue;
    }
    // --- link closer
    if (c === ']') {
      // A ] closes the most recently opened bracket (pop the stack). If
      // that bracket was already deactivated, the ] is literal text and
      // the bracket is discarded; an earlier bracket is tried only at a
      // later ] (cm-512/528: triple-nested brackets).
      if (brackets.length === 0) { i++; continue; } // literal ]
      const bracket = brackets.pop();
      if (bracket.active) activeBrackets--;
      if (!bracket.active) { i++; continue; } // literal ]
      // Try inline, reference/collapsed, then shortcut. No shortcut
      // fallback when ( or [ follows (an attempted link form blocks it).
      let href = null, title = null, endPos = -1, isRef = false;
      const next = i + 1 < n ? src[i + 1] : '';
      const textStartPos = bracket.srcPos + (bracket.isImage ? 2 : 1);
      // Marked's backtick-pairing quirk blocks the inline and full-reference
      // forms for this label (shortcut/collapsed are unaffected).
      const pairingBlocked = labelPairingBlocks(src, textStartPos - 1, i);
      if (next === '(') {
        const link = pairingBlocked ? null : parseInlineLink(src, i + 1);
        if (link) {
          href = cleanUrl(link.dest);
          title = link.title;
          endPos = link.end;
        } else {
          // The inline form did not parse: fall back to the shortcut.
          const key = foldLabel(src.slice(textStartPos, i));
          const ref = key !== '' ? refs.get(key) : undefined;
          if (ref) {
            href = ref.href;
            title = ref.title;
            endPos = i + 1;
            isRef = true;
          }
        }
      } else if (next === '[') {
        const lab = parseLinkLabel(src, i + 1);
        if (lab && lab.label !== '' && pairingBlocked) {
          // Full reference blocked by the pairing quirk: fall back to the
          // shortcut (the link text as the label).
          const key = foldLabel(src.slice(textStartPos, i));
          const ref = key !== '' ? refs.get(key) : undefined;
          if (ref) {
            href = ref.href;
            title = ref.title;
            endPos = i + 1;
            isRef = true;
          }
        } else if (lab) {
          let key;
          if (lab.label === '') {
            key = foldLabel(src.slice(textStartPos, i));
          } else {
            key = foldLabel(lab.label);
          }
          const ref = key !== '' ? refs.get(key) : undefined;
          if (ref) {
            href = ref.href;
            title = ref.title;
            endPos = lab.end;
            isRef = true;
          }
        } else {
          // Malformed label: fall back to the shortcut.
          const key = foldLabel(src.slice(textStartPos, i));
          const ref = key !== '' ? refs.get(key) : undefined;
          if (ref) {
            href = ref.href;
            title = ref.title;
            endPos = i + 1;
            isRef = true;
          }
        }
      } else {
        // Shortcut reference.
        const key = foldLabel(src.slice(textStartPos, i));
        const ref = key !== '' ? refs.get(key) : undefined;
        if (ref) {
          href = ref.href;
          title = ref.title;
          endPos = i + 1;
          isRef = true;
        }
      }
      if (endPos === -1) {
        // Failed `[...](...)` with a complete paren group: marked renders
        // the whole span (label + parens) with emphasis disabled.
        if (next === '(') {
          const parenEnd = findParenEnd(src, i + 1);
          if (parenEnd !== -1) {
            for (let d = bracket.delimCount; d < delims.length; d++) {
              delims[d].active = false;
            }
            suppressEmUntil = parenEnd;
          }
        }
        // The bracket did not form a link: delimiters directly inside it
        // (bottom === this bracket's boundary) may now match outside it
        // (cm-523: `*foo [bar* baz]` forms an em across the failed bracket).
        let newBottom = -1;
        for (let b = brackets.length - 1; b >= 0; b--) {
          if (brackets[b].active) { newBottom = brackets[b].delimCount - 1; break; }
        }
        for (let d = bracket.delimCount; d < delims.length; d++) {
          if (delims[d].bottom === bracket.delimCount - 1) delims[d].bottom = newBottom;
        }
        // No link: deactivate every remaining bracket except the outermost
        // active one, so a later ] tries the outermost (cm-512/528).
        let outerIdx = -1;
        for (let b = 0; b < brackets.length; b++) {
          if (brackets[b].active) { outerIdx = b; break; }
        }
        for (let b = (outerIdx === -1 ? 0 : outerIdx + 1); b < brackets.length; b++) {
          if (brackets[b].active) { brackets[b].active = false; activeBrackets--; }
        }
        i++;
        continue;
      }
      // A link was found. Record the tail (destination / ref label) for
      // the global backtick pairing, and note backticks in the label.
      if (endPos > i + 1) destRanges.push([i + 1, endPos]);
      if (!backtickLink) {
        const bq = src.indexOf('`', textStartPos);
        if (bq !== -1 && bq < i) backtickLink = true;
      }
      // Extract the link text nodes.
      flushText(i);
      const oIdx = nodes.indexOf(bracket.node);
      if (oIdx === -1) { i++; continue; } // bracket node no longer top-level
      // Process emphasis inside the link text (delimiters added after '[').
      processEmphasis(nodes, delims, bracket.delimCount - 1);
      // Re-find the bracket node (processEmphasis may have spliced nodes).
      const oIdx2 = nodes.indexOf(bracket.node);
      if (oIdx2 === -1) { i++; continue; }
      const linkText = nodes.slice(oIdx2 + 1);
      // If the link text has unbalanced [ (more [ than ]), the closing ]
      // is itself part of the text (marked quirk).
      {
        let opens = 0, closes = 0;
        const raw = src.slice(textStartPos, i);
        for (let q = 0; q < raw.length; q++) {
          if (raw[q] === '\\' && q + 1 < raw.length) { q++; continue; }
          if (raw[q] === '[') opens++;
          else if (raw[q] === ']') closes++;
        }
        if (opens > closes) linkText.push({ t: T_TEXT, s: ']' });
      }
      // Truncate the delimiter stack to before the '[' (delimiters inside
      // the link text can no longer match outside it).
      delims.length = bracket.delimCount;
      // Remove the '[' node and the link text nodes from `nodes`.
      nodes.length = oIdx2;
      // The bracket was already popped. Deactivate earlier LINK brackets
      // if this is a link (images may contain links).
      if (!bracket.isImage) {
        for (let b = 0; b < brackets.length; b++) {
          if (!brackets[b].isImage && brackets[b].active) { brackets[b].active = false; activeBrackets--; }
        }
      }
      if (bracket.isImage) {
        const alt = renderAlt(linkText);
        if (href === null) {
          // null href: render as the alt text
          if (alt !== '') nodes.push({ t: T_TEXT, s: alt });
        } else {
          nodes.push({ t: T_IMAGE, href, title: title === null ? undefined : title, alt });
        }
      } else {
        if (href === null) {
          // null href: render as the link text (no <a> wrapper)
          for (const nd of linkText) nodes.push(nd);
        } else {
          nodes.push({ t: T_LINK, href, title: title === null ? undefined : title, c: linkText });
        }
      }
      lastWasEscape = false;
      i = endPos;
      textStart = i;
      continue;
    }
    // --- '<': autolink or HTML tag
    if (c === '<') {
      const auto = matchAngleAutolink(src, i);
      if (auto) {
        const href = cleanUrlBlind(auto.href);
        if (href !== null) {
          flushText(i);
          nodes.push({ t: T_LINK, href, title: undefined, c: [{ t: T_TEXT, s: auto.text, raw: true }] });
          lastWasEscape = false;
          i = auto.end;
          textStart = i;
          continue;
        }
      }
      const tagEnd = matchHtmlTag(src, i);
      if (tagEnd !== -1) {
        flushText(i);
        const tagSrc = src.slice(i, tagEnd);
        nodes.push({ t: T_HTML, s: tagSrc });
        // `<a ...>` leaks in-link state; `</a>` clears it. The char right
        // after the tag name must not be a newline (`<a\nhref>` does not
        // leak, but a newline inside an attribute value still does).
        const lc = tagSrc.toLowerCase();
        if (/^<\/a[ \t>]/.test(lc)) inHtmlLink = false;
        else if (/^<a[ \t]/.test(lc)) inHtmlLink = true;
        lastWasEscape = false;
        i = tagEnd;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // --- extended autolinks: http/https/ftp, www., mailto:/xmpp:, email
    // (suppressed inside a bracket that will form a link: marked does
    // not render extended autolinks inside link text, though <...>
    // autolinks do render; if the bracket will NOT form a link, the
    // autolink renders, and a URL spanning past ']' consumes it.
    // Also suppressed while an unclosed inline <a> leaks in-link state)
    if ((c === 'h' || c === 'H' || c === 'f' || c === 'F') &&
        (activeBrackets === 0 || !anyBracketWillLink(src, brackets, refs)) && !inHtmlLink) {
      const rest = src.slice(i, i + 8).toLowerCase();
      let schemeLen = 0;
      if (rest.startsWith('http://')) schemeLen = 7;
      else if (rest.startsWith('https://')) schemeLen = 8;
      else if (src.slice(i, i + 6).toLowerCase() === 'ftp://') schemeLen = 6;
      if (schemeLen > 0) {
        let j = i + schemeLen;
        while (j < n && !isWS(src[j]) && src[j] !== '<') j++;
        let url = backpedal(parenTruncate(src.slice(i, j)));
        if (url.length > schemeLen) {
          const href = cleanUrlBlind(url);
          if (href !== null) {
            flushText(i);
            nodes.push({ t: T_LINK, href, title: undefined, c: [{ t: T_TEXT, s: url, raw: true }] });
            lastWasEscape = false;
            if (activeBrackets > 0) deactivateConsumed(i, i + url.length);
            i += url.length;
            textStart = i;
            continue;
          }
        }
      }
      // No scheme autolink: fall through to the email check below
      // (an email local part may start with f or h).
    }
    if (c === 'w' && src.slice(i, i + 4) === 'www.' &&
        (activeBrackets === 0 || !anyBracketWillLink(src, brackets, refs)) && !inHtmlLink) {
      // preceding-char check
      let ok = false;
      if (i === 0) ok = true;
      else if (lastWasEscape && textStart === i) ok = true;
      else if (nodes.length > 0 && isTokenNode(nodes[nodes.length - 1]) && textStart === i) ok = true;
      else {
        const prev = src[i - 1];
        if (isWS(prev) || prev === '(' || prev === '*' || prev === '_' || prev === '~') ok = true;
      }
      if (ok) {
        let j = i;
        while (j < n && !isWS(src[j]) && src[j] !== '<') j++;
        let url = backpedal(parenTruncate(src.slice(i, j)));
        if (url.length > 4) {
          const href = cleanUrlBlind('http://' + url);
          if (href !== null) {
            flushText(i);
            nodes.push({ t: T_LINK, href, title: undefined, c: [{ t: T_TEXT, s: url, raw: true }] });
            lastWasEscape = false;
            if (activeBrackets > 0) deactivateConsumed(i, i + url.length);
            i += url.length;
            textStart = i;
            continue;
          }
        }
      }
      // No www autolink: fall through to the email check below.
    }
    if (((c === 'm' && src.slice(i, i + 7) === 'mailto:') ||
        (c === 'x' && src.slice(i, i + 5) === 'xmpp:')) &&
        (activeBrackets === 0 || !anyBracketWillLink(src, brackets, refs)) && !inHtmlLink) {
      const schemeLen = c === 'm' ? 7 : 5;
      const em = matchEmail(src, i + schemeLen);
      if (em && em.end > i + schemeLen) {
        let end = em.end;
        // xmpp: may carry a /resource (one path segment, no further /).
        if (c === 'x' && end < n && src[end] === '/') {
          let r = end + 1;
          while (r < n && !isWS(src[r]) && src[r] !== '<' && src[r] !== '/') r++;
          if (r > end + 1) end = r;
        }
        flushText(i);
        const full = src.slice(i, end);
        nodes.push({ t: T_LINK, href: cleanUrlBlind(full), title: undefined, c: [{ t: T_TEXT, s: full, raw: true }] });
        lastWasEscape = false;
        if (activeBrackets > 0) deactivateConsumed(i, end);
        i = end;
        textStart = i;
        continue;
      }
      // No email after the scheme: fall through (no link here).
    }
    // --- email (only at the start of a [\w.+-] run)
    if ((isWord(c) || c === '.' || c === '+' || c === '-') &&
        (activeBrackets === 0 || !anyBracketWillLink(src, brackets, refs)) && !inHtmlLink) {
      // At a token boundary (right after a delimiter, code span, link,
      // etc.) the email starts a fresh run even if the previous char is
      // a word char (e.g. `__a@b.com__`).
      const prevIsLocal = i > 0 && textStart !== i &&
        (isWord(src[i - 1]) || src[i - 1] === '.' || src[i - 1] === '+' || src[i - 1] === '-');
      if (!prevIsLocal) {
        // An open `_` emphasis delimiter lets the email end before a `_`.
        let openStrong = false;
        for (let d = delims.length - 1; d >= 0; d--) {
          if (delims[d].active && delims[d].ch === '_' && delims[d].canOpen) {
            openStrong = true;
            break;
          }
        }
        const em = matchEmail(src, i, openStrong);
        if (em) {
          flushText(i);
          nodes.push({ t: T_LINK, href: cleanUrlBlind('mailto:' + em.email), title: undefined, c: [{ t: T_TEXT, s: em.email, raw: true }] });
          lastWasEscape = false;
          if (activeBrackets > 0) deactivateConsumed(i, em.end);
          i = em.end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  flushText(n);
  // Global backtick pairing suppression: a link whose label contains
  // backticks shifts the paragraph-wide code-span pairing, and emphasis
  // inside the shifted regions stays literal in marked. (Delimiters
  // inside formed link labels were already processed and truncated, so
  // only post-link delimiters can be affected here.)
  if (backtickLink) {
    const regions = computeBacktickRegions(src, destRanges, masked);
    for (let d = 0; d < delims.length; d++) {
      if (!delims[d].active) continue;
      for (let r = 0; r < regions.length; r++) {
        if (delims[d].pos >= regions[r][0] && delims[d].pos < regions[r][1]) {
          delims[d].active = false;
          break;
        }
      }
    }
  }
  processEmphasis(nodes, delims, -1);
  return nodes;
}

// ---------------------------------------------------------------- blocks

// Block type codes
const B_DOC = 0, B_QUOTE = 1, B_LIST = 2, B_ITEM = 3, B_PARA = 4,
      B_HEADING = 5, B_THEMATIC = 6, B_CODE = 7, B_HTML = 8, B_TABLE = 9;

// Line cursor: tracks (offset, column) in a line, with partial-tab support.
// Columns reset to 0 after each container marker is stripped (matching
// marked's per-level re-lexing, which is what makes tab widths work out).
class Cursor {
  constructor(line) {
    this.line = line;
    this.offset = 0;
    this.column = 0;      // relative column (reset after each container)
    this.absColumn = 0;   // absolute column in the original line (never reset)
    this.tabRemain = 0;   // columns left in a partially-consumed tab
    this.prefix = '';     // spaces from expanded leading tabs
    this.totalWidth = 0;  // columns consumed by matched containers
    this.lastWidth = 0;   // columns consumed by the innermost container
    this.lastIsQuote = false; // innermost matched container is a quote
  }
  peek() {
    if (this.tabRemain > 0) return ' ';
    if (this.offset >= this.line.length) return '';
    return this.line[this.offset];
  }
  // Advance by one column.
  advance() {
    if (this.tabRemain > 0) {
      this.tabRemain--;
      this.column++;
      this.absColumn++;
      if (this.tabRemain === 0) this.offset++;
      return;
    }
    if (this.offset >= this.line.length) return;
    const c = this.line[this.offset];
    if (c === '\t') {
      const w = 4 - (this.column % 4);
      this.tabRemain = w - 1;
      this.column++;
      this.absColumn++;
      if (this.tabRemain === 0) this.offset++;
    } else {
      this.offset++;
      this.column++;
      this.absColumn++;
    }
  }
  advanceBy(n) {
    for (let k = 0; k < n; k++) this.advance();
  }
  resetColumn() { this.column = 0; }
  // Expand leading tabs (in the leading whitespace run) to spaces. The
  // tab column is the absolute column, except when the innermost matched
  // container is a blockquote: then the widths of all outer containers
  // are subtracted (a tab after `> > ` expands from column 2, after
  // `  > ` from 4; inside list items the absolute column applies).
  // Consumes the whole leading whitespace run into the prefix.
  expandLeadingTabs() {
    if (this.tabRemain > 0) {
      this.prefix += ' '.repeat(this.tabRemain);
      this.column += this.tabRemain;
      this.absColumn += this.tabRemain;
      this.tabRemain = 0;
      this.offset++;
    }
    while (this.offset < this.line.length) {
      const c = this.line[this.offset];
      if (c === ' ') {
        this.prefix += ' ';
        this.offset++;
        this.column++;
        this.absColumn++;
      } else if (c === '\t') {
        const base = this.lastIsQuote ? this.totalWidth - this.lastWidth : 0;
        const w = 4 - ((this.absColumn - base) % 4);
        this.prefix += ' '.repeat(w);
        this.offset++;
        this.column += w;
        this.absColumn += w;
      } else break;
    }
  }
  // Remaining content from the current position.
  rest() {
    let s = this.prefix;
    if (this.tabRemain > 0) s += ' '.repeat(this.tabRemain);
    const start = this.tabRemain > 0 ? this.offset + 1 : this.offset;
    if (start < this.line.length) s += this.line.slice(start);
    return s;
  }
  isBlank() {
    for (let k = this.offset; k < this.line.length; k++) {
      const c = this.line[k];
      if (c !== ' ' && c !== '\t') return false;
    }
    return true;
  }
  // Number of leading spaces/tabs (in columns) from the current position.
  indentColumns() {
    let cols = this.tabRemain;
    let off = this.tabRemain > 0 ? this.offset + 1 : this.offset;
    let col = this.column + this.tabRemain;
    while (off < this.line.length) {
      const c = this.line[off];
      if (c === ' ') { cols++; col++; off++; }
      else if (c === '\t') { const w = 4 - (col % 4); cols += w; col += w; off++; }
      else break;
    }
    return cols;
  }
}

// HTML block type-6 tag names (CommonMark list, minus `source` which
// marked does not treat as a block tag). Lowercase only.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup ' +
  'dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 ' +
  'head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p ' +
  'param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

const TYPE1_TAGS = ['script', 'pre', 'style', 'textarea'];

// Split a table row line into cells (naive split on unescaped '|').
// Returns the array of raw cell strings (untrimmed), or null if the line
// has no cells (e.g. just '|').
function splitTableCells(line) {
  const cells = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '|') continue;
    // count preceding backslashes
    let bs = 0;
    let k = i - 1;
    while (k >= 0 && line[k] === '\\') { bs++; k--; }
    if (bs % 2 === 1) continue; // escaped pipe, not a separator
    cells.push(line.slice(start, i));
    start = i + 1;
  }
  cells.push(line.slice(start));
  // drop edge empties from leading/trailing pipes (ignoring surrounding
  // whitespace: ` | a | b` has the same cells as `| a | b`).
  const trimmed = line.trim();
  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|') && cells.length > 0) cells.pop();
  // An escaped pipe in a cell becomes a literal pipe.
  for (let k = 0; k < cells.length; k++) {
    if (cells[k].indexOf('\\|') !== -1) cells[k] = cells[k].replace(/\\\|/g, '|');
  }
  return cells;
}

// Check whether a line is a valid table delimiter row for a header with
// `headerCount` cells. Returns the alignment array ('l'/'c'/'r'/null) or null.
// No tabs allowed anywhere in the delimiter row.
function matchDelimiterRow(line, headerCount) {
  if (line.indexOf('\t') !== -1) return null;
  let sp = 0;
  while (sp < line.length && line[sp] === ' ') sp++;
  if (sp > 3) return null;
  const cells = splitTableCells(line);
  if (cells.length !== headerCount || headerCount === 0) return null;
  const align = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    const left = t[0] === ':';
    const right = t[t.length - 1] === ':';
    align.push(left && right ? 'c' : left ? 'l' : right ? 'r' : null);
  }
  return align;
}

// Check whether a line is a setext underline. Returns 1 (=), 2 (-), or 0.
// Leading indent must be 0-3 spaces (no tabs); trailing spaces/tabs ok.
function matchSetext(line) {
  let i = 0;
  let spaces = 0;
  while (i < line.length && line[i] === ' ') { i++; spaces++; }
  if (spaces > 3) return 0;
  if (i >= line.length) return 0;
  const c = line[i];
  if (c !== '=' && c !== '-') return 0;
  while (i < line.length && line[i] === c) i++;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i !== line.length) return 0;
  return c === '=' ? 1 : 2;
}

// Check whether a line is a thematic break. Returns true/false.
function matchThematic(line) {
  let i = 0;
  let spaces = 0;
  while (i < line.length && line[i] === ' ') { i++; spaces++; }
  if (spaces > 3) return false;
  if (i >= line.length) return false;
  const c = line[i];
  if (c !== '-' && c !== '*' && c !== '_') return false;
  let count = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === c) { count++; i++; }
    else if (ch === ' ' || ch === '\t') i++;
    else return false;
  }
  return count >= 3;
}

// Check whether a line is an ATX heading. Returns { level, content } or null.
// content is the raw heading text (closing sequence stripped, trimmed).
function matchATX(line) {
  let i = 0;
  let spaces = 0;
  while (i < line.length && line[i] === ' ') { i++; spaces++; }
  if (spaces > 3) return null;
  if (i >= line.length || line[i] !== '#') return null;
  let level = 0;
  while (i < line.length && line[i] === '#' && level < 7) { level++; i++; }
  if (level > 6) return null;
  if (i < line.length && line[i] !== ' ' && line[i] !== '\t') return null;
  // content: skip spaces/tabs, then strip trailing spaces/tabs and an
  // optional closing sequence of #s preceded by space/tab (or the whole
  // content if it is only #s — the space after the opening hashes counts).
  let content = line.slice(i).trim();
  if (/^#+$/.test(content)) content = '';
  else {
    const m = /[ \t]+#+[ \t]*$/.exec(content);
    if (m) content = content.slice(0, m.index);
    content = content.trim();
  }
  return { level, content };
}

// Check whether a line opens a fenced code block.
// Returns { fenceChar, fenceLen, info, indent } or null.
function matchFence(line) {
  let i = 0;
  let spaces = 0;
  while (i < line.length && line[i] === ' ') { i++; spaces++; }
  if (spaces > 3) return null;
  if (i >= line.length) return null;
  const c = line[i];
  if (c !== '`' && c !== '~') return null;
  let len = 0;
  while (i < line.length && line[i] === c) { len++; i++; }
  if (len < 3) return null;
  const info = line.slice(i).trim();
  if (c === '`' && info.indexOf('`') !== -1) return null;
  return { fenceChar: c, fenceLen: len, info, indent: spaces };
}

// Check whether a line closes a fenced code block (same char, len >= open,
// only spaces after, indent 0-3 spaces).
function matchFenceClose(line, fenceChar, fenceLen) {
  let i = 0;
  let spaces = 0;
  while (i < line.length && line[i] === ' ') { i++; spaces++; }
  if (spaces > 3) return false;
  if (i >= line.length || line[i] !== fenceChar) return false;
  let len = 0;
  while (i < line.length && line[i] === fenceChar) { len++; i++; }
  if (len < fenceLen) return false;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length;
}

// Check whether a line starts an HTML block. Returns { type, tag } or null.
// type 1: script/pre/style/textarea (tag = the tag name)
// type 2: comment, 3: PI, 4: declaration, 5: CDATA
// type 6: block tag (tag = name), type 7: complete tag alone on line
function matchHtmlBlockStart(line) {
  let i = 0;
  let spaces = 0;
  while (i < line.length && line[i] === ' ') { i++; spaces++; }
  if (spaces > 3) return null;
  if (i >= line.length || line[i] !== '<') return null;
  const rest = line.slice(i + 1);
  // type 1: <script, <pre, <style, <textarea (lowercase) + ws/>/EOL
  for (const tag of TYPE1_TAGS) {
    if (rest.startsWith(tag)) {
      const after = rest[tag.length];
      if (after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '>' || after === '\r') {
        return { type: 1, tag };
      }
    }
  }
  // type 2: <!--
  if (rest.startsWith('!--')) return { type: 2, tag: null };
  // type 3: <?
  if (rest.startsWith('?')) return { type: 3, tag: null };
  // type 4: <! + uppercase letter
  if (rest[0] === '!' && rest[1] && rest[1] >= 'A' && rest[1] <= 'Z') return { type: 4, tag: null };
  // type 5: <![CDATA[
  if (rest.startsWith('![CDATA[')) return { type: 5, tag: null };
  // type 6: < or </ + block tag + ws/>/EOL
  let j = 0;
  if (rest[0] === '/') j = 1;
  let nameEnd = j;
  while (nameEnd < rest.length && /[a-zA-Z0-9-]/.test(rest[nameEnd])) nameEnd++;
  const name = rest.slice(j, nameEnd);
  if (name.length > 0 && BLOCK_TAGS.has(name)) {
    const after = rest[nameEnd];
    if (after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '\r' || after === '>' ||
        (after === '/' && rest[nameEnd + 1] === '>')) {
      return { type: 6, tag: name };
    }
  }
  // type 7: complete open/close tag alone on the line (any tag name)
  const tagEnd = matchHtmlTag(line, i);
  if (tagEnd !== -1) {
    // the rest of the line after the tag must be only spaces/tabs
    let k = tagEnd;
    while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
    if (k === line.length) return { type: 7, tag: null };
  }
  return null;
}

// Check whether a line starts a list item. Returns info or null.
// info: { listType, bulletChar, delimiter, start, markerLen, contentIndent,
//         contentStart (columns to advance to reach content), empty }
function matchListItem(line, cursor) {
  // cursor is positioned at the line start (after containers).
  // Measure indent (0-3 spaces to start a list item; 4+ is code).
  let i = 0;
  let spaces = 0;
  while (i < line.length && line[i] === ' ') { i++; spaces++; }
  if (spaces > 3) return null;
  if (i >= line.length) return null;
  const c = line[i];
  let listType, bulletChar = null, delimiter = null, start = null, markerLen;
  if (c === '-' || c === '+' || c === '*') {
    listType = 'bullet';
    bulletChar = c;
    markerLen = 1;
  } else if (isDigit(c)) {
    let j = i;
    while (j < line.length && isDigit(line[j])) j++;
    if (j - i > 9) return null;
    const num = parseInt(line.slice(i, j), 10);
    if (j >= line.length || (line[j] !== '.' && line[j] !== ')')) return null;
    listType = 'ordered';
    delimiter = line[j];
    start = num;
    markerLen = (j - i) + 1;
  } else return null;
  // After the marker: whitespace (space/tab) or EOL.
  const afterMarker = i + markerLen;
  if (afterMarker >= line.length) {
    // empty item: content indent = marker + 1
    return { listType, bulletChar, delimiter, start, markerLen,
             contentIndent: spaces + markerLen + 1, contentStartCol: spaces + markerLen + 1,
             empty: true, indent: spaces };
  }
  const next = line[afterMarker];
  if (next !== ' ' && next !== '\t') return null;
  // Count the whitespace columns after the marker.
  let col = spaces + markerLen;
  let k = afterMarker;
  let wsCols = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    if (line[k] === ' ') { wsCols++; col++; k++; }
    else { const w = 4 - (col % 4); wsCols += w; col += w; k++; }
    if (wsCols >= 5) break;
  }
  if (wsCols >= 5) {
    // content indent = marker + 1; the content starts 1 col after the marker
    return { listType, bulletChar, delimiter, start, markerLen,
             contentIndent: spaces + markerLen + 1, contentStartCol: spaces + markerLen + 1,
             empty: false, indent: spaces };
  }
  if (k >= line.length) {
    // only whitespace after the marker: empty item
    return { listType, bulletChar, delimiter, start, markerLen,
             contentIndent: spaces + markerLen + 1, contentStartCol: spaces + markerLen + 1,
             empty: true, indent: spaces };
  }
  return { listType, bulletChar, delimiter, start, markerLen,
           contentIndent: spaces + markerLen + wsCols, contentStartCol: col,
           empty: false, indent: spaces };
}

// --- link reference definitions -------------------------------------------
// Parse a link reference definition from ls (array of container-stripped
// lines, starting at the def's first line). Returns
// { key, href, title, consumed } or null. `consumed` is the number of
// lines the def spans. href may be null (lone surrogate in dest).

// Parse a def dest starting at line[i]. Returns { dest, end } or null.
// Bare dest: no spaces/tabs/newlines, balanced parens, control chars OK.
// <...> dest: the caller handles the '>' candidates; here we just return
// the position after '<' and let the caller try each '>'.
function parseDefBareDest(line, i) {
  let j = i;
  let depth = 0;
  let dest = '';
  let start = i;
  while (j < line.length) {
    const c = line[j];
    if (c === ' ' || c === '\t') break;
    if (c === '(') { depth++; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; j++; continue;
    }
    if (c === '\\' && j + 1 < line.length && isPunct(line[j + 1])) {
      dest += line.slice(start, j) + line[j + 1];
      j += 2;
      start = j;
      continue;
    }
    j++;
  }
  dest += line.slice(start, j);
  if (j === i) return null; // empty dest
  return { dest, end: j };
}

// Parse a title starting at ls[li][pos] (the opening quote/paren).
// The title may span lines. Returns { title, endLi, endPos } or null.
function parseDefTitle(ls, li, pos) {
  const line = ls[li];
  if (pos >= line.length) return null;
  const q = line[pos];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let title = '';
  let cur = li;
  let k = pos + 1;
  let start = k;
  for (;;) {
    const l = ls[cur];
    if (l === undefined) return null;
    while (k < l.length) {
      const c = l[k];
      if (c === '\\' && k + 1 < l.length && isPunct(l[k + 1])) {
        title += l.slice(start, k) + l[k + 1];
        k += 2;
        start = k;
        continue;
      }
      if (c === close) {
        title += l.slice(start, k);
        return { title, endLi: cur, endPos: k + 1 };
      }
      if (q === '(' && c === '(') return null;
      k++;
    }
    // End of line without closing: the title continues on the next line.
    title += l.slice(start) + '\n';
    cur++;
    if (cur >= ls.length) return null;
    if (ls[cur].trim() === '') return null; // blank line ends the title
    k = 0;
    start = 0;
  }
}

// After a dest (ending at ls[li][pos]), parse the optional title and check
// the rest of the line(s). Returns { title, consumed } or null.
// consumed = number of lines used (relative to ls[0]).
// The title may be on the same line (spaces + title + spaces + EOL) or on
// the next line (any indent + title + spaces + EOL). If the next-line title
// fails, the def is title-less and the title line is NOT consumed.
function parseDefRest(ls, li, pos) {
  const line = ls[li];
  // Same-line: skip spaces (only spaces, no tabs).
  let q = pos;
  while (q < line.length && line[q] === ' ') q++;
  if (q < line.length && line[q] === '\t') return null; // tab in separator
  if (q < line.length) {
    // A title must follow on this line, separated by whitespace.
    if (q === pos) return null; // no space between dest and title
    const t = parseDefTitle(ls, li, q);
    if (!t) return null;
    // After the title, the rest of the line must be spaces only.
    const endLine = ls[t.endLi];
    let r = t.endPos;
    while (r < endLine.length && endLine[r] === ' ') r++;
    if (r !== endLine.length) return null;
    return { title: t.title, consumed: t.endLi + 1 };
  }
  // End of the dest line: the title may be on the next line.
  const nli = li + 1;
  if (nli < ls.length) {
    const nl = ls[nli];
    if (nl.trim() !== '') {
      let r = 0;
      while (r < nl.length && (nl[r] === ' ' || nl[r] === '\t')) r++;
      if (r < nl.length && (nl[r] === '"' || nl[r] === "'" || nl[r] === '(')) {
        const t = parseDefTitle(ls, nli, r);
        if (t) {
          const endLine = ls[t.endLi];
          let s = t.endPos;
          while (s < endLine.length && endLine[s] === ' ') s++;
          if (s === endLine.length) {
            return { title: t.title, consumed: t.endLi + 1 };
          }
        }
        // Title line failed: the def is title-less; the line is not consumed.
      }
    }
  }
  return { title: null, consumed: li + 1 };
}

function parseLinkDef(ls) {
  if (ls.length === 0 || ls[0] === undefined) return null;
  const line0 = ls[0];
  let i = 0;
  let sp = 0;
  while (i < line0.length && line0[i] === ' ') { i++; sp++; }
  if (sp > 3) return null;
  if (i >= line0.length || line0[i] !== '[') return null;
  // Parse the label (may span lines).
  const labelParts = [];
  let cur = 0;
  let k = i + 1;
  let labelEnd = null;
  for (;;) {
    const l = ls[cur];
    if (l === undefined) return null;
    let found = -1;
    while (k < l.length) {
      const c = l[k];
      if (c === '\\' && k + 1 < l.length && isPunct(l[k + 1])) { k += 2; continue; }
      if (c === '[') return null;
      if (c === ']') { found = k; break; }
      k++;
    }
    if (found !== -1) {
      labelParts.push(l.slice(cur === 0 ? i + 1 : 0, found));
      labelEnd = { li: cur, pos: found };
      break;
    }
    labelParts.push(l.slice(cur === 0 ? i + 1 : 0));
    cur++;
    if (cur >= ls.length) return null;
    if (ls[cur].trim() === '') return null;
    k = 0;
  }
  const label = labelParts.join('\n');
  if (label === '') return null;
  const key = foldLabel(label);
  if (key === '') return null;
  // Expect ':' immediately after ']'.
  const leLine = ls[labelEnd.li];
  let p = labelEnd.pos + 1;
  if (p >= leLine.length || leLine[p] !== ':') return null;
  p++;
  // The remainder of this line must not contain a tab.
  const restOfLine = leLine.slice(p);
  if (restOfLine.indexOf('\t') !== -1) return null;
  // Skip spaces.
  let q = p;
  while (q < leLine.length && leLine[q] === ' ') q++;
  let dest = null;
  let destLi = labelEnd.li;
  let destEnd = q;
  if (q >= leLine.length) {
    // Dest on the next line.
    const nli = labelEnd.li + 1;
    if (nli >= ls.length) return null;
    const nl = ls[nli];
    if (nl.trim() === '') return null;
    let r = 0;
    while (r < nl.length && (nl[r] === ' ' || nl[r] === '\t')) r++;
    if (r >= nl.length) return null;
    if (nl[r] === '<') {
      // <...> dest: try each '>' in turn.
      let cand = -1;
      let rest = null;
      for (let g = r + 1; g < nl.length; g++) {
        if (nl[g] !== '>') continue;
        const rr = parseDefRest(ls, nli, g + 1);
        if (rr) { cand = g; rest = rr; break; }
      }
      if (cand === -1) return null;
      let d = nl.slice(r + 1, cand);
      if (d.indexOf('\\') !== -1) d = d.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
      dest = d;
      destLi = nli;
      destEnd = cand + 1;
      return { key, href: cleanUrl(dest), title: rest.title, consumed: rest.consumed };
    }
    const d = parseDefBareDest(nl, r);
    if (!d) return null;
    // The remainder after the dest must not contain a tab.
    if (nl.slice(d.end).indexOf('\t') !== -1) return null;
    dest = d.dest;
    destLi = nli;
    destEnd = d.end;
    const rest = parseDefRest(ls, nli, d.end);
    if (!rest) return null;
    return { key, href: cleanUrl(dest), title: rest.title, consumed: rest.consumed };
  }
  // Dest on the same line.
  if (leLine[q] === '<') {
    let cand = -1;
    let rest = null;
    for (let g = q + 1; g < leLine.length; g++) {
      if (leLine[g] !== '>') continue;
      const rr = parseDefRest(ls, labelEnd.li, g + 1);
      if (rr) { cand = g; rest = rr; break; }
    }
    if (cand === -1) return null;
    let d = leLine.slice(q + 1, cand);
    if (d.indexOf('\\') !== -1) d = d.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
    dest = d;
    return { key, href: cleanUrl(dest), title: rest.title, consumed: rest.consumed };
  }
  const d = parseDefBareDest(leLine, q);
  if (!d) return null;
  if (leLine.slice(d.end).indexOf('\t') !== -1) return null;
  dest = d.dest;
  const rest = parseDefRest(ls, labelEnd.li, d.end);
  if (!rest) return null;
  return { key, href: cleanUrl(dest), title: rest.title, consumed: rest.consumed };
}


// --- the block parser -------------------------------------------------------

// Strip up to `n` leading whitespace chars (space/tab count as 1 each)
// from a fenced code content line.
function stripFenceIndent(line, n) {
  let k = 0;
  while (k < n && k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  return line.slice(k);
}

function parseBlocks(src, refs) {
  const lines = src.split('\n');
  if (src.length > 0 && src[src.length - 1] === '\n') lines.pop();
  const endsWithNL = src.length > 0 && src[src.length - 1] === '\n';

  const doc = { t: B_DOC, children: [], parent: null };
  const stack = [doc];
  const tip = () => stack[stack.length - 1];
  let lastHtml15 = null;
  let atEOF = false;

  const addChild = (parent, node) => {
    // A blank line separating blocks within a list item makes the list loose.
    if (parent.t === B_ITEM) {
      if (parent.blankPending && parent.children.length > 0 &&
          parent.parent && parent.parent.t === B_LIST) {
        parent.parent.tight = false;
      }
      parent.blankPending = false;
    }
    // A block added below an item consumes that item's pending blank
    // (the blank was inside this subtree, not the ancestor item).
    let anc = parent.parent;
    while (anc) {
      if (anc.t === B_ITEM) anc.blankPending = false;
      anc = anc.parent;
    }
    node.parent = parent;
    parent.children.push(node);
    return node;
  };
  const finalize = (node) => {
    if (node.t === B_CODE && !node.fenced) {
      while (node.lines.length > 0 && node.lines[node.lines.length - 1] === '') node.lines.pop();
    } else if (node.t === B_HTML) {
      if (node.htmlType === 6 || node.htmlType === 7) {
        // Type 6/7: the trailing \n is kept only when the block is a direct
        // child of the document and runs to EOF; otherwise it is dropped.
        if (!(atEOF && node.parent === doc)) node.noTrailingNL = true;
      }
      // A block running to EOF keeps its trailing \n only if the source
      // ends with a newline.
      if (atEOF && !endsWithNL) node.noTrailingNL = true;
    } else if (node.t === B_LIST) {
      // The last item of a list has its last line's trailing spaces/tabs
      // trimmed (marked behavior).
      trimLastItemLine(node);
    }
  };
  // Trim trailing spaces/tabs from the last line of the last item's
  // content (descending into nested containers).
  const trimNodeLastLine = (node) => {
    if (node.children.length === 0) {
      if (node.t === B_PARA && node.lines.length > 0) {
        const k = node.lines.length - 1;
        node.lines[k] = node.lines[k].replace(/[ \t]+$/, '');
      } else if (node.t === B_CODE && node.fenced && !node.closed && node.lines.length > 0) {
        const k = node.lines.length - 1;
        node.lines[k] = node.lines[k].replace(/[ \t]+$/, '');
      } else if (node.t === B_CODE && !node.fenced && node.lines.length > 0) {
        const k = node.lines.length - 1;
        node.lines[k] = node.lines[k].replace(/[ \t]+$/, '');
      } else if (node.t === B_HTML && node.lines.length > 0) {
        const k = node.lines.length - 1;
        node.lines[k] = node.lines[k].replace(/[ \t]+$/, '');
      }
      return;
    }
    trimNodeLastLine(node.children[node.children.length - 1]);
  };
  const trimLastItemLine = (list) => {
    if (list.children.length === 0) return;
    trimNodeLastLine(list.children[list.children.length - 1]);
  };
  const closeTo = (depth) => {
    while (stack.length > depth) finalize(stack.pop());
  };

  // Strip the containers currently on the stack from a raw line (for def
  // lookahead). Returns the content string or null if it doesn't match.
  const stripFor = (rawLine) => {
    const cur = new Cursor(rawLine);
    for (let s = 1; s < stack.length; s++) {
      const cont = stack[s];
      if (cont.t === B_LIST) continue;
      if (cont.t === B_QUOTE) {
        const qBefore = cur.absColumn;
        let skipped = 0;
        while (skipped < 3) {
          const ch = cur.peek();
          if (ch === ' ') { cur.advance(); skipped++; }
          else if (ch === '\t') {
            const w = 4 - (cur.column % 4);
            if (skipped + w > 3) break;
            cur.advanceBy(w);
            skipped += w;
          } else break;
        }
        if (cur.peek() !== '>') return null;
        cur.advance();
        if (cur.peek() === ' ' || cur.peek() === '\t') cur.advance();
        cur.resetColumn();
        cur.lastWidth = cur.absColumn - qBefore;
        cur.totalWidth += cur.lastWidth;
        cur.lastIsQuote = true;
      } else if (cont.t === B_ITEM) {
        if (cur.isBlank()) continue;
        if (cur.indentColumns() < cont.contentIndent) return null;
        const iBefore = cur.absColumn;
        cur.advanceBy(cont.contentIndent);
        cur.resetColumn();
        cur.lastWidth = cur.absColumn - iBefore;
        cur.totalWidth += cur.lastWidth;
        cur.lastIsQuote = false;
      }
    }
    cur.expandLeadingTabs();
    return cur.rest();
  };

  // Try to convert the tip paragraph with a setext underline or a table
  // delimiter row. Returns true if converted (line consumed).
  const tryConvertPara = (text) => {
    const t = tip();
    if (t.t !== B_PARA) return false;
    const st = matchSetext(text);
    if (st !== 0) {
      t.t = B_HEADING;
      t.level = st;
      t.content = t.lines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      delete t.lines;
      return true;
    }
    const headerLine = t.lines[t.lines.length - 1];
    const headerCells = splitTableCells(headerLine);
    if (headerCells.length > 0) {
      const align = matchDelimiterRow(text, headerCells.length);
      if (align) {
        const parent = t.parent;
        const idx = parent.children.indexOf(t);
        const header = headerCells.map((c) => c.trim());
        if (t.lines.length > 1) {
          t.lines = t.lines.slice(0, -1);
          const table = { t: B_TABLE, children: [], parent, header, align, rows: [] };
          parent.children.splice(idx + 1, 0, table);
          stack[stack.length - 1] = table;
        } else {
          t.t = B_TABLE;
          t.header = header;
          t.align = align;
          t.rows = [];
          delete t.lines;
        }
        return true;
      }
    }
    return false;
  };

  // Does this content start a new block (used to end a table)?
  const startsNewBlock = (text) => {
    if (matchATX(text)) return true;
    if (matchFence(text)) return true;
    const h = matchHtmlBlockStart(text);
    if (h && h.type !== 7) return true;
    if (matchThematic(text)) return true;
    if (matchListItem(text)) return true;
    // blockquote
    let i = 0, sp = 0;
    while (i < text.length && text[i] === ' ') { i++; sp++; }
    if (sp <= 3 && i < text.length && text[i] === '>') return true;
    // indented code (4+ spaces)
    if (sp >= 4) return true;
    return false;
  };

  // Does this text start a block that interrupts a paragraph (paraTip=true)
  // or, for an empty container, starts a new block outside it (paraTip=false)?
  // An ordered list item not starting with 1 can interrupt a paragraph
  // that is inside a list item.
  const tipInList = () => {
    let anc = tip();
    while (anc) {
      if (anc.t === B_LIST) return true;
      anc = anc.parent;
    }
    return false;
  };
  const startsInterrupt = (text, paraTip) => {
    if (matchATX(text)) return true;
    if (matchFence(text)) return true;
    const h = matchHtmlBlockStart(text);
    if (h && h.type !== 7) return true;
    if (matchThematic(text)) return true;
    const rc = new Cursor(text);
    let skipped = 0;
    while (skipped < 3) {
      const ch = rc.peek();
      if (ch === ' ') { rc.advance(); skipped++; }
      else if (ch === '\t') {
        const w = 4 - (rc.column % 4);
        if (skipped + w > 3) break;
        rc.advanceBy(w);
        skipped += w;
      } else break;
    }
    if (rc.peek() === '>') return true;
    const li = matchListItem(text);
    if (li) {
      if (!paraTip) return true;
      // An empty item never interrupts a paragraph.
      if (li.empty) return false;
      if (li.listType === 'bullet' || li.start === 1) return true;
      if (tipInList()) return true;
    }
    return false;
  };

  // Try to parse link reference definitions starting at `firstLine`
  // (the current line's content). Returns the number of lines consumed
  // (0 if no def). Only valid at a block start inside a container.
  const tryDefs = (firstLine) => {
    const t = tip();
    if (t.t !== B_DOC && t.t !== B_QUOTE && t.t !== B_LIST && t.t !== B_ITEM) return 0;
    const lookahead = [firstLine];
    let nextK = 1;
    const extend = (n) => {
      let added = 0;
      for (let c = 0; c < n && i + nextK < lines.length; c++, nextK++) {
        const stripped = stripFor(lines[i + nextK]);
        if (stripped === null) return added > 0;
        lookahead.push(stripped);
        added++;
      }
      return added > 0;
    };
    extend(11);
    let totalConsumed = 0;
    for (;;) {
      // Keep at least 3 lines past the current def start in view, so a
      // dest/title on the following lines is visible (long def blocks).
      while (lookahead.length < totalConsumed + 3) {
        if (!extend(12)) break;
      }
      const def = parseLinkDef(lookahead.slice(totalConsumed));
      if (!def) break;
      if (!refs.has(def.key)) refs.set(def.key, { href: def.href, title: def.title });
      totalConsumed += def.consumed;
      if (totalConsumed >= lookahead.length) {
        // Consumed everything in view; extend once more to check for a
        // following def, then stop if nothing new appears.
        const before = lookahead.length;
        extend(12);
        if (lookahead.length === before) break;
      }
    }
    return totalConsumed;
  };

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const cursor = new Cursor(rawLine);

    const top = tip();
    const isLeafTop = top.t === B_PARA || top.t === B_CODE || top.t === B_HTML ||
      top.t === B_TABLE || top.t === B_HEADING || top.t === B_THEMATIC;
    const leafIdx = isLeafTop ? stack.length - 1 : stack.length;

    // 1. Match open containers.
    let matchDepth = 1;
    let allMatched = true;
    for (let s = 1; s < leafIdx; s++) {
      const cont = stack[s];
      if (cont.t === B_LIST) { matchDepth = s + 1; continue; }
      if (cont.t === B_QUOTE) {
        const save = { o: cursor.offset, c: cursor.column, t: cursor.tabRemain, p: cursor.prefix, a: cursor.absColumn };
        let skipped = 0;
        while (skipped < 3) {
          const ch = cursor.peek();
          if (ch === ' ') { cursor.advance(); skipped++; }
          else if (ch === '\t') {
            const w = 4 - (cursor.column % 4);
            if (skipped + w > 3) break;
            cursor.advanceBy(w);
            skipped += w;
          } else break;
        }
        if (cursor.peek() === '>') {
          cursor.advance();
          if (cursor.peek() === ' ' || cursor.peek() === '\t') cursor.advance();
          cursor.resetColumn();
          cursor.lastWidth = cursor.absColumn - save.a;
          cursor.totalWidth += cursor.lastWidth;
          cursor.lastIsQuote = true;
          matchDepth = s + 1;
        } else {
          cursor.offset = save.o; cursor.column = save.c; cursor.tabRemain = save.t; cursor.prefix = save.p; cursor.absColumn = save.a;
          allMatched = false;
          break;
        }
      } else if (cont.t === B_ITEM) {
        if (cursor.isBlank()) { matchDepth = s + 1; continue; }
        if (cursor.indentColumns() >= cont.contentIndent) {
          const beforeAbs = cursor.absColumn;
          cursor.advanceBy(cont.contentIndent);
          cursor.resetColumn();
          cursor.lastWidth = cursor.absColumn - beforeAbs;
          cursor.totalWidth += cursor.lastWidth;
          cursor.lastIsQuote = false;
          matchDepth = s + 1;
        } else {
          allMatched = false;
          break;
        }
      }
    }

    const lineIsBlank = cursor.isBlank();
    // A non-blank line keeps the trailing \n of a just-ended type 1-5
    // HTML block (lastHtml15 only applies to the next line if blank).
    if (!lineIsBlank) lastHtml15 = null;

    // 2. Blank line. A whitespace-only line containing a tab is a table
    // body row (empty cells), not a blank line.
    if (lineIsBlank && !(tip().t === B_TABLE && rawLine.indexOf('\t') !== -1)) {
      // A trailing whitespace-only line at EOF joins an open paragraph
      // (inside a quote, or when the source has no trailing newline).
      if (i === lines.length - 1 && tip().t === B_PARA) {
        const restStr = cursor.rest();
        if (restStr !== '') {
          let inQuote = false;
          for (let s = 1; s < matchDepth; s++) if (stack[s].t === B_QUOTE) inQuote = true;
          if (inQuote || !endsWithNL) {
            tip().lines.push(restStr);
            i++;
            continue;
          }
        }
      }
      if (!allMatched) closeTo(matchDepth);
      const t = tip();
      let consumedByLeaf = false;
      if (t.t === B_PARA || t.t === B_TABLE) {
        closeTo(stack.length - 1);
      } else if (t.t === B_HTML && (t.htmlType === 6 || t.htmlType === 7)) {
        t.noTrailingNL = true;
        closeTo(stack.length - 1);
      } else if (t.t === B_CODE && t.fenced) {
        t.lines.push(stripFenceIndent(cursor.rest(), t.fenceIndent));
        consumedByLeaf = true;
      } else if (t.t === B_CODE && !t.fenced) {
        // A blank line inside indented code keeps its spaces past 4 cols.
        const c2 = new Cursor(cursor.rest());
        c2.advanceBy(4);
        t.lines.push(c2.rest());
        consumedByLeaf = true;
      } else if (t.t === B_HTML) {
        t.lines.push(cursor.rest());
        consumedByLeaf = true;
      }
      if (!consumedByLeaf) {
        // A blank line sets blankPending on items on the path, but a
        // blockquote on the path blocks it for items above the quote
        // (cm-320: a blank line inside a quote does not loosen the
        // containing list; cm-325: with no quote, it does).
        let blocked = false;
        for (let s = stack.length - 1; s >= 1; s--) {
          const cont = stack[s];
          if (cont.t === B_QUOTE || cont.t === B_ITEM || cont.t === B_LIST) cont.hadBlank = true;
          if (cont.t === B_QUOTE) blocked = true;
          if (cont.t === B_ITEM && !blocked) cont.blankPending = true;
        }
        if (tip().t === B_ITEM && tip().children.length === 0) {
          closeTo(stack.length - 1);
        }
      }
      if (lastHtml15) {
        if (cursor.rest() === '') lastHtml15.noTrailingNL = true;
        lastHtml15 = null;
      }
      i++;
      continue;
    }

    // 3. Lazy continuation (only when containers didn't all match).
    if (!allMatched) {
      const t = tip();
      let lazy = false;
      if (t.t === B_PARA) lazy = true;
      else if ((t.t === B_QUOTE || t.t === B_ITEM || t.t === B_DOC) &&
               t.children.length === 0 && !t.hadBlank) lazy = true;
      if (lazy) {
        const restStr = cursor.rest();
        // A line that starts an interrupting block is not lazy.
        if (startsInterrupt(restStr, t.t === B_PARA)) lazy = false;
        // A list item for the nearest open list continues it (not lazy),
        // even an ordered item not starting with 1.
        if (lazy) {
          const li = matchListItem(restStr);
          if (li) {
            let anc = t.parent;
            while (anc && anc.t !== B_LIST) anc = anc.parent;
            if (anc && li.listType === anc.listType &&
                (li.listType === 'bullet' ? anc.bulletChar === li.bulletChar
                                          : anc.delimiter === li.delimiter)) {
              lazy = false;
            }
          }
        }
      }
      if (lazy) {
        cursor.expandLeadingTabs();
        let content = cursor.rest();
        // Lazy lines have leading whitespace stripped: a quote strips up
        // to 4 columns; a list item strips its content indent, plus 4
        // more columns if the remainder is still indented 4+. Only
        // spaces are stripped (tabs were already expanded).
        const cont = t.t === B_PARA ? t.parent : t;
        if (cont && cont.t === B_QUOTE) {
          // Strip 4 only if the line has at least 4 leading spaces.
          let sp = 0;
          while (sp < content.length && content[sp] === ' ') sp++;
          if (sp >= 4) content = content.slice(4);
        } else if (cont && cont.t === B_ITEM) {
          // If the line reaches the content indent, strip it (then 4
          // more if the remainder has 4+). Otherwise, if it has 4+
          // leading spaces, strip 4. Otherwise strip nothing.
          let sp = 0;
          while (sp < content.length && content[sp] === ' ') sp++;
          if (sp >= cont.contentIndent) {
            content = content.slice(cont.contentIndent);
            sp = 0;
            while (sp < content.length && content[sp] === ' ') sp++;
            if (sp >= 4) content = content.slice(4);
          } else if (sp >= 4) {
            content = content.slice(4);
          }
        }
        if (t.t === B_PARA) {
          // Lazy lines never convert to setext/table. A lazy setext
          // underline in a quote, when it is not the first lazy line,
          // gains 4 leading spaces (marked quirk).
          if (matchSetext(content) !== 0 && t.hadLazy &&
              cont && cont.t === B_QUOTE) {
            content = '    ' + content;
          }
          t.lines.push(content);
          t.hadLazy = true;
        } else {
          const para = addChild(t, { t: B_PARA, children: [], lines: [content] });
          para.hadLazy = true;
          stack.push(para);
        }
        lastHtml15 = null;
        i++;
        continue;
      }
      // Fenced code: a non-blank line that fails to match a LIST ITEM
      // container is still fence content (it never closes the fence or
      // its containers) — but only once the fence already has content;
      // an empty fence closes instead. A line starting a new block
      // (list item, heading, etc.) closes the fence. A line that fails
      // to match a BLOCKQUOTE closes the quote (and the fence).
      const firstUnmatched = stack[matchDepth];
      // A line starting a list item, ATX heading, thematic break, or
      // blockquote closes the fence instead of joining it (fence/HTML/
      // indented-code lines are fence content, not new blocks).
      const rawC0 = cursor.rest();
      let startsNewBlock = false;
      if (matchATX(rawC0) || matchThematic(rawC0) || matchListItem(rawC0)) startsNewBlock = true;
      else {
        let q = 0, sp = 0;
        while (q < rawC0.length && rawC0[q] === ' ') { q++; sp++; }
        if (sp <= 3 && q < rawC0.length && rawC0[q] === '>') startsNewBlock = true;
      }
      if (t.t === B_CODE && t.fenced && t.lines.length > 0 &&
          firstUnmatched && firstUnmatched.t !== B_QUOTE && !startsNewBlock) {
        const canClose = matchDepth >= stack.length - 1;
        // Content after the matched containers (raw; closing-fence check
        // uses the expanded form for indent measurement).
        const rawC = cursor.rest();
        const tmpC = new Cursor(rawC);
        tmpC.expandLeadingTabs();
        const expC = tmpC.rest();
        if (canClose && matchFenceClose(expC, t.fenceChar, t.fenceLen)) {
          t.closed = true;
          closeTo(stack.length - 1);
          closeTo(matchDepth);
        } else {
          const cc = matchDepth > 1 ? expC : rawC;
          t.lines.push(stripFenceIndent(cc, t.fenceIndent));
        }
        lastHtml15 = null;
        i++;
        continue;
      }
      closeTo(matchDepth);
    }

    // Raw content after container markers (tabs preserved) — code blocks
    // keep literal tabs in their content at the top level; inside a
    // container the leading tabs were expanded by absolute column during
    // container matching, so the expanded content is used there.
    const rawContent = cursor.rest();
    cursor.expandLeadingTabs();
    let content = cursor.rest();
    const codeContent = matchDepth > 1 ? content : rawContent;

    // 4. Leaf continuations.
    if (tip().t === B_CODE && tip().fenced) {
      const f = tip();
      if (matchFenceClose(content, f.fenceChar, f.fenceLen)) {
        f.closed = true;
        closeTo(stack.length - 1);
      } else f.lines.push(stripFenceIndent(codeContent, f.fenceIndent));
      lastHtml15 = null;
      i++;
      continue;
    }
    if (tip().t === B_HTML) {
      const h = tip();
      // HTML block lines keep raw tabs at top level (like fenced code).
      h.lines.push(codeContent);
      let ended = false;
      if (h.htmlType === 1) {
        if (content.toLowerCase().indexOf('</' + h.tag + '>') !== -1) ended = true;
      } else if (h.htmlType === 2) {
        if (content.indexOf('-->') !== -1) ended = true;
      } else if (h.htmlType === 3) {
        if (content.indexOf('?>') !== -1) ended = true;
      } else if (h.htmlType === 4) {
        if (content.indexOf('>') !== -1) ended = true;
      } else if (h.htmlType === 5) {
        if (content.indexOf(']]>') !== -1) ended = true;
      }
      if (ended) {
        closeTo(stack.length - 1);
        lastHtml15 = h;
      }
      i++;
      continue;
    }
    if (tip().t === B_CODE && !tip().fenced) {
      // Indent measured in columns on the code content; strip 4 columns
      // via a cursor so remaining tabs stay literal.
      const rc = new Cursor(codeContent);
      if (rc.indentColumns() >= 4) {
        rc.advanceBy(4);
        tip().lines.push(rc.rest());
        lastHtml15 = null;
        i++;
        continue;
      }
      // Not indented enough: close the code block and reprocess the line.
      closeTo(stack.length - 1);
      continue; // reprocess the same line (i unchanged)
    }
    if (tip().t === B_TABLE) {
      // A whitespace-only line here is a tab row (empty cells); it is
      // not a new block even though it looks indented.
      if (content.trim() !== '' && startsNewBlock(content)) {
        closeTo(stack.length - 1);
        continue; // reprocess the same line
      }
      const cells = splitTableCells(content).map((c) => c.trim());
      const row = [];
      for (let c = 0; c < tip().header.length; c++) row.push(c < cells.length ? cells[c] : '');
      tip().rows.push(row);
      lastHtml15 = null;
      i++;
      continue;
    }

    // 5. Link reference definitions (only at a block start inside a container).
    {
      const consumed = tryDefs(content);
      if (consumed > 0) {
        lastHtml15 = null;
        i += consumed;
        continue;
      }
    }

    // 6. Setext / table conversion (if the tip is a paragraph).
    if (tip().t === B_PARA && tryConvertPara(content)) {
      // The paragraph was converted; the tip is now a heading/table (closed).
      // A heading is a leaf that is done; a table stays open for body rows.
      if (tip().t === B_HEADING) closeTo(stack.length - 1);
      lastHtml15 = null;
      i++;
      continue;
    }

    // 7. Open new blocks (loop: containers may nest on one line).
    // A paragraph is closed before an interrupting block opens.
    if (tip().t === B_PARA && startsInterrupt(content, true)) {
      closeTo(stack.length - 1);
    }
    // A list only holds items: if the tip is a list and this line does
    // not start a matching item for it, the list ends here. A thematic
    // break takes precedence over a list item (e.g. `* * *`).
    if (tip().t === B_LIST) {
      const li = matchListItem(content);
      const lt = tip();
      const matches = li && !matchThematic(content) &&
        li.listType === lt.listType &&
        (li.listType === 'bullet' ? lt.bulletChar === li.bulletChar : lt.delimiter === li.delimiter);
      if (!matches) closeTo(stack.length - 1);
    }
    let rest = content;
    let lineDone = false;
    let justOpened = false;
    let openedOnLine = false;
    while (!lineDone) {
      // Link reference definitions after opening a container.
      if (justOpened) {
        justOpened = false;
        const consumed = tryDefs(rest);
        if (consumed > 0) {
          // The def consumed the current line (and possibly more).
          i += consumed - 1;
          lineDone = true;
          break;
        }
      }
      // Blockquote.
      {
        const rc = new Cursor(rest);
        let sp = 0;
        while (sp < 3) {
          const ch = rc.peek();
          if (ch === ' ') { rc.advance(); sp++; }
          else if (ch === '\t') {
            const w = 4 - (rc.column % 4);
            if (sp + w > 3) break;
            rc.advanceBy(w);
            sp += w;
          } else break;
        }
        if (rc.peek() === '>') {
          rc.advance();
          if (rc.peek() === ' ' || rc.peek() === '\t') rc.advance();
          rc.resetColumn();
          rc.expandLeadingTabs();
          const q = addChild(tip(), { t: B_QUOTE, children: [] });
          stack.push(q);
          rest = rc.rest();
          justOpened = true;
          openedOnLine = true;
          continue;
        }
      }
      // ATX heading.
      {
        const atx = matchATX(rest);
        if (atx) {
          addChild(tip(), { t: B_HEADING, children: [], level: atx.level, content: atx.content });
          lineDone = true;
          break;
        }
      }
      // Fenced code.
      {
        const f = matchFence(rest);
        if (f) {
          const node = addChild(tip(), { t: B_CODE, children: [], fenced: true,
            fenceChar: f.fenceChar, fenceLen: f.fenceLen, info: f.info,
            // marked strips the opening fence's indent from content lines
            // only for backtick fences; tilde fences keep their indent.
            fenceIndent: f.fenceChar === '~' ? 0 : f.indent, lines: [], closed: false });
          stack.push(node);
          lineDone = true;
          break;
        }
      }
      // HTML block.
      {
        const h = matchHtmlBlockStart(rest);
        if (h && (h.type !== 7 || tip().t !== B_PARA)) {
          const node = addChild(tip(), { t: B_HTML, children: [], htmlType: h.type,
            tag: h.tag, lines: [rest], noTrailingNL: false });
          // Check if the block ends on its own first line (types 1-5).
          let ended = false;
          if (h.type === 1) {
            if (rest.toLowerCase().indexOf('</' + h.tag + '>') !== -1) ended = true;
          } else if (h.type === 2) {
            if (rest.indexOf('-->') !== -1) ended = true;
          } else if (h.type === 3) {
            if (rest.indexOf('?>') !== -1) ended = true;
          } else if (h.type === 4) {
            if (rest.indexOf('>', rest.indexOf('<!') + 2) !== -1) ended = true;
          } else if (h.type === 5) {
            if (rest.indexOf(']]>') !== -1) ended = true;
          }
          if (ended) {
            lastHtml15 = node;
          } else {
            stack.push(node);
          }
          lineDone = true;
          break;
        }
      }
      // Thematic break.
      if (matchThematic(rest)) {
        addChild(tip(), { t: B_THEMATIC, children: [] });
        lineDone = true;
        break;
      }
      // List item.
      {
        const li = matchListItem(rest);
        if (li && (tip().t !== B_PARA ||
                   (!li.empty && (li.listType === 'bullet' || li.start === 1 || tipInList())))) {
          // Find or create the list.
          let list = null;
          const t = tip();
          if (t.t === B_LIST &&
              t.listType === li.listType &&
              (li.listType === 'bullet' ? t.bulletChar === li.bulletChar : t.delimiter === li.delimiter)) {
            list = t;
            // Loose if the previous item had a blank line after it.
            const prev = list.children[list.children.length - 1];
            if (prev && prev.blankPending) list.tight = false;
          } else {
            list = addChild(t, { t: B_LIST, children: [], listType: li.listType,
              bulletChar: li.bulletChar, delimiter: li.delimiter,
              start: li.start, tight: true });
            stack.push(list);
          }
          const item = addChild(list, { t: B_ITEM, children: [],
            contentIndent: li.contentIndent, blankPending: false, hadBlank: false, task: null });
          stack.push(item);
          // Content after the marker.
          const rc = new Cursor(rest);
          rc.advanceBy(li.contentStartCol);
          rc.resetColumn();
          rc.expandLeadingTabs();
          rest = rc.rest();
          // An empty item has no content on this line.
          if (li.empty) rest = '';
          // Task list checkbox on the first line.
          if (rest.length >= 4 && rest[0] === '[' &&
              (rest[1] === ' ' || rest[1] === 'x' || rest[1] === 'X') && rest[2] === ']' &&
              (rest[3] === ' ' || rest[3] === '\t')) {
            const after = rest.slice(4);
            if (after.trim() !== '') {
              item.task = rest[1] === ' ' ? ' ' : 'x';
              rest = after;
            }
          }
          if (rest === '') {
            lineDone = true;
            break;
          }
          justOpened = true;
          openedOnLine = true;
          continue;
        }
      }
      // Indented code (cannot interrupt a paragraph).
      if (tip().t !== B_PARA) {
        let sp = 0;
        while (sp < rest.length && rest[sp] === ' ') sp++;
        // A tab at the start also counts (4 cols); handle via cursor.
        // At the top level with no container opened on this line, use the
        // raw code content so tabs after the indent stay literal.
        const rc = new Cursor(!openedOnLine && matchDepth === 1 ? codeContent : rest);
        if (rc.indentColumns() >= 4) {
          rc.advanceBy(4);
          const node = addChild(tip(), { t: B_CODE, children: [], fenced: false, lines: [rc.rest()] });
          stack.push(node);
          lineDone = true;
          break;
        }
      }
      // Paragraph: start one or add to the tip paragraph. An empty rest
      // after opening a container does not start a paragraph.
      {
        const t = tip();
        if (t.t === B_PARA) {
          t.lines.push(rest);
        } else if (rest !== '') {
          const para = addChild(t, { t: B_PARA, children: [], lines: [rest] });
          stack.push(para);
        }
        lineDone = true;
        break;
      }
    }

    i++;
  }

  atEOF = true;
  closeTo(1);
  return doc;
}

// --- rendering ---------------------------------------------------------------

function renderBlocks(node, refs) {
  let out = '';
  for (const child of node.children) out += renderBlock(child, refs);
  return out;
}

function renderBlock(node, refs) {
  switch (node.t) {
    case B_DOC:
      return renderBlocks(node, refs);
    case B_QUOTE: {
      let inner = renderBlocks(node, refs);
      return '<blockquote>\n' + inner + '</blockquote>\n';
    }
    case B_LIST: {
      const tag = node.listType === 'ordered' ? 'ol' : 'ul';
      let open = '<' + tag;
      if (node.listType === 'ordered' && node.start !== 1) open += ' start="' + node.start + '"';
      open += '>\n';
      let out = open;
      for (const item of node.children) out += renderBlock(item, refs);
      return out + '</' + tag + '>\n';
    }
    case B_ITEM: {
      const list = node.parent;
      const tight = list.tight;
      let out = '<li>';
      if (node.children.length === 0) return out + '</li>\n';
      if (tight) {
        // Tight: paragraphs render as bare inline text.
        for (let k = 0; k < node.children.length; k++) {
          const ch = node.children[k];
          if (ch.t === B_PARA) {
            let text = ch.lines.join('\n');
            if (k === 0 && node.task) {
              out += node.task === 'x'
                ? '<input checked="" disabled="" type="checkbox"> '
                : '<input disabled="" type="checkbox"> ';
            }
            out += renderInline(parseInline(text, refs));
          } else {
            out += renderBlock(ch, refs);
          }
        }
        // A tight item ending in a paragraph has no \n before </li>;
        // a block child already ends its HTML with \n.
        return out + '</li>\n';
      }
      // Loose: paragraphs render as <p>...</p>.
      for (let k = 0; k < node.children.length; k++) {
        const ch = node.children[k];
        if (ch.t === B_PARA) {
          let text = ch.lines.join('\n');
          out += '<p>';
          if (k === 0 && node.task) {
            out += node.task === 'x'
              ? '<input checked="" disabled="" type="checkbox"> '
              : '<input disabled="" type="checkbox"> ';
          }
          out += renderInline(parseInline(text, refs)) + '</p>\n';
        } else {
          out += renderBlock(ch, refs);
        }
      }
      return out + '</li>\n';
    }
    case B_PARA: {
      return '<p>' + renderInline(parseInline(node.lines.join('\n'), refs)) + '</p>\n';
    }
    case B_HEADING: {
      return '<h' + node.level + '>' + renderInline(parseInline(node.content, refs)) +
        '</h' + node.level + '>\n';
    }
    case B_THEMATIC:
      return '<hr>\n';
    case B_CODE: {
      if (node.fenced) {
        let content = node.lines.join('\n');
        if (content.length > 0 && !content.endsWith('\n')) content += '\n';
        let lang = '';
        if (node.info) {
          let word = node.info.split(/[ \t]/)[0];
          // Backslash escapes in the info string are unescaped.
          word = word.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
          if (word) lang = ' class="language-' + esc(word) + '"';
        }
        return '<pre><code' + lang + '>' + escBlind(content) + '</code></pre>\n';
      }
      let content = node.lines.join('\n');
      if (content.length > 0) content += '\n';
      return '<pre><code>' + escBlind(content) + '</code></pre>\n';
    }
    case B_HTML: {
      let html = node.lines.join('\n');
      if (!node.noTrailingNL) html += '\n';
      return html;
    }
    case B_TABLE: {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < node.header.length; c++) {
        const a = node.align[c];
        out += '<th' + (a ? ' align="' + (a === 'l' ? 'left' : a === 'c' ? 'center' : 'right') + '"' : '') +
          '>' + renderInline(parseInline(node.header[c], refs)) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let c = 0; c < row.length; c++) {
            const a = node.align[c];
            out += '<td' + (a ? ' align="' + (a === 'l' ? 'left' : a === 'c' ? 'center' : 'right') + '"' : '') +
              '>' + renderInline(parseInline(row[c], refs)) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
  }
  return '';
}

// --- entry point -------------------------------------------------------------

// Marked leaks an "in link" state across blocks: an inline `<a ...>`
// opening tag (no newline inside) suppresses extended autolinks
// (email/www/http) in the rest of the document until a `</a>` tag.
// Angle autolinks and markdown links are NOT suppressed. Reset per parse.
let inHtmlLink = false;

export function parse(markdown) {
  inHtmlLink = false;
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = new Map();
  const doc = parseBlocks(src, refs);
  return renderBlocks(doc, refs);
}
