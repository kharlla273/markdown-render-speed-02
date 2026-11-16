// Fast marked-compatible Markdown renderer (CommonMark 0.31.2 + GFM),
// written from scratch. parse(markdown) returns exactly the HTML marked
// 18.1.3 renders with default options (gfm on, breaks off).

// ---------- small helpers ----------
const ESC_TEXT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ATTR = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' };
function escText(s) { return s.replace(/[&<>"']/g, c => ESC_TEXT[c]); }
// Entity-aware attribute escape: escape & " < >, but preserve a & that
// starts a valid entity reference (&name; or valid &#...;).
function escAttr(s) {
  if (s.indexOf('&') === -1) return s.replace(/["<>]/g, c => ESC_ATTR[c]);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '&') {
      const d = decodeEntity(s, i);
      if (d) { out += s.slice(i, i + d[1]); i += d[1]; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === '"' || c === '<' || c === '>') { out += ESC_ATTR[c]; i++; continue; }
    out += c; i++;
  }
  return out;
}
function isSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'; }
function isSpaceOrTab(c) { return c === ' ' || c === '\t'; }
const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
function isPunct(c) { return c !== undefined && PUNCT.has(c); }
// Unicode punctuation / whitespace tests (for flanking rules).
const RE_PUNCT = /\p{P}/u;
const RE_SPACE = /\s/u;
function isUniPunct(c) { return c !== undefined && RE_PUNCT.test(c); }
function isUniSpace(c) { return c === undefined || RE_SPACE.test(c); }

// ---------- HTML entities ----------
// Decode one entity starting at s[i] === '&'. Returns [text, length,
// isVerbatim] or null. Named entities pass through VERBATIM (marked does
// not validate them against the HTML5 table — any &name; is kept); numeric
// entities are decoded (decimal: 1-7 digits, hex: 1-6 digits; 0,
// surrogates and >0x10FFFF become U+FFFD).
function decodeEntity(s, i) {
  if (s[i] !== '&') return null;
  const semi = s.indexOf(';', i + 1);
  if (semi === -1 || semi - i > 32) return null;
  const body = s.slice(i + 1, semi);
  if (body.length === 0) return null;
  if (body[0] === '#') {
    let code;
    if (body[1] === 'x' || body[1] === 'X') {
      const hex = body.slice(2);
      if (hex.length < 1 || hex.length > 6 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
      code = parseInt(hex, 16);
    } else {
      const dec = body.slice(1);
      if (dec.length < 1 || dec.length > 7 || !/^[0-9]+$/.test(dec)) return null;
      code = parseInt(dec, 10);
    }
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) code = 0xFFFD;
    return [String.fromCodePoint(code), semi - i + 1, false];
  }
  if (!/^[A-Za-z0-9]+$/.test(body)) return null;
  return [s.slice(i, semi + 1), semi - i + 1, true];
}

// ---------- tab / column utilities ----------
// Column width of leading whitespace (tabs advance to next multiple of 4).
function indentWidth(line, from = 0) {
  let col = 0;
  let j = from;
  while (j < line.length) {
    const c = line[j];
    if (c === ' ') { col++; j++; }
    else if (c === '\t') { col += 4 - (col % 4); j++; }
    else break;
  }
  return { cols: col, next: j };
}
// Strip n columns from the start of line (from index `from`); a tab cut
// mid-way becomes spaces. Returns the remainder string.
function stripCols(line, n, from = 0) {
  let col = 0;
  let j = from;
  while (j < line.length && col < n) {
    const c = line[j];
    if (c === ' ') { col++; j++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; j++; }
      else { return ' '.repeat(col + w - n) + line.slice(j + 1); }
    } else break;
  }
  return line.slice(j);
}
// Expand all tabs in s to spaces, tab stops every 4 columns from col 0.
function expandTabs(s) {
  if (s.indexOf('\t') === -1) return s;
  let out = '';
  let col = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else { out += c; col++; }
  }
  return out;
}
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// ---------- link reference helpers ----------
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}
// Parse a link destination starting at s[i] (after optional spaces).
// Returns [dest, nextIndex] or null.
function parseLinkDest(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  if (i >= s.length) return null;
  if (s[i] === '<') {
    let j = i + 1;
    let out = '';
    while (j < s.length) {
      const c = s[j];
      if (c === '>') return [out, j + 1];
      if (c === '<' || c === '\n') return null;
      if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  // Bare destination: no spaces/control chars, balanced parens.
  let j = i;
  let out = '';
  let depth = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
    if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    out += c; j++;
  }
  if (depth !== 0) return null;
  if (out.length === 0) return null;
  return [out, j];
}
// Parse a link title starting at s[i]. Returns [title, nextIndex] or null.
function parseLinkTitle(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  if (i >= s.length) return null;
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    let out = '';
    while (j < s.length) {
      const c = s[j];
      if (c === q) return [out, j + 1];
      if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    let out = '';
    while (j < s.length) {
      const c = s[j];
      if (c === ')') return [out, j + 1];
      if (c === '(') return null;
      if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  return null;
}
// Parse a link label starting at s[i] === '['. Returns [label, nextIndex]
// (nextIndex is just past ']'), or null. Handles nesting + escapes.
function parseLinkLabel(s, i) {
  if (s[i] !== '[') return null;
  let j = i + 1;
  let depth = 0;
  let out = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '[') { depth++; out += c; j++; continue; }
    if (c === ']') {
      if (depth === 0) return [out, j + 1];
      depth--; out += c; j++; continue;
    }
    if (c === '\n') { out += '\n'; j++; continue; }
    out += c; j++;
    if (j - i > 1000) return null;
  }
  return null;
}

// ---------- URL handling ----------
function encodeHref(url) {
  let enc;
  // marked never encodes '%' (bare % and existing %XX stay as-is).
  try { enc = encodeURI(url).replace(/%25/g, '%'); } catch (e) { enc = url; }
  return escAttr(enc);
}

// ================= BLOCK PARSER =================
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// Match a blockquote marker at the start of line (content-relative).
// Consumes up to 3 spaces, '>', and one literal space only (a tab after
// '>' is content, per marked). Returns remainder or null.
function matchQuote(line) {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  if (line[i] !== '>') return null;
  i++;
  if (line[i] === ' ') i++;
  else if (line[i] === '\t') {
    // Tab after '>': one column is the optional space; the rest stays.
    const w = 4 - (i % 4);
    return ' '.repeat(w - 1) + line.slice(i + 1);
  }
  return line.slice(i);
}

// Match a fenced code start. Returns {ch, len, info, indent} or null.
function matchFenceStart(line) {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  if (i >= line.length || (line[i] !== '`' && line[i] !== '~')) return null;
  const ch = line[i];
  let j = i;
  while (j < line.length && line[j] === ch) j++;
  const len = j - i;
  if (len < 3) return null;
  let info = line.slice(j).trim();
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { ch, len, info, indent: i };
}

// Match an ATX heading. Returns {level, text} or null.
function matchATX(line) {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  if (line[i] !== '#') return null;
  let j = i;
  while (j < line.length && line[j] === '#') j++;
  const level = j - i;
  if (level > 6) return null;
  if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return null;
  let text = line.slice(j).trim();
  // Strip closing sequence: spaces + #'s at end.
  text = text.replace(/[ \t]+#+[ \t]*$/, '');
  return { level, text };
}

// Match a setext underline. Returns 1 (=) or 2 (-) or 0.
function matchSetext(line) {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  if (i >= line.length || (line[i] !== '=' && line[i] !== '-')) return 0;
  const ch = line[i];
  let j = i;
  while (j < line.length && line[j] === ch) j++;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  if (j !== line.length) return 0;
  return ch === '=' ? 1 : 2;
}

// Match a thematic break.
function matchHr(line) {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  if (i >= line.length) return false;
  const ch = line[i];
  if (ch !== '*' && ch !== '-' && ch !== '_') return false;
  let count = 0;
  let j = i;
  while (j < line.length) {
    const c = line[j];
    if (c === ch) { count++; j++; }
    else if (c === ' ' || c === '\t') j++;
    else return false;
  }
  return count >= 3;
}

// Match an HTML block start. paraOpen=true means type 7 is disallowed.
// Returns {type, end} or null. end is the end-marker string (type 1-5).
function matchHtmlStart(line, paraOpen) {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  if (line[i] !== '<') return null;
  const rest = line.slice(i + 1);
  const lower = rest.toLowerCase();
  // Type 1: script, pre, style, textarea
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (lower.startsWith(tag)) {
      const after = rest[tag.length];
      if (after === undefined || after === ' ' || after === '\t' || after === '>') {
        return { type: 1, end: '</' + tag };
      }
    }
  }
  if (rest.startsWith('!--')) return { type: 2, end: '-->' };
  if (rest.startsWith('?')) return { type: 3, end: '?>' };
  if (rest.startsWith('!') && rest.length > 1 && /[A-Za-z]/.test(rest[1])) {
    if (rest.startsWith('![CDATA[')) return { type: 5, end: ']]>' };
    return { type: 4, end: '>' };
  }
  // Type 6: block tag open/close.
  const m6 = rest.match(/^\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t>\/]|$)/);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { type: 6, end: null };
  // Type 7: any open/close tag alone on the line.
  if (!paraOpen) {
    const m7 = rest.match(/^\/?[A-Za-z][A-Za-z0-9-]*(\s[^>]*)?\/?>[ \t]*$/);
    if (m7) return { type: 7, end: null };
  }
  return null;
}

