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
// Punctuation includes Unicode Sc (currency symbols like $/£/€) and
// the ASCII punctuation chars that are not \p{P} (Sm/Sk: + < = > ^
// ` | ~) — marked treats all ASCII punctuation as punctuation for
// flanking, so e.g. '_' can close before '~' and open after a
// backtick (a code-span boundary).
const RE_PUNCT = /[\p{P}\p{Sc}+<=>^`|~]/u;
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
      else { return ' '.repeat(col + w - n) + expandLeadingTabs(line.slice(j + 1), col + w); }
    } else break;
  }
  return expandLeadingTabs(line.slice(j), col);
}
// Strip n columns from code content (indented code, backtick fence
// content): a tab encountered while col < n is consumed ENTIRELY even
// if it extends past n (marked quirk: strip 2 from "\tfoo" -> "foo"),
// and the remainder is kept VERBATIM (tabs are not expanded).
function stripCodeCols(line, n, from = 0) {
  let col = 0;
  let j = from;
  while (j < line.length && col < n) {
    const c = line[j];
    if (c === ' ') { col++; j++; }
    else if (c === '\t') { col += 4 - (col % 4); j++; }
    else break;
  }
  return line.slice(j);
}
// Expand tabs in the leading whitespace run of s to spaces, with tab
// stops every 4 columns counting from startCol (the column where s
// starts in the original line). Content tabs are left untouched.
function expandLeadingTabs(s, startCol) {
  if (s.indexOf('\t') === -1) return s;
  let out = '';
  let col = startCol;
  let k = 0;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) {
    if (s[k] === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else { out += ' '; col++; }
    k++;
  }
  return out + s.slice(k);
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
  // Unicode case folding: ß/ẞ fold to "ss" (toLowerCase gives ß for ẞ).
  return s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ß/g, 'ss');
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
// (nextIndex is just past ']'), or null. Marked's labels are literal:
// no nesting (an unescaped '[' fails the label) and no backslash
// unescaping (escapes are skipped for matching but kept in the text).
function parseLinkLabel(s, i) {
  if (s[i] !== '[') return null;
  let j = i + 1;
  let out = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { out += s[j] + s[j + 1]; j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') return [out, j + 1];
    out += c; j++;
    if (j - i > 1000) return null;
  }
  return null;
}

// H3-final backtick rule for link labels (oracle-probed): count the
// backtick runs in the label (backslash-escaped backticks don't count;
// runs pair up adjacently, length-agnostic). The label is valid iff the
// run count is even, or the count is odd with the last run of length
// >= 2 sitting at the very end of the label.
function labelBackticksValid(label) {
  let count = 0;
  let lastLen = 0;
  let lastEnd = -1;
  for (let k = 0; k < label.length; k++) {
    if (label[k] === '\\' && k + 1 < label.length && isPunct(label[k + 1])) { k++; continue; }
    if (label[k] === '`') {
      let e = k;
      while (e < label.length && label[e] === '`') e++;
      count++;
      lastLen = e - k;
      lastEnd = e;
      k = e - 1;
    }
  }
  if (count % 2 === 0) return true;
  return lastLen >= 2 && lastEnd === label.length;
}

// Count the backtick runs in a label that do NOT pair into a code span
// (greedy code-span pairing: a run pairs with the next run of the same
// length, and runs inside a formed span are consumed). Backslash-escaped
// backticks don't count. A formed inline link/image whose label has >= 2
// unmatched runs triggers emphasis suppression later in the paragraph
// (oracle-probed).
function countUnmatchedBacktickRuns(label) {
  const runs = [];
  for (let k = 0; k < label.length; k++) {
    if (label[k] === '\\' && k + 1 < label.length && isPunct(label[k + 1])) { k++; continue; }
    if (label[k] === '`') {
      let e = k;
      while (e < label.length && label[e] === '`') e++;
      runs.push(e - k);
      k = e - 1;
    }
  }
  let unmatched = 0;
  let i = 0;
  while (i < runs.length) {
    let paired = false;
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j] === runs[i]) { i = j + 1; paired = true; break; }
    }
    if (!paired) { unmatched++; i++; }
  }
  return unmatched;
}

