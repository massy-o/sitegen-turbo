// sitegen-turbo: a byte-exact, high-speed drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build
// returns for every input — same pages, same report, byte for byte — while
// spending far less CPU: line-classifying lexing instead of regex ladders,
// a single-pass inline renderer that works on index ranges (no slicing or
// re-scanning), bulk plain-run escaping, an ASCII fast path for slugs, and
// templates compiled once per case into node trees rendered into part lists.
//
// The dialect is makefun-site's own (its README states the rules; where any
// summary differs from the reference program's behaviour, the reference is
// followed here): front matter with per-key grammars and refusal reasons,
// permalinks made unique per directory, a Markdown subset (fences, ATX
// headings with unique slug ids, breaks, blockquotes, flat lists,
// paragraphs; inline code spans, strong, emphasis, links, backslash
// escapes), collections, tags, layouts with an index/tag/tags page set, and
// build-report.txt.

// ---------------------------------------------------------------- text ---

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped, and nothing else. */
function escapeHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;

// Slug cache: lives for one run() call only (cleared at its start), so no
// answer ever depends on an earlier case.
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), "untitled" when empty.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    // NFKD is the identity on ASCII and no ASCII char is a combining mark,
    // so the general rule reduces to this single pass.
    let s = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      let keep = null;
      if (c >= 'A' && c <= 'Z') keep = c.toLowerCase();
      else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) keep = c;
      if (keep === null) {
        gap = s.length > 0;
        continue;
      }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    out = s;
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let s = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = s.length > 0;
        continue;
      }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    out = s;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  out = out === '' ? 'untitled' : out;
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------- front matter ---

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const BLANK_RE = /^[ \t]*$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error } with the first reason. */
function parseFrontMatter(text) {
  // Walk the lines by their "\n"s instead of splitting the whole text: only
  // the few front-matter lines are ever materialised, and the body is one
  // slice of what follows the closing line.
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  const fmLines = [];
  let bodyStart = -1;
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    if (line === '---') {
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    if (BLANK_RE.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// -------------------------------------------------------------- markdown ---

// Line kinds, classified once per line.
const L_BLANK = 0;
const L_FENCE = 1; // a fence opening (carries a language)
const L_HEADING = 2; // carries depth and text
const L_HR = 3;
const L_QUOTE = 4;
const L_BULLET = 5; // carries the item text
const L_ORDERED = 6; // carries the item text and the number
const L_TEXT = 7;

/** Classify one line; fills `slot` { kind, a, b } (a: lang/depth/item, b: number). */
function classify(line, slot) {
  const n = line.length;
  let blank = true;
  for (let i = 0; i < n; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') {
      blank = false;
      break;
    }
  }
  if (blank) {
    slot.kind = L_BLANK;
    return;
  }
  const c0 = line[0];
  if (c0 === '`' && line[1] === '`' && line[2] === '`') {
    let j = 3;
    while (j < n) {
      const c = line[j];
      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') j++;
      else break;
    }
    let ok = true;
    for (let k = j; k < n; k++) {
      const c = line[k];
      if (c !== ' ' && c !== '\t') {
        ok = false;
        break;
      }
    }
    if (ok) {
      slot.kind = L_FENCE;
      slot.a = line.slice(3, j);
      return;
    }
  }
  if (c0 === '#') {
    let depth = 0;
    while (depth < n && line[depth] === '#') depth++;
    if (depth <= 6 && depth < n && (line[depth] === ' ' || line[depth] === '\t')) {
      let j = depth;
      while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
      let end = n;
      while (end > j && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
      if (end > j) {
        slot.kind = L_HEADING;
        slot.a = line.slice(j, end);
        slot.b = depth;
        return;
      }
    }
  }
  if ((c0 === '-' || c0 === '*') && line[1] === c0 && line[2] === c0) {
    let ok = true;
    for (let k = 3; k < n; k++) {
      const c = line[k];
      if (c !== ' ' && c !== '\t') {
        ok = false;
        break;
      }
    }
    if (ok) {
      slot.kind = L_HR;
      return;
    }
  }
  if (c0 === '>') {
    slot.kind = L_QUOTE;
    return;
  }
  if ((c0 === '-' || c0 === '*') && line[1] === ' ') {
    slot.kind = L_BULLET;
    slot.a = line.slice(2);
    return;
  }
  if (c0 >= '0' && c0 <= '9') {
    let d = 0;
    while (d < n && line[d] >= '0' && line[d] <= '9') d++;
    if (d <= 9 && line[d] === '.' && line[d + 1] === ' ') {
      slot.kind = L_ORDERED;
      slot.a = line.slice(d + 2);
      slot.b = Number(line.slice(0, d));
      return;
    }
  }
  slot.kind = L_TEXT;
}

/** Whether a line is a fence closing: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let k = 3; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A line trimmed of spaces and tabs at both ends, by slicing. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

const NON_SPACE_RE = /\S/;

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i >= 2 && i < line.length && NON_SPACE_RE.test(line[i]);
}

// The characters a backslash escapes, as a set and as a char-code table.
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const ESCAPABLE_CODE = new Uint8Array(128);
for (const ch of ESCAPABLE) ESCAPABLE_CODE[ch.charCodeAt(0)] = 1;

/** Whether the char code at `j + 1` in `s` is one a backslash escapes (the char at j is the backslash). */
function escapedAt(s, j, hi) {
  if (j + 1 >= hi) return false;
  const c = s.charCodeAt(j + 1);
  return c < 128 ? ESCAPABLE_CODE[c] === 1 : ESCAPABLE.has(s[j + 1]);
}

/** The first index in [from, hi) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j <= hi - wlen; j++) {
    if (s.charCodeAt(j) === 92 && escapedAt(s, j, hi)) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, hi) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && escapedAt(s, j, hi)) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

/**
 * `s[lo, hi)` rendered inline into the parts list `out`; `env.link(target)`
 * is a link's href. Works on ranges, so nested spans never copy the string.
 */
function inlineRange(s, lo, hi, env, out) {
  let i = lo;
  while (i < hi) {
    const code = s.charCodeAt(i);
    if (code === 92 && escapedAt(s, i, hi)) {
      const e = ESCAPES[s[i + 1]];
      out.push(e === undefined ? s[i + 1] : e);
      i += 2;
      continue;
    }
    if (code === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (code === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          out.push('<strong>');
          inlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        out.push('<em>');
        inlineRange(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (code === 91) {
      const k = findUnescaped(s, ']', i + 1, hi);
      const m = k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 || m >= hi ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineRange(s, i + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    // A plain run: everything up to the next character that can open a span
    // or needs escaping, written in one slice. (The dispatch above has
    // already claimed \\, `, * and [, so an empty run here is one of the
    // five escaped characters, or a backslash the dispatch did not claim —
    // before a character it does not escape — which is itself.)
    let j = i;
    while (j < hi) {
      const d = s.charCodeAt(j);
      if (d === 92 || d === 96 || d === 42 || d === 91 || d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
      j++;
    }
    if (j > i) {
      out.push(s.slice(i, j));
      i = j;
    } else {
      const e = ESCAPES[s[i]];
      out.push(e === undefined ? s[i] : e);
      i++;
    }
  }
}

/** `s` rendered inline, as one string. */
function inline(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (a "\n" after every block), its table of contents
 * (every level 2 and 3 heading: level, id, inline HTML) and its excerpt (the
 * first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const kindArr = new Uint8Array(n);
  const aArr = new Array(n);
  const bArr = new Int32Array(n);
  const slot = { kind: 0, a: '', b: 0 };
  for (let i = 0; i < n; i++) {
    classify(lines[i], slot);
    kindArr[i] = slot.kind;
    aArr[i] = slot.a;
    bArr[i] = slot.b;
  }
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const kind = kindArr[i];
    if (kind === L_BLANK) {
      i++;
      continue;
    }
    if (kind === L_FENCE) {
      const lang = aArr[i];
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let pre = `<pre><code${cls}>`;
      for (const l of body) pre += `${escapeHtml(l)}\n`;
      blocks.push(`${pre}</code></pre>`);
      continue;
    }
    if (kind === L_HEADING) {
      const text = aArr[i];
      const depth = bArr[i];
      const id = uniqueSlug(slugify(text), ids);
      const html = inline(text, env);
      blocks.push(`<h${depth} id="${id}">${html}</h${depth}>`);
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      i++;
      continue;
    }
    if (kind === L_HR) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (kind === L_QUOTE) {
      const body = [];
      while (i < n && kindArr[i] === L_QUOTE) {
        const line = lines[i++];
        body.push(trimLine(line[1] === ' ' ? line.slice(2) : line.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    if (kind === L_BULLET || kind === L_ORDERED) {
      const isOrdered = kind === L_ORDERED;
      const start = isOrdered ? bArr[i] : 1;
      const items = [];
      while (i < n) {
        if (kindArr[i] === kind) {
          items.push([trimLine(aArr[i])]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let list = `${open}\n`;
      for (const parts of items) list += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${list}</${tag}>`);
      continue;
    }
    // A paragraph: this line and those after it, up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimLine(lines[i])];
    i++;
    while (i < n) {
      const kk = kindArr[i];
      if (kk === L_BLANK || kk === L_FENCE || kk === L_HEADING || kk === L_HR) break;
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// -------------------------------------------------------------- templates ---

const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  // Tokenize: text, {{ }}, {{{ }}} and {% %}; a standalone {% %} tag's line
  // is taken with it.
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = BLANK_RE.test(src.slice(lineStart, open)) && BLANK_RE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });

  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokens) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** An include from compiled code: the named template in the same scope, depth permitting. */
function renderInclude(name, scope, ctx, out, depth) {
  if (depth >= INCLUDE_DEPTH) return;
  const fn = ctx.compiled.get(name);
  if (fn !== undefined && fn !== null) {
    fn(scope, ctx, out, depth + 1);
    return;
  }
  const nodes = ctx.templates.get(name);
  if (nodes !== undefined) renderNodes(nodes, scope, ctx, depth + 1, out);
}

/**
 * Compile a parsed template into a direct render function: the node tree
 * becomes straight-line code (text pushed as literals, paths resolved by
 * the same lookup, loops and branches as real control flow), so rendering
 * pays no per-node dispatch. Returns null when codegen declines, in which
 * case the tree walk below renders the template instead.
 */
function compileTemplate(nodes) {
  const parts = [];
  let uid = 0;
  const gen = (list, scopeVar) => {
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          if (n.text !== '') parts.push(`out.push(${JSON.stringify(n.text)});`);
          break;
        case 'var':
          parts.push(`out.push(escapeHtml(textOf(lookup(${scopeVar}, ${JSON.stringify(n.path)}))));`);
          break;
        case 'raw':
          parts.push(`out.push(textOf(lookup(${scopeVar}, ${JSON.stringify(n.path)})));`);
          break;
        case 'if':
          parts.push(`if (truthy(lookup(${scopeVar}, ${JSON.stringify(n.path)})) !== ${n.not}) {`);
          gen(n.then, scopeVar);
          if (n.else !== null) {
            parts.push('} else {');
            gen(n.else, scopeVar);
          }
          parts.push('}');
          break;
        case 'for': {
          const id = uid++;
          const xs = `xs${id}`;
          const kk = `k${id}`;
          const sc = `sc${id}`;
          parts.push(`{ const ${xs} = lookup(${scopeVar}, ${JSON.stringify(n.path)});`);
          parts.push(`if (Array.isArray(${xs})) {`);
          parts.push(`for (let ${kk} = 0; ${kk} < ${xs}.length; ${kk}++) {`);
          parts.push(`const ${sc} = { vars: { [${JSON.stringify(n.name)}]: ${xs}[${kk}], loop: { index: ${kk} + 1, first: ${kk} === 0, last: ${kk} === ${xs}.length - 1, length: ${xs}.length } }, parent: ${scopeVar} };`);
          gen(n.body, sc);
          parts.push('}}}');
          break;
        }
        case 'include':
          parts.push(`renderInclude(${JSON.stringify(n.name)}, ${scopeVar}, ctx, out, depth);`);
          break;
      }
    }
  };
  gen(nodes, 'scope');
  let inner;
  try {
    inner = new Function('scope', 'ctx', 'out', 'depth', 'lookup', 'textOf', 'truthy', 'escapeHtml', 'renderInclude', parts.join('\n'));
  } catch {
    return null;
  }
  return (scope, ctx, out, depth) => inner(scope, ctx, out, depth, lookup, textOf, truthy, escapeHtml, renderInclude);
}

/** `nodes` rendered in `scope` into the parts list `out`. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include':
        renderInclude(n.name, scope, ctx, out, depth);
        break;
    }
  }
}

// ------------------------------------------------------------------ build ---

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a char code is one of JavaScript's \s whitespace codes. */
function isSpaceCode(c) {
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return (
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace (the count /\S+/g would give). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. makefun-site 1.0.0's answer for the input. */
export function run(input) {
  slugCache.clear();

  // Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n";
  // a source that is not .md is static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a
  // draft. The checks run in the reference's order; the first that fails is
  // the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each page's slug made unique in its directory, in
  // source order; at the root the generator's own names are taken.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by slug, named as first met in the posts' order,
  // ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, then the index pages, the
  // tag pages, the tags page, and the static files.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const compiled = new Map();
  for (const [name, nodes] of templates) compiled.set(name, compileTemplate(nodes));
  const ctx = { templates, compiled, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    const out = [];
    const fn = compiled.get(name);
    if (fn !== null && fn !== undefined) fn(scope, ctx, out, 0);
    else renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every reported line and broken link, sorted, then the
  // counts line.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