// Match a list item start. Returns null or
// {ordered, start, delim, indent, rest, empty}.
function matchList(line) {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  const indent = i;
  if (i >= line.length) return null;
  let ordered = false;
  let start = 0;
  let delim = '';
  let j = i;
  const c = line[i];
  if (c === '-' || c === '+' || c === '*') {
    delim = c;
    j = i + 1;
  } else if (c >= '0' && c <= '9') {
    let k = i;
    while (k < line.length && line[k] >= '0' && line[k] <= '9') k++;
    if (k - i > 9) return null;
    if (line[k] !== '.' && line[k] !== ')') return null;
    delim = line[k];
    start = parseInt(line.slice(i, k), 10);
    ordered = true;
    j = k + 1;
  } else return null;
  // After the marker: space/tab/EOL required.
  if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return null;
  const markerEnd = j; // column (content-relative) where marker ends
  // Measure the whitespace run after the marker (tabs expand from markerEnd).
  let col = markerEnd;
  let k = j;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    if (line[k] === ' ') { col++; k++; }
    else { col += 4 - (col % 4); k++; }
  }
  const wsWidth = col - markerEnd;
  const empty = k >= line.length;
  let contentIndent;
  let rest;
  if (empty) {
    contentIndent = markerEnd + 1;
    rest = '';
  } else if (wsWidth >= 1 && wsWidth <= 4) {
    contentIndent = col;
    rest = line.slice(k);
  } else {
    // 5+ columns of whitespace: content indent is marker+1; the content
    // is the line after the marker plus 1 column of whitespace. If the
    // first whitespace char is a tab, only 1 of its columns is consumed
    // and the rest become spaces. (stripCols can't do this: it stops at
    // the non-whitespace marker at the start of the line.)
    contentIndent = markerEnd + 1;
    if (line[markerEnd] === '\t') {
      const w = 4 - (markerEnd % 4);
      rest = ' '.repeat(w - 1) + line.slice(markerEnd + 1);
    } else {
      rest = line.slice(markerEnd + 1);
    }
  }
  return { ordered, start, delim, indent: contentIndent, rest, empty };
}

// Try to parse link reference definitions from the start of a paragraph's
// lines. Mutates `lines` (removes consumed lines). Returns defs found.
function parseLinkRefDefs(lines, refs) {
  let idx = 0;
  while (idx < lines.length) {
    const first = lines[idx];
    // [label]: — up to 3 spaces indent, label, colon.
    let i = 0;
    while (i < first.length && i < 3 && first[i] === ' ') i++;
    if (first[i] !== '[') break;
    const lab = parseLinkLabel(first, i);
    if (!lab) break;
    const [label, afterLabel] = lab;
    if (label.length === 0) break;
    let p = afterLabel;
    while (p < first.length && (first[p] === ' ' || first[p] === '\t')) p++;
    if (first[p] !== ':') break;
    p++;
    // Join this line (from p) with following lines for dest/title parsing.
    const joined = first.slice(p) + '\n' + lines.slice(idx + 1, idx + 3).join('\n');
    const destRes = parseLinkDest(joined, 0);
    if (!destRes) break;
    const [dest, afterDest] = destRes;
    // Count newlines consumed by the destination.
    let nl = 0;
    for (let q = 0; q < afterDest; q++) if (joined[q] === '\n') nl++;
    let used = 1 + nl; // lines consumed so far
    // Optional title on the same line or the next line.
    let title = null;
    let afterTitle = afterDest;
    // Skip spaces/tabs/newlines (at most one newline for the title).
    let t = afterDest;
    let skippedNl = 0;
    while (t < joined.length) {
      const cc = joined[t];
      if (cc === ' ' || cc === '\t') { t++; continue; }
      if (cc === '\n' && skippedNl === 0) { skippedNl++; t++; continue; }
      break;
    }
    if (t < joined.length && (joined[t] === '"' || joined[t] === "'" || joined[t] === '(')) {
      const titleRes = parseLinkTitle(joined, t);
      if (titleRes) {
        title = titleRes[0];
        afterTitle = titleRes[1];
        let nl2 = 0;
        for (let q = afterDest; q < afterTitle; q++) if (joined[q] === '\n') nl2++;
        used = 1 + nl + nl2;
      }
    }
    // After dest/title: only spaces to end of line.
    let e = afterTitle;
    while (e < joined.length && (joined[e] === ' ' || joined[e] === '\t')) e++;
    if (e < joined.length && joined[e] !== '\n') break; // junk after -> not a def
    const norm = normalizeLabel(label);
    if (!(norm in refs)) refs[norm] = { dest, title };
    idx += used;
  }
  lines.splice(0, idx);
}