// Does a valid link tail start at s[p] (the char after a ']' whose label
// is `label`)? Mirrors the ']' handler: inline tail (with shortcut
// fallback on failure), full/collapsed ref tail, or shortcut ref.
function linkTailAfter(s, p, label, refs) {
  const n = s.length;
  if (s[p] === '(') {
    let q = p + 1;
    while (q < n && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) q++;
    let dest = null;
    const dRes = parseLinkDest(s, q);
    if (dRes) { dest = dRes[0]; q = dRes[1]; }
    else if (q < n && (s[q] === ')' || s[q] === '"' || s[q] === "'" || s[q] === '(')) dest = '';
    if (dest !== null) {
      let t = q;
      while (t < n && (s[t] === ' ' || s[t] === '\t' || s[t] === '\n')) t++;
      if (t < n && (s[t] === '"' || s[t] === "'" || s[t] === '(')) {
        const tRes = parseLinkTitle(s, t);
        if (tRes) t = tRes[1];
      }
      while (t < n && (s[t] === ' ' || s[t] === '\t' || s[t] === '\n')) t++;
      if (t < n && s[t] === ')') return true;
    }
    return !!refs[normalizeLabel(label)];
  }
  if (s[p] === '[') {
    const lab = parseLinkLabel(s, p);
    if (lab) {
      const ref = refs[normalizeLabel(lab[0] === '' ? label : lab[0])];
      return !!ref;
    }
    return false;
  }
  return !!refs[normalizeLabel(label)];
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
  const gt = i;
  i++;
  if (line[i] === ' ') i++;
  else if (line[i] === '\t') {
    // Tab after '>': one column is the optional space; the rest stays.
    // Expand any further leading tabs at their original columns.
    const w = 4 - (i % 4);
    return ' '.repeat(w - 1) + expandLeadingTabs(line.slice(i + 1), i + w);
  }
  // Expand leading tabs of the remainder with the column grid
  // restarting at the '>' marker (marked quirk: '> \t' -> 2 spaces,
  // and '> \tfoo' is a paragraph, not indented code).
  return expandLeadingTabs(line.slice(i), i - gt);
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
  // Strip the closing sequence BEFORE trimming: "### ###" has its
  // closing #'s preceded by a space in the raw text.
  let text = line.slice(j);
  text = text.replace(/[ \t]+#+[ \t]*$/, '');
  return { level, text: text.trim() };
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
  if (rest.startsWith('![CDATA[')) return { type: 5, end: ']]>' };
  if (rest.startsWith('!') && rest.length > 1 && /[A-Za-z]/.test(rest[1])) {
    return { type: 4, end: '>' };
  }
  // Type 6: block tag open/close.
  const m6 = rest.match(/^\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t>\/]|$)/);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { type: 6, end: null };
  // Type 7: any valid open/close tag alone on the line (strict grammar:
  // attribute names/values must be well-formed, close tags take no attrs).
  if (!paraOpen) {
    const m7open = rest.match(/^[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*('[^']*'|"[^"]*"|[^\s"'=<>`]+))?)*\s*\/?>[ \t]*$/);
    const m7close = rest.match(/^\/[A-Za-z][A-Za-z0-9-]*\s*>[ \t]*$/);
    if (m7open || m7close) return { type: 7, end: null };
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
      rest = ' '.repeat(w - 1) + expandLeadingTabs(line.slice(markerEnd + 1), markerEnd + w);
    } else {
      rest = expandLeadingTabs(line.slice(markerEnd + 1), markerEnd + 1);
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
    // The label may span lines: join following non-blank lines until
    // the label closes (labels keep their raw newlines; normalizing
    // collapses them to spaces).
    let labelText = first;
    let labelLines = 1;
    let lab = parseLinkLabel(labelText, i);
    while (!lab && idx + labelLines < lines.length && lines[idx + labelLines].trim() !== '' && labelLines < 10) {
      labelText += '\n' + lines[idx + labelLines];
      labelLines++;
      lab = parseLinkLabel(labelText, i);
    }
    if (!lab) break;
    const [label, afterLabel] = lab;
    if (normalizeLabel(label).length === 0) break;
    const restOfLast = labelText.slice(afterLabel);
    let p = 0;
    while (p < restOfLast.length && (restOfLast[p] === ' ' || restOfLast[p] === '\t')) p++;
    if (restOfLast[p] !== ':') break;
    p++;
    // Join the rest of the last label line with following lines for
    // dest/title parsing (titles may span several lines).
    const joined = restOfLast.slice(p) + '\n' + lines.slice(idx + labelLines, idx + labelLines + 10).join('\n');
    const destRes = parseLinkDest(joined, 0);
    if (!destRes) break;
    const [dest, afterDest] = destRes;
    // Count newlines consumed by the destination.
    let nl = 0;
    for (let q = 0; q < afterDest; q++) if (joined[q] === '\n') nl++;
    let used = labelLines + nl; // lines consumed so far
    // Optional title on the same line or the next line. A title must be
    // separated from the destination by whitespace.
    let title = null;
    let afterTitle = afterDest;
    // Skip spaces/tabs/newlines (at most one newline for the title).
    let t = afterDest;
    let skippedNl = 0;
    let skippedWs = false;
    while (t < joined.length) {
      const cc = joined[t];
      if (cc === ' ' || cc === '\t') { skippedWs = true; t++; continue; }
      if (cc === '\n' && skippedNl === 0) { skippedNl++; skippedWs = true; t++; continue; }
      break;
    }
    if (skippedWs && t < joined.length && (joined[t] === '"' || joined[t] === "'" || joined[t] === '(')) {
      const titleRes = parseLinkTitle(joined, t);
      if (titleRes) {
        title = titleRes[0];
        afterTitle = titleRes[1];
        let nl2 = 0;
        for (let q = afterDest; q < afterTitle; q++) if (joined[q] === '\n') nl2++;
        used = labelLines + nl + nl2;
      }
    }
    // After dest/title: only spaces to end of line. If junk follows a
    // title, retry without the title (the dest alone still defines).
    let e = afterTitle;
    while (e < joined.length && (joined[e] === ' ' || joined[e] === '\t')) e++;
    if (e < joined.length && joined[e] !== '\n') {
      if (title === null) break; // junk after dest -> not a def
      title = null;
      afterTitle = afterDest;
      used = labelLines + nl;
      e = afterTitle;
      while (e < joined.length && (joined[e] === ' ' || joined[e] === '\t')) e++;
      if (e < joined.length && joined[e] !== '\n') break;
    }
    const norm = normalizeLabel(label);
    if (!(norm in refs)) refs[norm] = { dest, title };
    idx += used;
  }
  lines.splice(0, idx);
}

// Delimiter row check for GFM tables. Returns alignments array or null.
// A delimiter row indented 4+ columns is not a delimiter row.
function parseTableDelim(line) {
  if (indentWidth(line).cols > 3) return null;
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
        const header = splitTableRow(b.lines[0]);
        if (align && align.length === header.length) {
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
        // Indented code: strip trailing blank (whitespace-only) lines.
        while (b.lines.length > 0 && isBlank(b.lines[b.lines.length - 1])) b.lines.pop();
      } else if (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') {
        // Fenced code: exactly one trailing blank line is dropped (it is
        // the separator before the closing fence, not content).
        b.lines.pop();
      }
      b.text = b.lines.length ? b.lines.join('\n') + '\n' : '';
      delete b.lines;
    } else if (b.t === 'html') {
      // Trailing newline is decided at close time (_trailingNl): present
      // when the block is followed by more content in its container, or
      // runs to EOF with a trailing newline in the source; absent when
      // it ends at a blank line or its container closes.
      b.text = b.lines.join('\n') + (b._trailingNl ? '\n' : '');
      delete b.lines;
    }
    // NOTE: list tightness is computed at render time, not here: a
    // list popped from the stack can gain further items later (the
    // list-start path reuses it), so finalize-time tightness is stale.
  }
  function closeTo(depth) {
    while (stack.length > depth) {
      const b = stack.pop();
      if (b.t === 'item' && b._pendingBlank) b._blankAfter = true;
      finalize(b);
    }
  }
  function closeLeaf() {
    const leaf = topLeaf();
    if (leaf) { stack.pop(); finalize(leaf); }
  }
  // Is this open paragraph a (future) table? Same test as finalize().
  function isTablePara(para) {
    if (!para || para.t !== 'para' || para.lines.length < 2) return false;
    const align = parseTableDelim(para.lines[1]);
    if (!align) return false;
    return align.length === splitTableRow(para.lines[0]).length;
  }
  // Should an HTML block (types 1-5 only; types 6-7 never call this)
  // closing on line `ln` end with a newline? Yes iff the next line, as
  // seen inside this container, is non-empty — a whitespace-only line
  // still counts (only a truly empty line, or the container closing,
  // drops it) — or the block closes on the final line and the source
  // ends with \n.
  function htmlTrailingNl(ln) {
    if (ln + 1 >= lines.length) return srcEndsWithNewline;
    const nextRest = lineMatchesContainers(lines[ln + 1]);
    return nextRest !== null && nextRest.length > 0;
  }
  function lineMatchesContainers(line) {
    let r = line;
    const lf = topLeaf();
    const tIdx = stack.length - (lf ? 1 : 0);
    for (let k = 1; k < tIdx; k++) {
      const b = stack[k];
      if (b.t === 'list') continue;
      if (b.t === 'quote') {
        const m = matchQuote(r);
        if (m === null) return null;
        r = m;
      } else if (b.t === 'item') {
        if (isBlank(r)) return r;
        const ind = indentWidth(r);
        if (ind.cols >= b._indent) r = stripCols(r, b._indent);
        else return null;
      }
    }
    return r;
  }

  for (let ln = 0; ln < lines.length; ln++) {
    let line = lines[ln];
    // Snapshot the stack + item child counts (for blank-line looseness
    // bookkeeping at end of line).
    const stackBefore = new Set(stack);
    const childCounts = new Map();
    for (const b of stack) if (b.t === 'item') childCounts.set(b, b.children.length);
    // ---- Phase 1: match open containers (outer to inner) ----
    let rest = line;
    let failAt = -1;
    const leaf = topLeaf();
    const leafIsFenced = leaf && leaf.t === 'code' && leaf.fenced;
    const topIdx = stack.length - (leaf ? 1 : 0);
    const blankItems = []; // items this blank line was seen inside
    // Fenced-code forgiveness (oracle-verified): when the open leaf is a
    // fenced code block, a line that fails a LIST ITEM's indent does not
    // close the item — it is fence content. A quote inside such an item
    // still closes if the line lacks its marker. Once a container has
    // failed, `rest` is frozen (later matches are provisional, only used
    // to detect an item failure); the fence-content path uses the rest
    // as matched up to the first failure.
    let itemFailIdx = -1;
    let quoteFailInsideItem = -1;
    let frozen = false;
    for (let k = 1; k < topIdx; k++) {
      const b = stack[k];
      if (b.t === 'list') continue;
      if (b.t === 'quote') {
        const m = matchQuote(rest);
        if (m === null) {
          if (failAt === -1) failAt = k;
          if (!leafIsFenced) break;
          if (itemFailIdx !== -1) { quoteFailInsideItem = k; break; }
          frozen = true;
          continue;
        }
        if (!frozen) rest = m;
      } else if (b.t === 'item') {
        if (isBlank(rest)) {
          // An item with no content yet cannot contain a blank line:
          // the blank line follows it (looseness) and closes it.
          if (b.children.length === 0) { b._pendingBlank = true; failAt = k; break; }
          blankItems.push(b);
          continue;
        }
        const ind = indentWidth(rest);
        if (ind.cols >= b._indent) {
          if (!frozen) rest = stripCols(rest, b._indent);
        } else {
          if (failAt === -1) failAt = k;
          if (!leafIsFenced) break;
          if (itemFailIdx === -1) itemFailIdx = k;
          frozen = true;
          continue;
        }
      }
    }
    // A blank line belongs to every item it was seen inside; the
    // end-of-line bookkeeping clears it on items whose subtree
    // continued (the blank was nested inside them, not between their
    // own blocks). Blank lines inside code blocks (or type 1-5 HTML
    // blocks) are content, not structural blanks.
    if (blankItems.length > 0) {
      const leafIsCode = leaf && leaf.t === 'code';
      const leafIsHtml15 = leaf && leaf.t === 'html' && leaf.htmlType >= 1 && leaf.htmlType <= 5;
      if (!leafIsCode && !leafIsHtml15) {
        for (const it of blankItems) it._pendingBlank = true;
      }
    }
    if (leafIsFenced && itemFailIdx !== -1) {
      // Fenced-code forgiveness: the item stays open. A quote inside
      // the failed item still closes (the fence closes with it) and
      // the line is reprocessed as new content in the item; otherwise
      // the line is fence content — Phase 2 handles it (closing check
      // + indent strip) with the rest as matched up to the failure.
      // Two exceptions (oracle-verified): when the fence has no
      // content lines yet, a dedented line ends the empty fence and
      // the item; and when the line is itself a fence line, it cannot
      // close this fence from outside the item — the fence closes
      // implicitly and the line opens a new fence at the outer level.
      // A quote failing inside a failed item also ends the item: the
      // line is outside the item (its indent failed), so closing only
      // to the quote would leave a dead item open and nest the line's
      // blocks inside it instead of placing them as siblings.
      if (quoteFailInsideItem !== -1) closeTo(failAt);
      else if (leaf.lines.length === 0 || matchFenceStart(rest)) closeTo(failAt);
    } else if (failAt !== -1) {
      // Lazy continuation? Only for an open paragraph + a line that is
      // non-blank AS SEEN INSIDE the matched containers (a '>' line
      // whose rest is blank after the outer marker ends the inner
      // paragraph — it must not lazy-continue it with an empty line),
      // and NOT a line that starts a new block: a list item, a fenced
      // code block, an ATX heading, a thematic break, or an HTML block
      // (types 1-6 can interrupt a paragraph; type 7 cannot).
      if (leaf && leaf.t === 'para' && !isBlank(rest) && !matchList(rest) &&
          !matchFenceStart(rest) && !matchATX(rest) && !matchHr(rest) &&
          !matchQuote(rest) &&
          !matchHtmlStart(rest, true)) {
        // A lazy line loses up to 4 columns of leading indent when it
        // has 4+ (the indented-code offset is consumed during matching).
        let lazyText = rest;
        if (indentWidth(rest).cols >= 4) lazyText = stripCols(rest, 4);
        // A lazy setext underline in a paragraph that already has a lazy
        // line is indented 4 spaces (marked quirk: it must not read as
        // a setext underline when the container body is re-parsed).
        if (leaf._hasLazy && matchSetext(lazyText)) lazyText = '    ' + lazyText;
        leaf._hasLazy = true;
        leaf.lines.push(expandTabs(lazyText));
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
      cur.lines.push(cur.fenceCh === '~' ? rest : stripCodeCols(rest, cur.fenceIndent));
      continue;
    }
    if (cur && cur.t === 'html') {
      if ((cur.htmlType === 6 || cur.htmlType === 7) && isBlank(rest)) {
        closeLeaf();
        // Fall through to blank-line handling below.
      } else {
        cur.lines.push(rest);
        cur._lastLine = ln;
        if (cur.htmlType >= 1 && cur.htmlType <= 5) {
          const low = rest.toLowerCase();
          if (low.indexOf(cur.htmlEnd.toLowerCase()) !== -1) {
            cur._trailingNl = htmlTrailingNl(ln);
            closeLeaf();
          }
        }
        continue;
      }
    }
    if (cur && cur.t === 'code' && !cur.fenced) {
      if (isBlank(rest)) { cur.lines.push(stripCodeCols(rest, 4)); continue; }
      const ind = indentWidth(rest);
      if (ind.cols >= 4) { cur.lines.push(stripCodeCols(rest, 4)); continue; }
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
      // anything else closes the list. A thematic break takes precedence
      // over a list item ("* * *" is an hr, not an item). Pop every
      // non-continuing list so later branches never push to a list.
      while (container.t === 'list') {
        const probe = matchList(rest);
        if (!matchHr(rest) && probe && probe.ordered === container.ordered && probe.delim === container.delim) break;
        stack.pop();
        finalize(container);
        container = stack[stack.length - 1];
      }
      if (isBlank(rest)) {
        // A line of 0-3 spaces + exactly one tab inside a table is an
        // empty row, not a blank line (marked quirk: a tab-only line
        // is a row, while space-only or multi-tab lines end the table).
        const para0 = topLeaf();
        if (para0 && para0.t === 'para' && /^ {0,3}\t$/.test(rest) && isTablePara(para0)) {
          para0.lines.push(rest);
          break;
        }
        // A line that is blank only after container markers were
        // stripped (rest is whitespace but non-empty, raw line not
        // blank) is the paragraph's last content line when nothing
        // after it continues the paragraph; otherwise it is a blank
        // line. (Item looseness is tracked in Phase 1, not here: a
        // quote-only line such as ">" must not mark its item blank.)
        if (rest !== '' && !isBlank(line) && deepestItem() === null) {
          const para = topLeaf();
          const next = ln + 1 < lines.length ? lineMatchesContainers(lines[ln + 1]) : null;
          const continues = next !== null && !isBlank(next);
          if (!continues && para && para.t === 'para') {
            para.lines.push(rest);
            closeLeaf();
            break;
          }
        }
        closeLeaf();
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
        const node = { t: 'html', lines: [rest], htmlType: html.type, htmlEnd: html.end, _lastLine: ln };
        container.children.push(node);
        stack.push(node);
        // Type 1-5 may end on the same line.
        if (html.type >= 1 && html.type <= 5) {
          const low = rest.toLowerCase();
          // For type 1, the end tag must appear after the start tag; a
          // simple indexOf can false-positive on the start tag itself
          // (e.g. <script> contains no '</script'), so plain search is ok.
          if (low.indexOf(html.end.toLowerCase()) !== -1) {
            stack.pop();
            node._trailingNl = htmlTrailingNl(ln);
            finalize(node);
          }
        }
        break;
      }
      // Setext underline (paragraph open) — but a table paragraph is
      // never a setext heading: its second line is the delimiter row
      // and later lines are table rows.
      if (paraOpen && !isTablePara(topLeaf())) {
        const se = matchSetext(rest);
        if (se) {
          const para = topLeaf();
          stack.pop();
          parseLinkRefDefs(para.lines, refs);
          if (para.lines.length === 0) {
            // The paragraph was only link reference definitions: the
            // underline is not a setext heading; reprocess this line
            // as new content (it may be an hr or a paragraph line).
            para.t = 'drop';
            continue;
          }
          para.t = 'head';
          para.level = se;
          // Setext headings shed the first line's leading spaces and
          // the last line's trailing whitespace.
          para.text = para.lines.join('\n').replace(/^ {1,3}/, '').replace(/[ \t]+$/, '');
          delete para.lines;
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
        // Inside a list item, an ordered list with any start number
        // interrupts a paragraph (marked re-lexes item content, so the
        // start==1 rule does not apply there). A blockquote between
        // the item and the paragraph restores the top-level rule.
        let inItemPara = false;
        for (let k = stack.length - 1; k >= 1; k--) {
          const b = stack[k];
          if (b.t === 'quote') break;
          if (b.t === 'item') { inItemPara = true; break; }
        }
        const canInterrupt = !li.empty && (!paraOpen || !li.ordered || li.start === 1 || inItemPara);
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
          // NOTE: an empty item does NOT make the list loose (oracle:
          // "* a\n*\n* c" renders tight); no looseness bookkeeping here.
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
          const node = { t: 'code', fenced: false, lines: [stripCodeCols(rest, 4)] };
          container.children.push(node);
          stack.push(node);
          break;
        }
      }
      // Paragraph (new or continued)
      if (paraOpen) {
        // Inside a list item, a continuation line with 4+ columns of
        // indent loses 4 (the indented-code offset is consumed during
        // matching); at top level or in a quote it keeps its indent.
        let text = rest;
        if (deepestItem() !== null && indentWidth(rest).cols >= 4) {
          text = stripCols(rest, 4);
        }
        topLeaf().lines.push(text);
      } else {
        const node = { t: 'para', lines: [rest] };
        container.children.push(node);
        stack.push(node);
      }
      break;
    }
    // Blank-line looseness bookkeeping for every open item with a
    // pending blank:
    // - it gained a direct child this line (and had one before): the
    //   blank was between two of its blocks -> blankBetween;
    // - a new node appeared deeper than it (inside its subtree): the
    //   blank was nested inside, not between its own blocks -> clear;
    // - otherwise the blank is still pending (it becomes blankAfter
    //   if the item closes without further content).
    for (let si = 0; si < stack.length; si++) {
      const b = stack[si];
      if (b.t !== 'item' || !b._pendingBlank) continue;
      const before = childCounts.get(b);
      if (before !== undefined && b.children.length > before) {
        if (before >= 1) b._blankBetween = true;
        b._pendingBlank = false;
        continue;
      }
      let nested = false;
      for (let k = si + 1; k < stack.length; k++) {
        if (!stackBefore.has(stack[k])) { nested = true; break; }
      }
      if (nested) b._pendingBlank = false;
    }
  }
  // Close everything (at end of input).
  closingAtEof = true;
  while (stack.length > 1) {
    const b = stack.pop();
    // An item closing with a pending blank: it had a blank line after its
    // content. Only matters if it is not the last item; finalize() for
    // the list checks _blankAfter on non-last items, so set it here.
    if (b.t === 'item' && b._pendingBlank) b._blankAfter = true;
    // An HTML block running to EOF ends with a newline iff the source does.
    if (b.t === 'html') b._trailingNl = srcEndsWithNewline;
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
  // Open tag: strict CommonMark grammar (attribute names/values must
  // be well-formed; quoted values may contain < and >).
  m = rest.match(/^<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*('[^']*'|"[^"]*"|[^\s"'=<>`]+))?)*\s*\/?>/);
  if (m) return m[0];
  // Close tag: no attributes allowed.
  m = rest.match(/^<\/[A-Za-z][A-Za-z0-9-]*\s*>/);
  if (m) return m[0];
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
// Scan a domain starting at s[i]. Labels are [A-Za-z0-9_-]+ (a label may
// start with '-'; it may start with '_' only when allowUnderscoreStart,
// i.e. email domains — www/scheme hosts reject a leading '_'). A '.' is
// a separator only when followed by a label char, so a trailing '.'
// ends the domain. requireDot: at least one '.' must be consumed (email
// only — www and :// hosts need no dot). No TLD rule. Returns the end
// index (exclusive), or -1 if invalid.
function scanDomain(s, i, requireDot, allowUnderscoreStart) {
  const first = s[i];
  if (first === undefined) return -1;
  const isLabelCh = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '_';
  if (!isLabelCh(first) || (first === '_' && !allowUnderscoreStart)) return -1;
  let j = i;
  let dots = 0;
  while (j < s.length) {
    const c = s[j];
    if (isLabelCh(c)) { j++; continue; }
    if (c === '.' && j + 1 < s.length && isLabelCh(s[j + 1])) { dots++; j++; continue; }
    break;
  }
  if (j === i) return -1;
  if (requireDot && dots < 1) return -1;
  return j;
}
// Scan an email address starting at s[i] (local-part start). Returns the
// end index (exclusive) or -1. The domain needs a dot and must not end
// with '-' or '_'. When trimUnderscore is set (an unmatched '_' opener
// exists earlier, so a trailing '_' run is an emphasis closer, not
// domain text), trailing '_'s are trimmed from the domain instead of
// rejecting the email — but only if the run can close.
function scanEmail(s, i, trimUnderscore) {
  let j = i;
  while (j < s.length && EMAIL_LOCAL.test(s[j])) j++;
  if (j >= s.length || s[j] !== '@') return -1;
  const local = s.slice(i, j);
  if (local.length === 0 || local.startsWith('.') || local.endsWith('.') || local.indexOf('..') !== -1) return -1;
  let domEnd = scanDomain(s, j + 1, true, true);
  if (domEnd === -1) return -1;
  const last = s[domEnd - 1];
  if (last === '-') return -1;
  if (last === '_') {
    if (!trimUnderscore) return -1;
    // Trim the trailing '_' run if it can close as emphasis.
    let runStart = domEnd;
    while (runStart > j + 1 && s[runStart - 1] === '_') runStart--;
    const prev = s[runStart - 1];
    const next = domEnd >= s.length ? undefined : s[domEnd];
    const prevSpace = isUniSpace(prev);
    const nextSpace = isUniSpace(next);
    const prevPunct = isUniPunct(prev);
    const nextPunct = isUniPunct(next);
    const leftFlanking = !nextSpace && (!nextPunct || prevSpace || prevPunct);
    const rightFlanking = !prevSpace && (!prevPunct || nextSpace || nextPunct);
    const canClose = rightFlanking && (!leftFlanking || nextPunct);
    if (!canClose) return -1;
    domEnd = runStart;
    const last2 = s[domEnd - 1];
    if (last2 === undefined || last2 === '-' || last2 === '_' || last2 === '.') return -1;
  }
  return domEnd;
}
// Scan an xmpp path segment starting at s[i] (after the '/'). Segment
// chars are [A-Za-z0-9@]; '.' is included only when followed by a segment
// char. Returns the end index (== i if empty).
function scanXmppSegment(s, i) {
  let j = i;
  const isSeg = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '@';
  while (j < s.length) {
    const c = s[j];
    if (isSeg(c)) { j++; continue; }
    if (c === '.' && j + 1 < s.length && isSeg(s[j + 1])) { j++; continue; }
    break;
  }
  return j;
}
// Scan an extended-autolink path starting at s[i] (after the domain).
// Stops at whitespace/'<'; a ']' ends the path if hasActiveBracket,
// otherwise it is included and the paren rules apply only after the last
// ']'. stripStart is the lower bound for the trailing-punctuation strip
// (the domain start — a trailing '_' on the domain itself is stripped).
// Paren rules (oracle-verified): (a) cut at the first '(' with no ')'
// anywhere after it in the segment; (b) after the last '(' at most one
// ')' may remain — drop excess TRAILING ')'s (none if no '(' at all);
// a ')' in the middle of the path is always kept. A trailing
// entity-like &name; (alphanumeric body) is excluded whole; a ';' that
// is not part of one is stripped alone. Returns the end index.
function scanAutolinkPath(s, i, hasActiveBracket, stripStart) {
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
  // Paren rules, applied to the segment after the last ']'.
  const segStart = lastBracket === -1 ? i : lastBracket + 1;
  // (a) Cut at the first '(' with no ')' after it in the segment.
  let lastClose = -1;
  for (let k = end - 1; k >= segStart; k--) {
    if (s[k] === ')') { lastClose = k; break; }
  }
  if (lastClose === -1) {
    for (let k = segStart; k < end; k++) {
      if (s[k] === '(') { end = k; break; }
    }
  } else {
    for (let k = lastClose; k < end; k++) {
      if (s[k] === '(') { end = k; break; }
    }
  }
  // (b) and (c) interact: stripping trailing punctuation can reveal a
  // trailing ')', so repeat both until the end stops moving.
  let prevEnd = -1;
  while (prevEnd !== end) {
    prevEnd = end;
  // (b) Trailing ')': after the last '(' at most one ')' may remain.
  let lastOpen = -1;
  for (let k = end - 1; k >= segStart; k--) {
    if (s[k] === '(') { lastOpen = k; break; }
  }
  let closesAfter = 0;
  for (let k = (lastOpen === -1 ? segStart : lastOpen + 1); k < end; k++) {
    if (s[k] === ')') closesAfter++;
  }
  let excess = closesAfter - (lastOpen === -1 ? 0 : 1);
  while (excess > 0 && end > segStart && s[end - 1] === ')') { end--; excess--; }
  // (c) Strip trailing punctuation: ? ! . , : * _ ~ ; — a trailing
  // entity-like &name; is excluded whole.
  while (end > stripStart) {
    const c = s[end - 1];
    if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':' || c === '*' || c === '_' || c === '~') { end--; continue; }
    if (c === ';') {
      const amp = s.lastIndexOf('&', end - 1);
      if (amp !== -1 && amp >= stripStart && /^[A-Za-z0-9]+$/.test(s.slice(amp + 1, end - 1))) {
        end = amp;
        continue;
      }
      end--;
      continue;
    }
    break;
  }
  }
  return end;
}

// Try to match an extended autolink at s[i]. Schemes first (no
// preceding-char restriction): http://, https://, ftp:// are
// case-insensitive; mailto: and xmpp: are lowercase-only. Then www.
// (preceded by start/whitespace/punct, not '.'), then a bare email
// (alnum at a word start). Returns {dest, text, len} or null.
function matchExtendedAutolink(s, i, hasActiveBracket, trimEmailUnderscore) {
  // :// schemes.
  const low = s.slice(i, i + 8).toLowerCase();
  let urlSchemeLen = 0;
  if (low.startsWith('https://')) urlSchemeLen = 8;
  else if (low.startsWith('http://')) urlSchemeLen = 7;
  else if (low.startsWith('ftp://')) urlSchemeLen = 6;
  if (urlSchemeLen > 0) {
    const after = i + urlSchemeLen;
    const hostEnd = scanDomain(s, after, false, false);
    if (hostEnd !== -1) {
      const pathEnd = scanAutolinkPath(s, hostEnd, hasActiveBracket, after);
      const text = s.slice(i, pathEnd);
      return { dest: text, text, len: pathEnd - i };
    }
    return null;
  }
  // mailto: (no path) / xmpp: (at most one path segment).
  if (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) {
    const isXmpp = s[i] === 'x';
    const after = i + (isXmpp ? 5 : 7);
    const emEnd = scanEmail(s, after, trimEmailUnderscore);
    if (emEnd !== -1) {
      let end = emEnd;
      if (isXmpp && s[end] === '/') {
        const segEnd = scanXmppSegment(s, end + 1);
        if (segEnd > end + 1) end = segEnd;
      }
      const text = s.slice(i, end);
      return { dest: text, text, len: end - i };
    }
    return null;
  }
  // www. — must be preceded by start/whitespace/punct (not alnum or '.').
  if (s.startsWith('www.', i)) {
    const prev = i === 0 ? undefined : s[i - 1];
    if (prev === undefined || isUniSpace(prev) || (isUniPunct(prev) && prev !== '.')) {
      const domEnd = scanDomain(s, i + 4, false, false);
      if (domEnd !== -1) {
        const pathEnd = scanAutolinkPath(s, domEnd, hasActiveBracket, i + 4);
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
  const emEnd = scanEmail(s, i, trimEmailUnderscore);
  if (emEnd === -1) return null;
  const text = s.slice(i, emEnd);
  return { dest: 'mailto:' + text, text, len: emEnd - i };
}

// Emphasis resolution over nodes[startIdx..endIdx) using delims (entries
// whose nodes lie in that range). Mutates nodes/delims in place.
function processEmphasis(nodes, delims, startIdx, endIdx) {
  // Build the list of closer entries in range, in node order.
  const inRange = d => {
    const idx = nodes.indexOf(d.node);
    return idx >= startIdx && idx < endIdx;
  };
  // Consumed pairs from matches made in this pass: {oNode, cNode,
  // oCanClose, cCanOpen, cOrigLen, ch, use}. A consumed pair blocks a later
  // single-use match spanning it when its opener cannot close, its
  // closer can open, and (its closer's original length is >= 2, or the
  // prospective sum is a multiple of 3 with the closer no longer than
  // the consumed closer's original length).
  const consumed = [];
  // Leftover-inside / exact-block rule (oracle-probed, '*' only): when a
  // consumed same-char EM pair (use 1) sits strictly between a strong
  // opener and closer, and the consumed closer can open, then a closer
  // run with leftovers renders them INSIDE the strong. The exact-block
  // half additionally requires the consumed opener to be unable to
  // close (cm-429 `**foo*bar*baz**` forms strong; M17 `**a *b*c**`
  // does not): a closer run exactly consumed by the strong (len == 2)
  // does not match at all.
  const insideRuleApplies = (opener, closer, oIdx, cIdx) => {
    if (closer.ch !== '*') return false;
    for (const p of consumed) {
      if (p.ch !== '*' || p.use !== 1) continue;
      if (!p.cCanOpen) continue;
      const oi = nodes.indexOf(p.oNode);
      const ci = nodes.indexOf(p.cNode);
      if (oi > oIdx && oi < cIdx && ci > oIdx && ci < cIdx) return true;
    }
    return false;
  };
  const exactBlockApplies = (opener, closer, oIdx, cIdx) => {
    if (closer.ch !== '*') return false;
    for (const p of consumed) {
      if (p.ch !== '*' || p.use !== 1) continue;
      if (p.oCanClose || !p.cCanOpen) continue;
      const oi = nodes.indexOf(p.oNode);
      const ci = nodes.indexOf(p.cNode);
      if (!(oi > oIdx && oi < cIdx && ci > oIdx && ci < cIdx)) continue;
      // Lifted if a live closer-only '*' delimiter sits between the
      // pair's closer and the prospective closer (oracle-probed:
      // doc-01/26 `*so*other* option` forms strong; a canOpen
      // delimiter between does not lift it).
      let lifted = false;
      for (const d of delims) {
        if (d.ch !== '*' || d.canOpen || d.len <= 0) continue;
        const di = nodes.indexOf(d.node);
        if (di > ci && di < cIdx) { lifted = true; break; }
      }
      if (!lifted) return true;
    }
    return false;
  };
  const pairBlocks = (opener, closer, oIdx, cIdx, sum) => {
    const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
    if (use !== 1) return false;
    for (const p of consumed) {
      if (p.ch !== closer.ch) continue;
      if (p.oCanClose || !p.cCanOpen) continue;
      const oi = nodes.indexOf(p.oNode);
      const ci = nodes.indexOf(p.cNode);
      if (oi > oIdx && oi < cIdx && ci > oIdx && ci < cIdx) {
        if (p.cOrigLen >= 2) return true;
        if (sum % 3 === 0 && closer.len <= p.cOrigLen) return true;
      }
    }
    return false;
  };
  // Iterate closers by position; re-scan after each pass since wrapping
  // changes indices. Use a work list of closer entries sorted by position.
  let closers = delims.filter(d => d.canClose && d.len > 0 && !d.suppressed && inRange(d));
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
      // '~' delimiters only match equal lengths.
      for (let k = delims.length - 1; k >= 0; k--) {
        const d = delims[k];
        if (d === closer || d.ch !== closer.ch || !d.canOpen || d.len <= 0 || d.suppressed) continue;
        if (d.ch === '~' && d.len !== closer.len) continue;
        const di = nodes.indexOf(d.node);
        if (di < startIdx || di >= cIdx) continue;
        opener = d;
        oIdx = di;
        break;
      }
      if (!opener) break;
      // Odd-match rule (+ consumed-pair rule): if the sum of the
      // lengths is a multiple of 3 and EITHER delimiter can both open
      // and close, the pair must not match (unless both lengths are
      // multiples of 3).
      let blocked = false;
      const sum = opener.len + closer.len;
      const bothMult3 = opener.len % 3 === 0 && closer.len % 3 === 0;
      if ((closer.canOpen || opener.canClose) && sum % 3 === 0 && !bothMult3) blocked = true;
      if (!blocked && pairBlocks(opener, closer, oIdx, cIdx, sum)) blocked = true;
      if (!blocked) {
        const use0 = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
        if (use0 === 2 && closer.ch === '*' && closer.len === 2 && exactBlockApplies(opener, closer, oIdx, cIdx)) blocked = true;
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
          if (d === closer || d.ch !== closer.ch || !d.canOpen || d.len <= 0 || d.suppressed) continue;
          if (d.ch === '~' && d.len !== closer.len) continue;
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
        if ((closer.canOpen || opener.canClose) && sum2 % 3 === 0 && !both2) {
          closer._skip.add(opener);
          continue;
        }
        if (pairBlocks(opener, closer, oIdx, cIdx, sum2)) { closer._skip.add(opener); continue; }
        {
          const use2 = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
          if (use2 === 2 && closer.ch === '*' && closer.len === 2 && exactBlockApplies(opener, closer, oIdx, cIdx)) { closer._skip.add(opener); continue; }
        }
      }
      // Match: use 2 if both have >= 2, else 1. '~' always makes <del>.
      const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      const kind = opener.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      // Record the consumed pair (original closer length + flanking).
      consumed.push({ oNode: opener.node, cNode: closer.node, oCanClose: opener.canClose, cCanOpen: closer.canOpen, cOrigLen: closer.len, ch: closer.ch, use });
      opener.len -= use;
      closer.len -= use;
      // Sync the node lengths: the renderer prints node.len chars.
      opener.node.len = opener.len;
      closer.node.len = closer.len;
      // Wrap nodes between opener and closer.
      const children = nodes.slice(oIdx + 1, cIdx);
      const emNode = { t: kind, children };
      // Leftover-inside rule: a strong closer's leftover delimiters
      // render INSIDE the strong when the inside rule applies; the
      // leftover then takes no further part in matching.
      if (kind === 'strong' && closer.ch === '*' && closer.len > 0 && insideRuleApplies(opener, closer, oIdx, cIdx)) {
        emNode.children.push({ t: 'text', s: closer.ch.repeat(closer.len) });
        closer.len = 0;
        closer.node.len = 0;
      }
      nodes.splice(oIdx + 1, cIdx - oIdx - 1, emNode);
      // Continue: the closer may match another opener.
    }
  }
}

// Remove extended-autolink nodes from a node list (marked never
// creates them inside a link label); each is replaced by its text
// children. Recurses into em/strong/del/link/image children.
function unlinkExtended(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t === 'link' && nd.ext) {
      const m = nd.children.length;
      nodes.splice(k, 1, ...nd.children);
      k += m - 1;
    } else if (nd.children) {
      unlinkExtended(nd.children);
    }
  }
}