// Delimiter row check for GFM tables. Returns alignments array or null.
function parseTableDelim(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  if (s.length === 0) return null;
  const cells = s.split('|');
  const align = [];
  for (const cellRaw of cells) {
    const cell = cellRaw.trim();
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return align;
}

// Split a table row line into cells (unescaped pipes only).
function splitTableRow(line) {
  let s = expandTabs(line.trim());
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && k + 1 < s.length && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

// Main block parser. Returns {doc, refs}.
function parseBlocks(src) {
  const norm = src.replace(/\r\n?/g, '\n');
  const srcEndsWithNewline = norm.endsWith('\n');
  const lines = norm.split('\n');
  // The empty string after a final newline is not a real line.
  if (srcEndsWithNewline) lines.pop();
  let closingAtEof = false;
  const refs = {};
  const doc = { t: 'doc', children: [] };
  const stack = [doc];

  function topLeaf() {
    const b = stack[stack.length - 1];
    return (b.t === 'para' || b.t === 'code' || b.t === 'html') ? b : null;
  }
  function deepestItem() {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].t === 'item') return stack[k];
    }
    return null;
  }
  function finalize(b) {
    if (b.t === 'para') {
      parseLinkRefDefs(b.lines, refs);
      if (b.lines.length === 0) { b.t = 'drop'; return; }
      if (b.lines.length >= 2) {
        const align = parseTableDelim(b.lines[1]);
        if (align) {
          const header = splitTableRow(b.lines[0]);
          while (header.length < align.length) header.push('');
          const rows = [];
          for (let r = 2; r < b.lines.length; r++) {
            const cells = splitTableRow(b.lines[r]);
            while (cells.length < align.length) cells.push('');
            rows.push(cells.slice(0, align.length));
          }
          b.t = 'table';
          b.align = align;
          b.header = header.slice(0, align.length);
          b.rows = rows;
          delete b.lines;
          return;
        }
      }
    } else if (b.t === 'code') {
      if (!b.fenced) {
        while (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
      }
      b.text = b.lines.length ? b.lines.join('\n') + '\n' : '';
      delete b.lines;
    } else if (b.t === 'html') {
      // No trailing newline, unless the block runs to end of input and the
      // source ends with a newline (marked quirk).
      b.text = b.lines.join('\n') + (closingAtEof && srcEndsWithNewline ? '\n' : '');
      delete b.lines;
    } else if (b.t === 'list') {
      let tight = true;
      for (let k = 0; k < b.items.length; k++) {
        const it = b.items[k];
        if (it._blankBetween) { tight = false; break; }
        if (it._blankAfter && k < b.items.length - 1) { tight = false; break; }
      }
      b.tight = tight;
    }
  }
  function closeTo(depth) {
    while (stack.length > depth) finalize(stack.pop());
  }
  function closeLeaf() {
    const leaf = topLeaf();
    if (leaf) { stack.pop(); finalize(leaf); }
  }

  for (let ln = 0; ln < lines.length; ln++) {
    let line = lines[ln];
    // ---- Phase 1: match open containers (outer to inner) ----
    let rest = line;
    let failAt = -1;
    const leaf = topLeaf();
    const topIdx = stack.length - (leaf ? 1 : 0);
    for (let k = 1; k < topIdx; k++) {
      const b = stack[k];
      if (b.t === 'list') continue;
      if (b.t === 'quote') {
        const m = matchQuote(rest);
        if (m === null) { failAt = k; break; }
        rest = m;
      } else if (b.t === 'item') {
        if (isBlank(rest)) { b._pendingBlank = true; continue; }
        const ind = indentWidth(rest);
        if (ind.cols >= b._indent) {
          rest = stripCols(rest, b._indent);
        } else { failAt = k; break; }
      }
    }
    if (failAt !== -1) {
      // Lazy continuation? Only for an open paragraph + non-blank line,
      // and NOT a line that starts a new list item (bullet, ordered item
      // continuing the enclosing list, or ordered item starting with 1).
      // A line starting with any list marker is never a lazy continuation:
      // it starts a new item/list (the "starts with 1" rule applies only
      // when the paragraph and the list are at the same level).
      if (leaf && leaf.t === 'para' && !isBlank(line) && !matchList(rest)) {
        leaf.lines.push(expandTabs(rest));
        continue;
      }
      closeTo(failAt);
    }
    // ---- Phase 2: leaf continuation ----
    let cur = topLeaf();
    if (cur && cur.t === 'code' && cur.fenced) {
      // Closing fence?
      let i = 0;
      while (i < rest.length && i < 3 && rest[i] === ' ') i++;
      let j = i;
      while (j < rest.length && rest[j] === cur.fenceCh) j++;
      let closing = false;
      if (j - i >= cur.fenceLen) {
        let k2 = j;
        while (k2 < rest.length && (rest[k2] === ' ' || rest[k2] === '\t')) k2++;
        if (k2 === rest.length) closing = true;
      }
      if (closing) { closeLeaf(); continue; }
      // Content: backtick fences strip up to the opening indent;
      // tilde fences strip nothing (marked quirk).
      cur.lines.push(cur.fenceCh === '~' ? rest : stripCols(rest, cur.fenceIndent));
      continue;
    }
    if (cur && cur.t === 'html') {
      if ((cur.htmlType === 6 || cur.htmlType === 7) && isBlank(rest)) {
        closeLeaf();
        // Fall through to blank-line handling below.
      } else {
        cur.lines.push(rest);
        if (cur.htmlType >= 1 && cur.htmlType <= 5) {
          const low = rest.toLowerCase();
          if (low.indexOf(cur.htmlEnd.toLowerCase()) !== -1) closeLeaf();
        }
        continue;
      }
    }
    if (cur && cur.t === 'code' && !cur.fenced) {
      if (isBlank(rest)) { cur.lines.push(''); continue; }
      const ind = indentWidth(rest);
      if (ind.cols >= 4) { cur.lines.push(stripCols(rest, 4)); continue; }
      closeLeaf(); // dedented: close and reprocess as new block
      cur = null;
    }
    // ---- Phase 3: new block starts (loop: a line can open containers) ----
    let container = stack[stack.length - 1];
    if (container.t === 'para' || container.t === 'code' || container.t === 'html') {
      container = stack[stack.length - 2];
    }
    while (true) {
      // A list container can only be continued by a matching list item;
      // anything else closes the list.
      if (container.t === 'list') {
        const probe = matchList(rest);
        if (!(probe && probe.ordered === container.ordered && probe.delim === container.delim)) {
          stack.pop();
          finalize(container);
          container = stack[stack.length - 1];
        }
      }
      if (isBlank(rest)) {
        closeLeaf();
        const it = deepestItem();
        if (it) it._pendingBlank = true;
        break;
      }
      // Fenced code start
      const fence = matchFenceStart(rest);
      if (fence) {
        closeLeaf();
        const node = { t: 'code', fenced: true, fenceCh: fence.ch, fenceLen: fence.len, info: fence.info, fenceIndent: fence.indent, lines: [] };
        container.children.push(node);
        stack.push(node);
        break;
      }
      // ATX heading
      const atx = matchATX(rest);
      if (atx) {
        closeLeaf();
        container.children.push({ t: 'head', level: atx.level, text: atx.text });
        break;
      }
      // HTML block start
      const paraOpen = topLeaf() && topLeaf().t === 'para';
      const html = matchHtmlStart(rest, paraOpen);
      if (html) {
        closeLeaf();
        const node = { t: 'html', lines: [rest], htmlType: html.type, htmlEnd: html.end };
        container.children.push(node);
        stack.push(node);
        // Type 1-5 may end on the same line.
        if (html.type >= 1 && html.type <= 5) {
          const low = rest.toLowerCase();
          // For type 1, the end tag must appear after the start tag; a
          // simple indexOf can false-positive on the start tag itself
          // (e.g. <script> contains no '</script'), so plain search is ok.
          if (low.indexOf(html.end.toLowerCase()) !== -1) { stack.pop(); finalize(node); }
        }
        break;
      }
      // Setext underline (paragraph open)
      if (paraOpen) {
        const se = matchSetext(rest);
        if (se) {
          const para = topLeaf();
          stack.pop();
          parseLinkRefDefs(para.lines, refs);
          if (para.lines.length === 0) { para.t = 'drop'; }
          else {
            para.t = 'head';
            para.level = se;
            // Setext headings shed the first line's leading spaces and
            // the last line's trailing whitespace.
            para.text = para.lines.join('\n').replace(/^ {1,3}/, '').replace(/[ \t]+$/, '');
            delete para.lines;
          }
          break;
        }
      }
      // Thematic break
      if (matchHr(rest)) {
        closeLeaf();
        container.children.push({ t: 'hr' });
        break;
      }
      // Blockquote start
      const q = matchQuote(rest);
      if (q !== null) {
        closeLeaf();
        const node = { t: 'quote', children: [] };
        container.children.push(node);
        stack.push(node);
        container = node;
        rest = q;
        continue;
      }
      // List start
      const li = matchList(rest);
      if (li) {
        const canInterrupt = !li.empty && (!paraOpen || !li.ordered || li.start === 1);
        if (canInterrupt || !paraOpen) {
          closeLeaf();
          // Find or create the list in this container.
          let list = null;
          if (container.t === 'list') {
            list = container; // loop-top check already verified the marker matches
          } else {
            const kids = container.children;
            if (kids.length > 0) {
              const last = kids[kids.length - 1];
              if (last.t === 'list' && last.ordered === li.ordered && last.delim === li.delim) list = last;
            }
          }
          if (!list) {
            list = { t: 'list', ordered: li.ordered, start: li.start, delim: li.delim, tight: true, items: [] };
            container.children.push(list);
            stack.push(list);
          }
          // Marker-only line counts as a blank line for looseness.
          if (li.empty && list.items.length > 0) {
            list.items[list.items.length - 1]._pendingBlank = true;
          }
          const item = { t: 'item', children: [], _indent: li.indent, _pendingBlank: false, _blankAfter: false, _blankBetween: false };
          list.items.push(item);
          stack.push(item);
          container = item;
          rest = li.rest;
          if (li.empty) break; // empty item: nothing more on this line
          continue;
        }
      }
      // Indented code (no paragraph open)
      if (!paraOpen) {
        const ind = indentWidth(rest);
        if (ind.cols >= 4) {
          const node = { t: 'code', fenced: false, lines: [stripCols(rest, 4)] };
          container.children.push(node);
          stack.push(node);
          break;
        }
      }
      // Paragraph (new or continued)
      if (paraOpen) {
        topLeaf().lines.push(rest);
      } else {
        const node = { t: 'para', lines: [rest] };
        container.children.push(node);
        stack.push(node);
      }
      break;
    }
    // Blank-line looseness bookkeeping: a block added to an item that had
    // a pending blank and already has children -> blank between blocks.
    // (Handled lazily: when a new child is added to an item below.)
    // NOTE: pendingBlank is consumed when the item gains a new block child.
    // We check it at the top of the next iteration via the stack state.
    // Simpler: consume it here for the deepest item if it just got a child.
    // (The child-adding code paths above push directly; we detect a new
    // child by comparing child counts is complex, so instead: if the
    // deepest item has _pendingBlank and >1 children, mark blankBetween.)
    const di = deepestItem();
    if (di && di._pendingBlank) {
      if (di.children.length > 1) { di._blankBetween = true; di._pendingBlank = false; }
      else if (di.children.length === 1 && di.children[0].t !== 'para') { di._blankBetween = true; di._pendingBlank = false; }
      // If the item's only child is a paragraph that is still open, the
      // blank line came before it (leading) — keep pending until the
      // paragraph closes or another block arrives.
    }
    // Blank-after for list items: when a list gains a new item and the
    // previous item had a pending blank, it counts as blank-after.
    // (Handled in the list-start path via _pendingBlank on the item; the
    // finalize step reads _blankAfter — set it when the item closes.)
  }
  // Close everything (at end of input).
  closingAtEof = true;
  while (stack.length > 1) {
    const b = stack.pop();
    // An item closing with a pending blank: it had a blank line after its
    // content. Only matters if it is not the last item; finalize() for
    // the list checks _blankAfter on non-last items, so set it here.
    if (b.t === 'item' && b._pendingBlank) b._blankAfter = true;
    finalize(b);
  }
  // Drop empty paragraphs (link-ref-only) and empty containers cleanup.
  function prune(node) {
    if (!node.children) return;
    node.children = node.children.filter(c => c.t !== 'drop');
    for (const c of node.children) {
      if (c.t === 'quote') prune(c);
      if (c.t === 'list') for (const it of c.items) prune(it);
      if (c.t === 'item') prune(c);
    }
  }
  prune(doc);
  return { doc, refs };
}

// ================= INLINE PARSER =================
// Split a plain string into text/entity nodes (for autolink display text,
// where entities are preserved but no other inline parsing runs).
function textNodesWithEntities(s) {
  const out = [];
  let buf = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '&') {
      const d = decodeEntity(s, i);
      if (d) {
        if (d[2]) {
          if (buf) { out.push({ t: 'text', s: buf }); buf = ''; }
          out.push({ t: 'entity', s: d[0] });
        } else buf += d[0];
        i += d[1];
        continue;
      }
    }
    buf += s[i];
    i++;
  }
  if (buf) out.push({ t: 'text', s: buf });
  return out;
}

// Match an inline HTML tag/comment/PI/declaration/CDATA at s[i] === '<'.
// Returns the raw tag string or null.
function matchInlineHtml(s, i) {
  if (s[i] !== '<') return null;
  const rest = s.slice(i);
  let m = rest.match(/^<!--(>|->|[\s\S]*?-->)/);
  if (m) return m[0];
  m = rest.match(/^<\?[\s\S]*?\?>/);
  if (m) return m[0];
  m = rest.match(/^<![A-Za-z][^>]*>/);
  if (m) return m[0];
  m = rest.match(/^<!\[CDATA\[[\s\S]*?\]\]>/);
  if (m) return m[0];
  m = rest.match(/^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*)?\/?>/);
  if (m) {
    // Attribute values must be well-formed enough: no bare '<' inside.
    return m[0];
  }
  return null;
}