// Try to match an image starting at s[i] === '!['. Scans the label with
// nesting-aware bracket counting (so the OUTERMOST image wins — inner
// ']'s must not claim the brackets first), then parses an inline,
// full/collapsed, or shortcut tail. Returns {label, dest, title, next}
// or null (caller falls back to the bracket mechanism).
function matchImage(s, i, refs) {
  let j = i + 2;
  let depth = 0;
  let close = -1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { j += 2; continue; }
    if (c === '[') { depth++; j++; continue; }
    if (c === ']') {
      if (depth === 0) { close = j; break; }
      depth--; j++; continue;
    }
    j++;
    if (j - i > 1000) return null;
  }
  if (close === -1) return null;
  const label = s.slice(i + 2, close);
  if (!labelBackticksValid(label)) return null; // H3: fall back to brackets
  const next = close + 1;
  // Inline tail: (dest "title")
  if (s[next] === '(') {
    let p = next + 1;
    while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
    let dest = null;
    let title = null;
    const dRes = parseLinkDest(s, p);
    if (dRes) { dest = dRes[0]; p = dRes[1]; }
    else if (p < s.length && (s[p] === ')' || s[p] === '"' || s[p] === "'" || s[p] === '(')) dest = '';
    if (dest !== null) {
      let t = p;
      while (t < s.length && (s[t] === ' ' || s[t] === '\t' || s[t] === '\n')) t++;
      if (t < s.length && (s[t] === '"' || s[t] === "'" || s[t] === '(')) {
        const tRes = parseLinkTitle(s, t);
        if (tRes) { title = tRes[0]; t = tRes[1]; }
      }
      while (t < s.length && (s[t] === ' ' || s[t] === '\t' || s[t] === '\n')) t++;
      if (t < s.length && s[t] === ')') return { label, dest, title, next: t + 1, inline: true };
    }
    // Failed inline: fall back to a shortcut reference.
    const ref = refs[normalizeLabel(label)];
    if (ref) return { label, dest: ref.dest, title: ref.title, next: close + 1 };
    return null;
  }
  // Full / collapsed reference tail.
  if (s[next] === '[') {
    const lab = parseLinkLabel(s, next);
    if (lab) {
      const ref = refs[normalizeLabel(lab[0] === '' ? label : lab[0])];
      if (ref) return { label, dest: ref.dest, title: ref.title, next: lab[1] };
    }
    return null;
  }
  // Shortcut reference.
  const ref = refs[normalizeLabel(label)];
  if (ref) return { label, dest: ref.dest, title: ref.title, next: close + 1 };
  return null;
}