// Match an autolink <scheme:...> or <email> at s[i] === '<'.
// Returns {dest, text, len} or null.
function matchAutolink(s, i) {
  if (s[i] !== '<') return null;
  const end = s.indexOf('>', i + 1);
  if (end === -1 || end - i > 200) return null;
  const inner = s.slice(i + 1, end);
  if (inner.length === 0 || inner.indexOf(' ') !== -1 || inner.indexOf('\n') !== -1 || inner.indexOf('<') !== -1) return null;
  // Scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
  const sm = inner.match(/^([A-Za-z][A-Za-z0-9+.-]{1,31}):([\s\S]*)$/);
  if (sm) {
    const scheme = sm[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https' || scheme === 'ftp' || /^[a-z][a-z0-9+.-]{1,31}$/.test(scheme)) {
      return { dest: inner, text: inner, len: end - i + 1 };
    }
  }
  // Email: local@domain
  if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(inner)) {
    return { dest: 'mailto:' + inner, text: inner, len: end - i + 1 };
  }
  return null;
}

const EMAIL_LOCAL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9-]+$/;
// Scan a domain starting at s[i] (labels separated by dots). Returns the
// end index (exclusive) or -1 if invalid. Requires at least one dot and a
// final label of 2+ letters. Stops at ']', ')', '(' (guidance).
function scanDomain(s, i) {
  let j = i;
  let labels = 0;
  let lastLabelStart = i;
  while (j < s.length) {
    const c = s[j];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-') { j++; continue; }
    if (c === '.') {
      const label = s.slice(lastLabelStart, j);
      if (!DOMAIN_LABEL.test(label)) return -1;
      labels++;
      j++;
      lastLabelStart = j;
      continue;
    }
    break;
  }
  const lastLabel = s.slice(lastLabelStart, j);
  if (labels < 1) return -1;
  if (!/^[A-Za-z]{2,}$/.test(lastLabel)) return -1;
  return j;
}
// Scan an extended-autolink path starting at s[i] (after the domain).
// Handles parens (an opening paren is included only if a closing paren
// follows before whitespace; balance counts only after the last ']'),
// stops at whitespace/'<', and strips trailing punctuation.
// Returns the end index (exclusive).
function scanAutolinkPath(s, i, hasActiveBracket) {
  let j = i;
  let lastBracket = -1;
  while (j < s.length) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '<') break;
    if (c === ']') {
      if (hasActiveBracket) break;
      lastBracket = j;
      j++;
      continue;
    }
    j++;
  }
  let end = j;
  // Paren balance, counted only after the last ']'.
  const segStart = lastBracket === -1 ? i : lastBracket + 1;
  let depth = 0;
  for (let k = segStart; k < end; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')') {
      if (depth === 0) { end = k; break; }
      depth--;
    }
  }
  // An unmatched '(' is dropped (and everything after it).
  if (depth > 0) {
    let d = 0;
    for (let k = segStart; k < end; k++) {
      if (s[k] === '(') d++;
      else if (s[k] === ')') d--;
      if (d > 0 && k === end - 1) { /* keep scanning */ }
    }
    // Find the first unmatched '(' from the left within the segment.
    let bal = 0;
    let cut = -1;
    for (let k = segStart; k < end; k++) {
      if (s[k] === '(') { bal++; if (cut === -1) cut = k; }
      else if (s[k] === ')') { bal--; if (bal === 0) cut = -1; }
    }
    if (bal > 0 && cut !== -1) end = cut;
  }
  // Strip trailing punctuation: ? ! . , : * _ ~
  while (end > i) {
    const c = s[end - 1];
    if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':' || c === '*' || c === '_' || c === '~') { end--; continue; }
    if (c === ';') {
      // Keep the ';' if it completes an entity (e.g. &amp;).
      const amp = s.lastIndexOf('&', end - 1);
      if (amp !== -1 && amp >= i && /^[A-Za-z0-9#]+$/.test(s.slice(amp + 1, end - 1))) break;
      end--;
      continue;
    }
    break;
  }
  return end;
}

// Try to match an extended autolink (www. or email) at s[i].
// Returns {dest, text, len} or null. hasActiveBracket: a '[' is open.
function matchExtendedAutolink(s, i, hasActiveBracket) {
  // www. — must be preceded by start/whitespace/punct (not alnum or '.').
  if (s.startsWith('www.', i)) {
    const prev = i === 0 ? undefined : s[i - 1];
    if (prev === undefined || isUniSpace(prev) || (isUniPunct(prev) && prev !== '.')) {
      const domEnd = scanDomain(s, i + 4);
      if (domEnd !== -1) {
        const pathEnd = scanAutolinkPath(s, domEnd, hasActiveBracket);
        const text = s.slice(i, pathEnd);
        return { dest: 'http://' + text, text, len: pathEnd - i };
      }
    }
    return null;
  }
  // Email: local@domain. Trigger on alnum at a word start.
  const c = s[i];
  const isAlnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
  if (!isAlnum) return null;
  const prev = i === 0 ? undefined : s[i - 1];
  if (prev !== undefined && EMAIL_LOCAL.test(prev)) return null;
  // Scan the local part.
  let j = i;
  while (j < s.length && EMAIL_LOCAL.test(s[j])) j++;
  if (j >= s.length || s[j] !== '@') return null;
  const local = s.slice(i, j);
  if (local.startsWith('.') || local.endsWith('.') || local.indexOf('..') !== -1) return null;
  const domEnd = scanDomain(s, j + 1);
  if (domEnd === -1) return null;
  const text = s.slice(i, domEnd);
  return { dest: 'mailto:' + text, text, len: domEnd - i };
}

// Emphasis resolution over nodes[startIdx..endIdx) using delims (entries
// whose nodes lie in that range). Mutates nodes/delims in place.
function processEmphasis(nodes, delims, startIdx, endIdx) {
  // Build the list of closer entries in range, in node order.
  const inRange = d => {
    const idx = nodes.indexOf(d.node);
    return idx >= startIdx && idx < endIdx;
  };
  const ghosts = []; // {node, origLen, ch}
  // Iterate closers by position; re-scan after each pass since wrapping
  // changes indices. Use a work list of closer entries sorted by position.
  let closers = delims.filter(d => d.canClose && d.len > 0 && inRange(d));
  closers.sort((a, b) => nodes.indexOf(a.node) - nodes.indexOf(b.node));
  for (const closer of closers) {
    if (closer.len <= 0) continue;
    let cIdx = nodes.indexOf(closer.node);
    if (cIdx < startIdx || cIdx >= endIdx) continue;
    // Look back for an opener.
    while (closer.len > 0) {
      cIdx = nodes.indexOf(closer.node);
      let opener = null;
      let oIdx = -1;
      // Nearest opener before the closer, same char, canOpen, len>0.
      for (let k = delims.length - 1; k >= 0; k--) {
        const d = delims[k];
        if (d === closer || d.ch !== closer.ch || !d.canOpen || d.len <= 0) continue;
        const di = nodes.indexOf(d.node);
        if (di < startIdx || di >= cIdx) continue;
        opener = d;
        oIdx = di;
        break;
      }
      if (!opener) break;
      // Odd-match rule (+ ghost rule).
      let blocked = false;
      const sum = opener.len + closer.len;
      const bothMult3 = opener.len % 3 === 0 && closer.len % 3 === 0;
      if (closer.canOpen && sum % 3 === 0 && !bothMult3) blocked = true;
      if (!blocked && !closer.canOpen) {
        // Ghost rule: a consumed delimiter between opener and closer,
        // with closer.len <= ghost.origLen, enables the rule-of-3.
        for (const g of ghosts) {
          if (g.ch !== closer.ch) continue;
          const gIdx = nodes.indexOf(g.node);
          if (gIdx > oIdx && gIdx < cIdx && closer.len <= g.origLen) {
            if (sum % 3 === 0 && !bothMult3) { blocked = true; }
            break;
          }
        }
      }
      if (blocked) {
        // This opener can't match this closer; try an earlier opener.
        // Mark it temporarily skipped by looking further back: we do this
        // by excluding it from the next search via a skip set.
        // Simplest: remove it from consideration for THIS closer by
        // recording it in a per-closer skip list.
        closer._skip = closer._skip || new Set();
        closer._skip.add(opener);
        // Re-run the opener search excluding skipped ones.
        let found = null;
        for (let k = delims.length - 1; k >= 0; k--) {
          const d = delims[k];
          if (d === closer || d.ch !== closer.ch || !d.canOpen || d.len <= 0) continue;
          if (closer._skip.has(d)) continue;
          const di = nodes.indexOf(d.node);
          if (di < startIdx || di >= cIdx) continue;
          found = d;
          break;
        }
        if (!found) break;
        opener = found;
        oIdx = nodes.indexOf(opener.node);
        // Re-check the odd-match rule for the new opener.
        const sum2 = opener.len + closer.len;
        const both2 = opener.len % 3 === 0 && closer.len % 3 === 0;
        if (closer.canOpen && sum2 % 3 === 0 && !both2) {
          closer._skip.add(opener);
          continue;
        }
        if (!closer.canOpen) {
          let gb = false;
          for (const g of ghosts) {
            if (g.ch !== closer.ch) continue;
            const gIdx = nodes.indexOf(g.node);
            if (gIdx > oIdx && gIdx < cIdx && closer.len <= g.origLen) {
              if (sum2 % 3 === 0 && !both2) gb = true;
              break;
            }
          }
          if (gb) { closer._skip.add(opener); continue; }
        }
      }
      // Match: use 2 if both have >= 2, else 1.
      const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      const kind = use === 2 ? (opener.ch === '~' ? 'del' : 'strong') : 'em';
      // Record ghosts for the consumed delimiters.
      ghosts.push({ node: opener.node, origLen: opener.len, ch: opener.ch });
      ghosts.push({ node: closer.node, origLen: closer.len, ch: closer.ch });
      opener.len -= use;
      closer.len -= use;
      // Sync the node lengths: the renderer prints node.len chars.
      opener.node.len = opener.len;
      closer.node.len = closer.len;
      // Wrap nodes between opener and closer.
      const children = nodes.slice(oIdx + 1, cIdx);
      const emNode = { t: kind, children };
      nodes.splice(oIdx + 1, cIdx - oIdx - 1, emNode);
      // Continue: the closer may match another opener.
    }
  }
}