// Parse inline content into a node list, then render to HTML.
// `st` is the shared renderer state ({inAnchor}): an unclosed inline
// <a> suppresses extended autolinks in ALL following blocks, not just
// the current one (marked behaviour — the state is threaded through
// the renderer in document order).
function parseInline(src, refs, st) {
  const s = src;
  const nodes = [];
  const delims = [];
  const brackets = []; // {nodeIdx, active, image, srcStart}
  let buf = '';
  // Counts of '_' openers/closers seen so far (for the email trim:
  // more openers than closers means an unmatched '_' opener exists,
  // so a trailing '_' run after an email domain is an emphasis closer).
  let uOpen = 0;
  let uClose = 0;
  st = st || { inAnchor: false };
  const flush = () => { if (buf.length > 0) { nodes.push({ t: 'text', s: buf }); buf = ''; } };
  // Backtick-label emphasis suppression (oracle-probed): once an INLINE
  // link/image forms whose label holds >= 2 backtick runs that don't pair
  // into a code span, emphasis after it in this paragraph stays literal —
  // but only pairs with a backtick after the closer (a backtick between
  // opener and closer does not suppress, so only closers are marked; a
  // suppressed closer kills its pair). Ref links never trigger.
  let btTriggerAt = -1; // source index just past the first trigger link
  let lastBtCache = null; // last unescaped backtick in this paragraph
  const applyBtSuppression = () => {
    if (btTriggerAt === -1) return;
    if (lastBtCache === null) {
      let lastBt = -1;
      for (let k = s.length - 1; k >= 0; k--) {
        if (s[k] === '`') {
          let bs = 0;
          for (let q = k - 1; q >= 0 && s[q] === '\\'; q--) bs++;
          if (bs % 2 === 0) { lastBt = k; break; }
        }
      }
      lastBtCache = lastBt;
    }
    if (lastBtCache === -1) return;
    for (const d of delims) {
      if (!d.suppressed && d.canClose && (d.ch === '*' || d.ch === '_') && d.pos >= btTriggerAt && d.pos < lastBtCache) {
        d.suppressed = true;
      }
    }
  };

  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    // Backslash escapes / hard break.
    if (c === '\\' && i + 1 < n) {
      const nx = s[i + 1];
      if (nx === '\n') {
        flush();
        nodes.push({ t: 'br' });
        i += 2;
        // A hard break skips leading spaces/tabs on the next line.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      }
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
      if (found !== -1 && brackets.length > 0) {
        // A code span must not swallow a ']' that closes an H3-valid
        // link label (marked matches the link first). A span may still
        // contain '](u)' when the label it would close is H3-invalid.
        for (let q = j; q < found; q++) {
          if (s[q] !== ']') continue;
          let br = null;
          for (let b = brackets.length - 1; b >= 0; b--) {
            if (brackets[b].active && brackets[b].srcStart < i) { br = brackets[b]; break; }
          }
          if (!br) break;
          const lab = s.slice(br.srcStart + 1, q);
          if (labelBackticksValid(lab) && linkTailAfter(s, q + 1, lab, refs)) { found = -1; break; }
        }
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
        if (/^<a(\s|\/?>)/.test(low)) st.inAnchor = true;
        else if (/^<\/a(\s|>)/.test(low)) st.inAnchor = false;
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
      // Greedy image pre-pass: match the OUTERMOST image first.
      const img = matchImage(s, i, refs);
      if (img) {
        flush();
        nodes.push({ t: 'image', dest: img.dest, title: img.title, children: parseInline(img.label, refs, st) });
        if (img.inline && btTriggerAt === -1 && countUnmatchedBacktickRuns(img.label) >= 2) btTriggerAt = img.next;
        i = img.next;
        continue;
      }
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
      const labelText = s.slice(br.srcStart + 1, i);
      const h3Valid = labelBackticksValid(labelText);
      // Parse the tail.
      let dest = null;
      let title = null;
      let next = i + 1;
      let formed = false;
      let inlineTail = false; // a syntactically valid inline (dest) tail
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
          if (t < n && s[t] === ')') { formed = true; next = t + 1; inlineTail = true; }
        }
        if (!formed) {
          // A failed inline link falls back to a shortcut reference.
          const label = s.slice(br.srcStart + 1, i);
          const ref = refs[normalizeLabel(label)];
          if (ref) { dest = ref.dest; title = ref.title; formed = true; next = i + 1; }
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
      if (formed && !h3Valid) formed = false; // H3-invalid label: no link
      if (!formed && inlineTail && !h3Valid) {
        // H3-invalid label with a valid inline tail: emphasis inside
        // the label is suppressed (oracle-probed; ref/no tails don't
        // suppress). Mark the label's delimiters; processEmphasis
        // skips suppressed entries.
        for (const d of delims) {
          if (nodes.indexOf(d.node) > bNodeIdx) d.suppressed = true;
        }
      }
      if (formed) {
        flush(); // the link text may still be buffered; it belongs in the nodes
        // Resolve emphasis inside the link text first (applying any
        // backtick-label suppression from an earlier trigger link).
        applyBtSuppression();
        processEmphasis(nodes, delims, bNodeIdx + 1, nodes.length);
        const children = nodes.splice(bNodeIdx, nodes.length - bNodeIdx);
        children.shift(); // remove the bracket node
        // Extended autolinks never survive inside a link label.
        unlinkExtended(children);
        if (br.image) {
          nodes.push({ t: 'image', dest, title, children });
        } else {
          nodes.push({ t: 'link', dest, title, children });
          // A link deactivates all earlier brackets (no nested links).
          for (let b = 0; b < bi; b++) brackets[b].active = false;
        }
        if (inlineTail && btTriggerAt === -1 && countUnmatchedBacktickRuns(labelText) >= 2) btTriggerAt = next;
        brackets.splice(bi, 1);
        i = next;
        continue;
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
      delims.push({ node, ch: c, len, canOpen, canClose, pos: i });
      if (c === '_') { if (canOpen) uOpen++; if (canClose) uClose++; }
      i = j;
      continue;
    }
    // Strikethrough delimiters: runs of 1 or 2 '~' (runs of 3+ are
    // literal). Single '~' also makes <del>; pairs must be equal length
    // (enforced in processEmphasis).
    if (c === '~') {
      let j = i;
      while (j < n && s[j] === '~') j++;
      const len = j - i;
      if (len === 1 || len === 2) {
        const prev = i === 0 ? undefined : s[i - 1];
        const nextCh = j >= n ? undefined : s[j];
        const prevSpace = isUniSpace(prev);
        const nextSpace = isUniSpace(nextCh);
        const prevPunct = isUniPunct(prev);
        const nextPunct = isUniPunct(nextCh);
        const leftFlanking = !nextSpace && (!nextPunct || prevSpace || prevPunct);
        const rightFlanking = !prevSpace && (!prevPunct || nextSpace || nextPunct);
        flush();
        const node = { t: 'delim', ch: '~', len, canOpen: leftFlanking, canClose: rightFlanking };
        nodes.push(node);
        delims.push({ node, ch: '~', len, canOpen: leftFlanking, canClose: rightFlanking });
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
      if (hard) {
        nodes.push({ t: 'br' });
        i++;
        // A hard break skips leading spaces/tabs on the next line.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }
    // Extended autolinks (suppressed inside an unclosed <a>).
    if (!st.inAnchor && (c === 'w' || ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')))) {
      const hasActiveBracket = brackets.some(b => b.active);
      const ea = matchExtendedAutolink(s, i, hasActiveBracket, uOpen > uClose);
      if (ea) {
        flush();
        nodes.push({ t: 'link', dest: ea.dest, title: null, children: textNodesWithEntities(ea.text), ext: true });
        i += ea.len;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  // Resolve emphasis over the whole node list.
  applyBtSuppression();
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
function renderItem(item, tight, refs, st) {
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
    out += taskHtml + renderInline(parseInline(text, refs, st));
  } else {
    for (let k = 0; k < kids.length; k++) {
      const child = kids[k];
      if (k === 0 && child.t === 'para' && taskRest !== null) {
        if (tight) {
          out += taskHtml + renderInline(parseInline(taskRest, refs, st));
        } else {
          out += '<p>' + taskHtml + renderInline(parseInline(taskRest, refs, st)) + '</p>\n';
        }
      } else if (child.t === 'para' && tight) {
        // Tight list: paragraph children render bare, no <p> wrapper
        // and no trailing newline (even with several blocks in the item).
        out += renderInline(parseInline(child.lines.join('\n'), refs, st));
      } else {
        out += renderBlock(child, refs, st);
      }
    }
  }
  out += '</li>\n';
  return out;
}

function renderBlock(node, refs, st) {
  switch (node.t) {
    case 'para':
      return '<p>' + renderInline(parseInline(node.lines.join('\n'), refs, st)) + '</p>\n';
    case 'head':
      return '<h' + node.level + '>' + renderInline(parseInline(node.text, refs, st)) + '</h' + node.level + '>\n';
    case 'code': {
      let cls = '';
      if (node.info) {
        // Backslash escapes in the info string are processed.
        const first = node.info.split(/[ \t]/)[0].replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
        if (first) cls = ' class="language-' + escAttr(first) + '"';
      }
      return '<pre><code' + cls + '>' + escText(node.text) + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'quote':
      return '<blockquote>\n' + node.children.map(c => renderBlock(c, refs, st)).join('') + '</blockquote>\n';
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      // Tightness is computed here (all items are known by now): loose
      // if any item has a blank between its blocks, or a non-last item
      // is followed by a blank line.
      let tight = true;
      for (let k = 0; k < node.items.length; k++) {
        const it = node.items[k];
        if (it._blankBetween) { tight = false; break; }
        if (it._blankAfter && k < node.items.length - 1) { tight = false; break; }
      }
      let out = '<' + tag + start + '>\n';
      for (const it of node.items) out += renderItem(it, tight, refs, st);
      out += '</' + tag + '>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < node.header.length; k++) {
        const a = node.align[k];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInline(node.header[k], refs, st)) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let k = 0; k < row.length; k++) {
            const a = node.align[k];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInline(row[k], refs, st)) + '</td>\n';
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
  const st = { inAnchor: false };
  let out = '';
  for (const c of doc.children) out += renderBlock(c, refs, st);
  return out;
}