// Parse inline content into a node list, then render to HTML.
function parseInline(src, refs) {
  const s = src;
  const nodes = [];
  const delims = [];
  const brackets = []; // {nodeIdx, active, image, srcStart}
  let buf = '';
  let inAnchor = false;
  const flush = () => { if (buf.length > 0) { nodes.push({ t: 'text', s: buf }); buf = ''; } };

  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    // Backslash escapes / hard break.
    if (c === '\\' && i + 1 < n) {
      const nx = s[i + 1];
      if (nx === '\n') { flush(); nodes.push({ t: 'br' }); i += 2; continue; }
      if (isPunct(nx)) { buf += nx; i += 2; continue; }
      buf += c; i++; continue;
    }
    // Entities.
    if (c === '&') {
      const d = decodeEntity(s, i);
      if (d) {
        if (d[2]) { flush(); nodes.push({ t: 'entity', s: d[0] }); }
        else buf += d[0];
        i += d[1];
        continue;
      }
      buf += c; i++; continue;
    }
    // Code spans.
    if (c === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const runLen = j - i;
      // Find a matching run.
      let k = j;
      let found = -1;
      while (k < n) {
        if (s[k] === '`') {
          let e = k;
          while (e < n && s[e] === '`') e++;
          if (e - k === runLen) { found = k; break; }
          k = e;
        } else k++;
      }
      if (found !== -1) {
        let content = s.slice(j, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim().length > 0) {
          content = content.slice(1, -1);
        }
        flush();
        nodes.push({ t: 'code', s: content });
        i = found + runLen;
        continue;
      }
      buf += s.slice(i, j);
      i = j;
      continue;
    }
    // HTML / autolinks.
    if (c === '<') {
      const html = matchInlineHtml(s, i);
      if (html) {
        flush();
        nodes.push({ t: 'html', s: html });
        const low = html.toLowerCase();
        if (/^<a(\s|\/?>)/.test(low)) inAnchor = true;
        else if (low.startsWith('</a')) inAnchor = false;
        i += html.length;
        continue;
      }
      const al = matchAutolink(s, i);
      if (al) {
        flush();
        nodes.push({ t: 'link', dest: al.dest, title: null, children: textNodesWithEntities(al.text) });
        i += al.len;
        continue;
      }
      buf += c; i++; continue;
    }
    // Images / links: '![' or '['.
    if (c === '!' && i + 1 < n && s[i + 1] === '[') {
      flush();
      const node = { t: 'bracket', image: true };
      nodes.push(node);
      brackets.push({ node, active: true, image: true, srcStart: i + 1 });
      i += 2;
      continue;
    }
    if (c === '[') {
      flush();
      const node = { t: 'bracket', image: false };
      nodes.push(node);
      brackets.push({ node, active: true, image: false, srcStart: i });
      i++;
      continue;
    }
    // Close bracket: try to form a link/image.
    if (c === ']') {
      // Find nearest active bracket.
      let bi = -1;
      for (let b = brackets.length - 1; b >= 0; b--) {
        if (brackets[b].active) { bi = b; break; }
      }
      if (bi === -1) { buf += c; i++; continue; }
      const br = brackets[bi];
      const bNodeIdx = nodes.indexOf(br.node);
      // Parse the tail.
      let dest = null;
      let title = null;
      let next = i + 1;
      let formed = false;
      if (s[next] === '(') {
        // Inline link: (dest "title")
        let p = next + 1;
        while (p < n && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
        const dRes = parseLinkDest(s, p);
        if (dRes) {
          dest = dRes[0];
          p = dRes[1];
        } else if (p < n && (s[p] === ')' || s[p] === '"' || s[p] === "'" || s[p] === '(')) {
          dest = '';
        }
        if (dest !== null) {
          // Optional title.
          let t = p;
          while (t < n && (s[t] === ' ' || s[t] === '\t' || s[t] === '\n')) t++;
          if (t < n && (s[t] === '"' || s[t] === "'" || s[t] === '(')) {
            const tRes = parseLinkTitle(s, t);
            if (tRes) { title = tRes[0]; t = tRes[1]; }
          }
          while (t < n && (s[t] === ' ' || s[t] === '\t' || s[t] === '\n')) t++;
          if (t < n && s[t] === ')') { formed = true; next = t + 1; }
        }
      } else if (s[next] === '[') {
        const lab = parseLinkLabel(s, next);
        if (lab) {
          let label;
          if (lab[0] === '') {
            // Collapsed: label is the link text.
            label = s.slice(br.srcStart + 1, i);
          } else label = lab[0];
          const ref = refs[normalizeLabel(label)];
          if (ref) { dest = ref.dest; title = ref.title; formed = true; next = lab[1]; }
        }
      } else {
        // Shortcut reference: label is the link text.
        const label = s.slice(br.srcStart + 1, i);
        const ref = refs[normalizeLabel(label)];
        if (ref) { dest = ref.dest; title = ref.title; formed = true; next = i + 1; }
      }
      if (formed) {
        flush(); // the link text may still be buffered; it belongs in the nodes
        // Backtick rule: a code span in the link text blocks the link
        // unless it is the final node of the text.
        const textNodes = nodes.slice(bNodeIdx + 1);
        let blocked = false;
        for (let q = 0; q < textNodes.length; q++) {
          if (textNodes[q].t === 'code' && q !== textNodes.length - 1) { blocked = true; break; }
        }
        if (!blocked) {
          // Resolve emphasis inside the link text first.
          processEmphasis(nodes, delims, bNodeIdx + 1, nodes.length);
          const children = nodes.splice(bNodeIdx, nodes.length - bNodeIdx);
          children.shift(); // remove the bracket node
          if (br.image) {
            nodes.push({ t: 'image', dest, title, children });
          } else {
            nodes.push({ t: 'link', dest, title, children });
            // A link deactivates all earlier brackets (no nested links).
            for (let b = 0; b < bi; b++) brackets[b].active = false;
          }
          brackets.splice(bi, 1);
          i = next;
          continue;
        }
      }
      // No link formed: deactivate this bracket; ']' is literal.
      br.active = false;
      buf += c; i++;
      continue;
    }
    // Emphasis delimiters * and _.
    if (c === '*' || c === '_') {
      let j = i;
      while (j < n && s[j] === c) j++;
      const len = j - i;
      const prev = i === 0 ? undefined : s[i - 1];
      const nextCh = j >= n ? undefined : s[j];
      const prevSpace = isUniSpace(prev);
      const nextSpace = isUniSpace(nextCh);
      const prevPunct = isUniPunct(prev);
      const nextPunct = isUniPunct(nextCh);
      const leftFlanking = !nextSpace && (!nextPunct || prevSpace || prevPunct);
      const rightFlanking = !prevSpace && (!prevPunct || nextSpace || nextPunct);
      let canOpen, canClose;
      if (c === '*') { canOpen = leftFlanking; canClose = rightFlanking; }
      else {
        canOpen = leftFlanking && (!rightFlanking || prevPunct);
        canClose = rightFlanking && (!leftFlanking || nextPunct);
      }
      flush();
      const node = { t: 'delim', ch: c, len, canOpen, canClose };
      nodes.push(node);
      delims.push({ node, ch: c, len, canOpen, canClose });
      i = j;
      continue;
    }
    // Strikethrough delimiters ~~ (exactly 2).
    if (c === '~') {
      let j = i;
      while (j < n && s[j] === '~') j++;
      const len = j - i;
      if (len === 2) {
        const prev = i === 0 ? undefined : s[i - 1];
        const nextCh = j >= n ? undefined : s[j];
        const prevSpace = isUniSpace(prev);
        const nextSpace = isUniSpace(nextCh);
        const prevPunct = isUniPunct(prev);
        const nextPunct = isUniPunct(nextCh);
        const leftFlanking = !nextSpace && (!nextPunct || prevSpace || prevPunct);
        const rightFlanking = !prevSpace && (!prevPunct || nextSpace || nextPunct);
        flush();
        const node = { t: 'delim', ch: '~', len: 2, canOpen: leftFlanking, canClose: rightFlanking };
        nodes.push(node);
        delims.push({ node, ch: '~', len: 2, canOpen: leftFlanking, canClose: rightFlanking });
        i = j;
        continue;
      }
      buf += s.slice(i, j);
      i = j;
      continue;
    }
    // Newlines: hard break (2+ trailing spaces) or soft break.
    if (c === '\n') {
      flush();
      // Count trailing spaces in the last text node (already flushed).
      const last = nodes[nodes.length - 1];
      let hard = false;
      if (last && last.t === 'text') {
        const m = last.s.match(/ {2,}$/);
        if (m) { last.s = last.s.slice(0, -m[0].length); hard = true; }
      }
      if (hard) nodes.push({ t: 'br' });
      else buf += '\n';
      i++;
      continue;
    }
    // Extended autolinks (suppressed inside an unclosed <a>).
    if (!inAnchor && (c === 'w' || ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')))) {
      const hasActiveBracket = brackets.some(b => b.active);
      const ea = matchExtendedAutolink(s, i, hasActiveBracket);
      if (ea) {
        flush();
        nodes.push({ t: 'link', dest: ea.dest, title: null, children: textNodesWithEntities(ea.text) });
        i += ea.len;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  // Resolve emphasis over the whole node list.
  processEmphasis(nodes, delims, 0, nodes.length);
  return nodes;
}

// Render an inline node list to HTML.
function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'text': out += escText(node.s); break;
      case 'code': out += '<code>' + escText(node.s) + '</code>'; break;
      case 'html': out += node.s; break;
      case 'entity': out += node.s; break;
      case 'br': out += '<br>'; break;
      case 'link': {
        out += '<a href="' + encodeHref(node.dest) + '"';
        if (node.title !== null && node.title !== undefined) out += ' title="' + escAttr(node.title) + '"';
        out += '>' + renderInline(node.children) + '</a>';
        break;
      }
      case 'image': {
        out += '<img src="' + encodeHref(node.dest) + '" alt="' + escAttr(plainText(node.children)) + '"';
        if (node.title !== null && node.title !== undefined) out += ' title="' + escAttr(node.title) + '"';
        out += '>';
        break;
      }
      case 'em': out += '<em>' + renderInline(node.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInline(node.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInline(node.children) + '</del>'; break;
      case 'delim': out += node.ch.repeat(Math.max(0, node.len)); break;
      case 'bracket': out += node.image ? '![' : '['; break;
    }
  }
  return out;
}

// Plain text of inline nodes (for image alt text).
function plainText(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'text': out += node.s; break;
      case 'code': out += node.s; break;
      case 'br': out += '\n'; break;
      case 'link': case 'em': case 'strong': case 'del': out += plainText(node.children); break;
      case 'image': out += plainText(node.children); break;
      case 'entity': out += node.s; break;
      case 'delim': out += node.ch.repeat(Math.max(0, node.len)); break;
      case 'bracket': out += node.image ? '![' : '['; break;
      default: break;
    }
  }
  return out;
}

// ================= BLOCK RENDERER =================
function renderItem(item, tight, refs) {
  let out = '<li>';
  const kids = item.children;
  let taskHtml = '';
  let taskRest = null;
  if (kids.length > 0 && kids[0].t === 'para') {
    const text = kids[0].lines.join('\n');
    const m = text.match(/^\[([ xX])\][ \t]+/);
    if (m) {
      taskHtml = m[1] === ' '
        ? '<input disabled="" type="checkbox"> '
        : '<input checked="" disabled="" type="checkbox"> ';
      taskRest = text.slice(m[0].length);
    }
  }
  if (tight && kids.length === 1 && kids[0].t === 'para') {
    const text = taskRest !== null ? taskRest : kids[0].lines.join('\n');
    out += taskHtml + renderInline(parseInline(text, refs));
  } else {
    for (let k = 0; k < kids.length; k++) {
      const child = kids[k];
      if (k === 0 && child.t === 'para' && taskRest !== null) {
        out += '<p>' + taskHtml + renderInline(parseInline(taskRest, refs)) + '</p>\n';
      } else {
        out += renderBlock(child, refs);
      }
    }
  }
  out += '</li>\n';
  return out;
}

function renderBlock(node, refs) {
  switch (node.t) {
    case 'para':
      return '<p>' + renderInline(parseInline(node.lines.join('\n'), refs)) + '</p>\n';
    case 'head':
      return '<h' + node.level + '>' + renderInline(parseInline(node.text, refs)) + '</h' + node.level + '>\n';
    case 'code': {
      let cls = '';
      if (node.info) {
        const first = node.info.split(/[ \t]/)[0];
        if (first) cls = ' class="language-' + escAttr(first) + '"';
      }
      return '<pre><code' + cls + '>' + escText(node.text) + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'quote':
      return '<blockquote>\n' + node.children.map(c => renderBlock(c, refs)).join('') + '</blockquote>\n';
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const it of node.items) out += renderItem(it, node.tight, refs);
      out += '</' + tag + '>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < node.header.length; k++) {
        const a = node.align[k];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInline(node.header[k], refs)) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let k = 0; k < row.length; k++) {
            const a = node.align[k];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInline(row[k], refs)) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    case 'hr':
      return '<hr>\n';
    default:
      return '';
  }
}

export function parse(src) {
  const { doc, refs } = parseBlocks(src);
  let out = '';
  for (const c of doc.children) out += renderBlock(c, refs);
  return out;
}
