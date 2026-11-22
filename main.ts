// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// The four formats are unified diffs, SEARCH/REPLACE blocks, V4A patches and
// JSON edits. Every edit of a patch applies to the tree as earlier edits
// left it; when any edit fails nothing is written. When MAKEFUN_ENV_URL is
// set, the run is a trial: the checks are fetched from the env, main.ts is
// run on each one, and the results are posted back (runner.ts).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

class ParseError extends Error {
  constructor(line) {
    super(`error: parse ${line}`);
    this.line = line;
  }
}

class EditError extends Error {
  constructor(code, path) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

// ---------- small utilities ----------

function writeStdout(text) {
  if (text.length > 0) writeFileSync(1, text, 'utf8');
}

function isBlank(s) {
  return s.trim() === '';
}

function stripOneCR(s) {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

// A patch's lines: its text split at \n, each with one trailing \r removed,
// without the empty piece after a final \n.
function splitPatchLines(text) {
  const parts = text.split('\n').map(stripOneCR);
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

// A new_str's lines (JSON insert): the same split, but an empty new_str
// has no lines at all.
function splitNewStrLines(text) {
  if (text === '') return [];
  return splitPatchLines(text);
}

function leadingWS(s) {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function trimEndWS(s) {
  return s.replace(/[ \t]+$/, '');
}

function trimWS(s) {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function isSafePath(p) {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function checkSafe(p) {
  if (!isSafePath(p)) throw new EditError('unsafe', p);
}

function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function resolveRel(p) {
  if (p.startsWith('/')) return p;
  return join(process.cwd(), ...p.split('/'));
}

// ---------- files: lines and breaks ----------

class Doc {
  constructor(text) {
    this.text = text;
    if (text === '') {
      this.brk = '\n';
      this.lines = [];
      this.trail = false;
      return;
    }
    const firstNl = text.indexOf('\n');
    this.brk = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
    const parts = text.split(this.brk);
    if (text.endsWith(this.brk)) {
      parts.pop();
      this.trail = true;
    } else {
      this.trail = false;
    }
    this.lines = parts;
  }

  toString() {
    if (this.lines.length === 0) return '';
    return this.lines.join(this.brk) + (this.trail ? this.brk : '');
  }
}

// The tree: before holds every touched path as it was when the patch
// started, after holds it as the edits leave it. Nothing reaches the disk
// until every edit has succeeded.
class Tree {
  constructor() {
    this.before = new Map();
    this.after = new Map();
  }

  load(p) {
    let text = null;
    try {
      text = readFileSync(resolveRel(p), 'utf8');
    } catch (err) {
      // A path that cannot be read is missing; anything else (a directory,
      // say) counts as present but with no lines to match.
      if (err.code !== 'ENOENT') text = '';
    }
    this.before.set(p, text);
    this.after.set(p, text);
  }

  beforeText(p) {
    if (!this.before.has(p)) this.load(p);
    const v = this.before.get(p);
    return v === undefined ? null : v;
  }

  get(p) {
    if (!this.after.has(p)) this.load(p);
    const v = this.after.get(p);
    return v === undefined ? null : v;
  }

  exists(p) {
    return this.get(p) !== null;
  }

  set(p, text) {
    this.after.set(p, text);
  }

  // The change lines for exit 0, in byte order of the paths (UTF-8). A move
  // that succeeded prints one R line (sorted by its new path) instead of the
  // D and A lines for its two paths.
  changes(movePairs) {
    const entries = [];
    const covered = new Set();
    for (const [oldP, newP] of movePairs) {
      if (
        this.beforeText(oldP) !== null && this.get(oldP) === null
        && this.beforeText(newP) === null && this.get(newP) !== null
      ) {
        entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
        covered.add(oldP);
        covered.add(newP);
      }
    }
    const paths = new Set([...this.before.keys(), ...this.after.keys()]);
    for (const p of paths) {
      if (covered.has(p)) continue;
      const b = this.beforeText(p);
      const a = this.get(p);
      if (b === null && a !== null) entries.push({ key: p, line: `A ${p}` });
      else if (b !== null && a === null) entries.push({ key: p, line: `D ${p}` });
      else if (b !== null && a !== null && b !== a) entries.push({ key: p, line: `M ${p}` });
    }
    entries.sort((x, y) => byteCompare(x.key, y.key));
    return entries.map((e) => e.line);
  }

  write() {
    for (const p of this.after.keys()) {
      const b = this.beforeText(p);
      const a = this.get(p);
      if (b === a) continue;
      const full = resolveRel(p);
      if (a === null) {
        try {
          rmSync(full);
        } catch {
          // Already gone.
        }
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, a, 'utf8');
      }
    }
  }
}

// ---------- matching lines (SPEC section 5) ----------

function lineMatchesAtTier(fileLine, patLine, tier) {
  if (tier === 0) return fileLine === patLine;
  if (tier === 1) return trimEndWS(fileLine) === trimEndWS(patLine);
  return trimWS(fileLine) === trimWS(patLine);
}

// The first tier (of the given tiers, in order) at which O occurs at least
// once at or after `from`, with every occurrence position at that tier.
function occurrencesFrom(lines, O, from, tiers) {
  for (const tier of tiers) {
    const positions = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      let ok = true;
      for (let k = 0; k < O.length; k++) {
        if (!lineMatchesAtTier(lines[i + k], O[k], tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// Build the lines that replace a match. A context line is written as the
// file's own matched line, never the patch's. At tier 2 every other new
// line is re-indented: F is the leading spaces and tabs of the file's first
// matched line, P those of O's first line; a new line that is not empty,
// not only whitespace, and starts with P has that P replaced by F.
function buildNewLines(fileLines, pos, O, N, tier) {
  const out = [];
  const F = O.length > 0 ? leadingWS(fileLines[pos]) : '';
  const P = O.length > 0 ? leadingWS(O[0]) : '';
  for (const nl of N) {
    if (nl.ctx) {
      out.push(fileLines[pos + nl.oIdx]);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) {
      t = F + t.slice(P.length);
    }
    out.push(t);
  }
  return out;
}

function tiersFor(strict) {
  return strict ? [0] : [0, 1, 2];
}

function freshDoc(doc, lines, trail) {
  const out = new Doc('');
  out.brk = doc.brk;
  out.lines = lines;
  out.trail = trail;
  return out;
}

// ---------- unified diffs (SPEC section 6) ----------

function parseUnified(lines) {
  const sections = [];
  let cur = null;

  const startSection = (gitOld, gitNew) => {
    if (cur !== null) sections.push(cur);
    cur = {
      gitOld,
      gitNew,
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
  };

  const parseDiffGit = (line, lineNo) => {
    const rest = line.slice('diff --git '.length);
    if (!rest.startsWith('a/')) throw new ParseError(lineNo);
    const idx = rest.indexOf(' b/');
    if (idx < 0) throw new ParseError(lineNo);
    const x = rest.slice(2, idx);
    const y = rest.slice(idx + 3);
    if (x === '' || y === '') throw new ParseError(lineNo);
    return [x, y];
  };

  const hunkHeader = (line) => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m === null) return null;
    return { a: Number(m[1]) };
  };

  const headerPath = (line) => {
    let raw = line.slice(4);
    const tab = raw.indexOf('\t');
    if (tab >= 0) raw = raw.slice(0, tab);
    let p = raw.trim();
    if (p.startsWith('a/')) p = p.slice(2);
    else if (p.startsWith('b/')) p = p.slice(2);
    return p === '/dev/null' ? null : p;
  };

  const makeHunk = (h, body) => {
    const o = [];
    const nn = [];
    for (const bl of body) {
      if (bl.startsWith('\\')) continue;
      if (bl === '' || bl.startsWith(' ')) {
        const t = bl === '' ? '' : bl.slice(1);
        o.push(t);
        nn.push({ text: t, ctx: true, oIdx: o.length - 1 });
      } else if (bl.startsWith('-')) {
        o.push(bl.slice(1));
      } else if (bl.startsWith('+')) {
        nn.push({ text: bl.slice(1), ctx: false, oIdx: -1 });
      }
    }
    // A \ line refers to the body line before it. It matters when it
    // follows the hunk's last context or + line (the result then ends
    // without a line break), or its last + line (for a created file).
    let lastCp = -1;
    let lastPlus = -1;
    for (let k = 0; k < body.length; k++) {
      const bl = body[k];
      if (bl === '' || bl.startsWith(' ') || bl.startsWith('+')) lastCp = k;
      if (bl.startsWith('+')) lastPlus = k;
    }
    const follows = (k) => k >= 0 && k + 1 < body.length && body[k + 1].startsWith('\\');
    return {
      a: h.a,
      o,
      n: nn,
      noNl: follows(lastCp),
      hasPlus: lastPlus >= 0,
      lastPlusNoNl: follows(lastPlus),
    };
  };

  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(line, lineNo);
      startSection(x, y);
      i++;
      continue;
    }
    if (
      line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')
    ) {
      // A ---/+++ pair belongs to this section's header when the section
      // has no pair yet and no hunk has started; otherwise it starts a
      // new section.
      const takesPair = cur !== null
        && cur.pairOld === undefined
        && cur.pairNew === undefined
        && cur.hunks.length === 0;
      if (cur === null || takesPair) {
        if (cur === null) startSection(undefined, undefined);
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]);
      } else {
        startSection(undefined, undefined);
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]);
      }
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new ParseError(lineNo);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      // Not followed by a +++ line (that case was handled above).
      throw new ParseError(lineNo + 1);
    }
    if (line.startsWith('+++ ')) {
      cur.pairNew = headerPath(line);
      i++;
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur.renameFrom = line.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur.renameTo = line.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      cur.newFile = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur.deletedFile = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const h = hunkHeader(line);
      if (h === null) throw new ParseError(lineNo);
      const body = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && j + 1 < n && lines[j + 1].startsWith('+++ ')) break;
        if (
          bl === '' || bl.startsWith(' ') || bl.startsWith('-')
          || bl.startsWith('+') || bl.startsWith('\\')
        ) {
          body.push(bl);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(makeHunk(h, body));
      i = j;
      continue;
    }
    i++;
  }
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) throw new ParseError(1);
  return sections.map(sectionToEdit);
}

function applyHunks(doc, hunks, path, strict) {
  const lines = doc.lines.slice();
  let trail = doc.trail;
  let d = 0;
  const tiers = tiersFor(strict);
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = occurrencesFrom(lines, h.o, 0, tiers);
      if (found === null) throw new EditError('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rep = buildNewLines(lines, best, h.o, h.n, found.tier);
      const runsToEnd = best + h.o.length === lines.length;
      lines.splice(best, h.o.length, ...rep);
      if (runsToEnd) trail = !h.noNl;
      d += h.n.length - h.o.length;
    } else {
      const insertAt = Math.max(0, Math.min(h.a + d, lines.length));
      const rep = buildNewLines(lines, insertAt, h.o, h.n, 0);
      const atEnd = insertAt === lines.length;
      lines.splice(insertAt, 0, ...rep);
      if (atEnd) trail = !h.noNl;
      d += h.n.length;
    }
  }
  return freshDoc(doc, lines, trail);
}

function sectionToEdit(s) {
  const oldPath = s.pairOld !== undefined
    ? s.pairOld
    : (s.renameFrom !== undefined ? s.renameFrom : s.gitOld);
  const newPath = s.pairNew !== undefined
    ? s.pairNew
    : (s.renameTo !== undefined ? s.renameTo : s.gitNew);
  const norm = (p) => (p === undefined || p === '/dev/null' ? null : p);
  const oldP = norm(oldPath);
  const newP = norm(newPath);
  const isCreate = s.newFile || oldP === null;
  const isDelete = !isCreate && (s.deletedFile || newP === null);

  if (isCreate) {
    return {
      apply(tree) {
        if (newP === null) return;
        checkSafe(newP);
        if (tree.exists(newP)) throw new EditError('exists', newP);
        const plusLines = [];
        for (const h of s.hunks) {
          for (const nl of h.n) {
            if (!nl.ctx) plusLines.push(nl.text);
          }
        }
        let noNl = false;
        for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          if (s.hunks[hi].hasPlus) {
            noNl = s.hunks[hi].lastPlusNoNl;
            break;
          }
        }
        const text = plusLines.length === 0
          ? ''
          : plusLines.join('\n') + (noNl ? '' : '\n');
        tree.set(newP, text);
      },
    };
  }
  if (isDelete) {
    return {
      apply(tree) {
        if (oldP === null) return;
        checkSafe(oldP);
        if (!tree.exists(oldP)) throw new EditError('missing', oldP);
        tree.set(oldP, null);
      },
    };
  }
  if (oldP !== newP) {
    return {
      apply(tree, ctx) {
        checkSafe(oldP);
        checkSafe(newP);
        const curText = tree.get(oldP);
        if (curText === null) throw new EditError('missing', oldP);
        if (tree.exists(newP)) throw new EditError('exists', newP);
        const out = applyHunks(new Doc(curText), s.hunks, oldP, ctx.strict);
        tree.set(newP, out.toString());
        tree.set(oldP, null);
        ctx.movePairs.push([oldP, newP]);
      },
    };
  }
  return {
    apply(tree, ctx) {
      checkSafe(oldP);
      const curText = tree.get(oldP);
      if (curText === null) throw new EditError('missing', oldP);
      const out = applyHunks(new Doc(curText), s.hunks, oldP, ctx.strict);
      tree.set(oldP, out.toString());
    },
  };
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function parseSearchReplace(lines) {
  const isSearch = (l) => trimEndWS(l) === '<<<<<<< SEARCH';
  const isSep = (l) => trimEndWS(l) === '=======';
  const isReplace = (l) => trimEndWS(l) === '>>>>>>> REPLACE';
  const blocks = [];
  let i = 0;
  let prevEnd = 0;
  while (i < lines.length) {
    if (!isSearch(lines[i])) {
      i++;
      continue;
    }
    const searchNo = i + 1;
    let path = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j];
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1].path;
      else throw new ParseError(searchNo);
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isSep(lines[j])) {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new ParseError(searchNo);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (isReplace(lines[j])) {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseError(searchNo);
    blocks.push({
      path,
      oldLines: lines.slice(i + 1, sep),
      newLines: lines.slice(sep + 1, rep),
    });
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new ParseError(1);
  return blocks.map(blockToEdit);
}

function blockToEdit(b) {
  return {
    apply(tree, ctx) {
      checkSafe(b.path);
      if (b.oldLines.length === 0) {
        if (tree.exists(b.path)) throw new EditError('exists', b.path);
        const text = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
        tree.set(b.path, text);
        return;
      }
      const curText = tree.get(b.path);
      if (curText === null) throw new EditError('missing', b.path);
      const doc = new Doc(curText);
      const found = occurrencesFrom(doc.lines, b.oldLines, 0, tiersFor(ctx.strict));
      if (found === null) throw new EditError('no-match', b.path);
      if (found.positions.length > 1) throw new EditError('ambiguous', b.path);
      const pos = found.positions[0];
      const n = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const rep = buildNewLines(doc.lines, pos, b.oldLines, n, found.tier);
      const lines = doc.lines.slice();
      lines.splice(pos, b.oldLines.length, ...rep);
      tree.set(b.path, freshDoc(doc, lines, doc.trail).toString());
    },
  };
}

// ---------- V4A patches (SPEC section 8) ----------

function parseV4a(lines) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (first < 0) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);
  const isAdd = (l) => l.startsWith('*** Add File: ');
  const isDel = (l) => l.startsWith('*** Delete File: ');
  const isUpd = (l) => l.startsWith('*** Update File: ');
  const isSectionStart = (l) => isAdd(l) || isDel(l) || isUpd(l);
  const sections = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (!isSectionStart(line)) throw new ParseError(i + 1);
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j])) j++;
    const raw = [];
    for (let k = i + 1; k < j; k++) raw.push({ text: lines[k], no: k + 1 });
    while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();
    sections.push({ head: line, headNo: i + 1, raw });
    i = j;
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections.map(sectionToV4aEdit);
}

function chunkBodyToON(body) {
  const o = [];
  const nn = [];
  for (const bl of body) {
    if (bl === '' || bl.startsWith(' ')) {
      const t = bl === '' ? '' : bl.slice(1);
      o.push(t);
      nn.push({ text: t, ctx: true, oIdx: o.length - 1 });
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      nn.push({ text: bl.slice(1), ctx: false, oIdx: -1 });
    }
  }
  return { o, n: nn };
}

function applyV4aChunks(doc, chunks, path, strict) {
  const lines = doc.lines.slice();
  let cursor = 0;
  const tiers = tiersFor(strict);
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let foundIdx = -1;
      for (const tier of tiers) {
        for (let i = cursor; i < lines.length; i++) {
          if (lineMatchesAtTier(lines[i], ch.anchor, tier)) {
            foundIdx = i;
            break;
          }
        }
        if (foundIdx >= 0) break;
      }
      if (foundIdx < 0) throw new EditError('no-match', path);
      cursor = foundIdx + 1;
    }
    if (ch.o.length > 0) {
      let found = null;
      for (const tier of tiers) {
        for (let i = cursor; i + ch.o.length <= lines.length; i++) {
          if (ch.eof && i + ch.o.length !== lines.length) continue;
          let ok = true;
          for (let k = 0; k < ch.o.length; k++) {
            if (!lineMatchesAtTier(lines[i + k], ch.o[k], tier)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            found = { tier, pos: i };
            break;
          }
        }
        if (found !== null) break;
      }
      if (found === null) throw new EditError('no-match', path);
      const rep = buildNewLines(lines, found.pos, ch.o, ch.n, found.tier);
      lines.splice(found.pos, ch.o.length, ...rep);
      cursor = found.pos + rep.length;
    } else {
      const insertAt = ch.eof ? lines.length : cursor;
      const rep = buildNewLines(lines, insertAt, ch.o, ch.n, 0);
      lines.splice(insertAt, 0, ...rep);
      cursor = insertAt + rep.length;
    }
  }
  return freshDoc(doc, lines, doc.trail);
}

function sectionToV4aEdit(s) {
  const head = s.head;
  if (head.startsWith('*** Add File: ')) {
    const p = head.slice('*** Add File: '.length).trim();
    const fileLines = [];
    for (const rl of s.raw) {
      if (rl.text === '') fileLines.push('');
      else if (rl.text.startsWith('+')) fileLines.push(rl.text.slice(1));
      else throw new ParseError(rl.no);
    }
    return {
      apply(tree) {
        checkSafe(p);
        if (tree.exists(p)) throw new EditError('exists', p);
        const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
        tree.set(p, text);
      },
    };
  }
  if (head.startsWith('*** Delete File: ')) {
    const p = head.slice('*** Delete File: '.length).trim();
    if (s.raw.length > 0) throw new ParseError(s.raw[0].no);
    return {
      apply(tree) {
        checkSafe(p);
        if (!tree.exists(p)) throw new EditError('missing', p);
        tree.set(p, null);
      },
    };
  }
  const p = head.slice('*** Update File: '.length).trim();
  let moveTo = null;
  let idx = 0;
  if (s.raw.length > 0 && s.raw[0].text.startsWith('*** Move to: ')) {
    moveTo = s.raw[0].text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks = [];
  let cur = null;
  let seenChunk = false;
  const pushChunk = () => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (; idx < s.raw.length; idx++) {
    const rl = s.raw[idx];
    const l = rl.text;
    if (l.startsWith('@@')) {
      pushChunk();
      const anchorText = l.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
      seenChunk = true;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new ParseError(rl.no);
      cur.eof = true;
      pushChunk();
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (seenChunk) throw new ParseError(rl.no);
        cur = { anchor: null, eof: false, body: [] };
        seenChunk = true;
      }
      cur.body.push(l);
      continue;
    }
    throw new ParseError(rl.no);
  }
  pushChunk();
  if (chunks.length === 0 && moveTo === null) throw new ParseError(s.headNo);
  const convChunks = chunks.map((ch) => {
    const on = chunkBodyToON(ch.body);
    return { anchor: ch.anchor, eof: ch.eof, o: on.o, n: on.n };
  });
  return {
    apply(tree, ctx) {
      checkSafe(p);
      if (moveTo !== null) checkSafe(moveTo);
      const curText = tree.get(p);
      if (curText === null) throw new EditError('missing', p);
      if (moveTo !== null && tree.exists(moveTo)) throw new EditError('exists', moveTo);
      const out = applyV4aChunks(new Doc(curText), convChunks, p, ctx.strict);
      if (moveTo !== null) {
        tree.set(moveTo, out.toString());
        tree.set(p, null);
        ctx.movePairs.push([p, moveTo]);
      } else {
        tree.set(p, out.toString());
      }
    },
  };
}

// ---------- JSON edits (SPEC section 9) ----------

function validateJsonEdit(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.path !== 'string') return null;
  if (typeof v.command !== 'string') return null;
  if (v.command === 'create') {
    if (typeof v.file_text !== 'string') return null;
    return { command: 'create', path: v.path, file_text: v.file_text };
  }
  if (v.command === 'str_replace') {
    if (typeof v.old_str !== 'string' || v.old_str === '') return null;
    if (v.new_str !== undefined && typeof v.new_str !== 'string') return null;
    return {
      command: 'str_replace',
      path: v.path,
      old_str: v.old_str,
      new_str: v.new_str === undefined ? '' : v.new_str,
    };
  }
  if (v.command === 'insert') {
    if (!Number.isInteger(v.insert_line)) return null;
    if (typeof v.new_str !== 'string') return null;
    return {
      command: 'insert',
      path: v.path,
      insert_line: v.insert_line,
      new_str: v.new_str,
    };
  }
  return null;
}

function parseJson(patchText, lines) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseError(1);
  const edits = [];
  if (lines[first].trimStart().startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(first + 1);
    for (const el of arr) {
      const e = validateJsonEdit(el);
      if (e === null) throw new ParseError(first + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseError(1);
    return edits.map(jsonEditToEdit);
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    let obj;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseError(i + 1);
    }
    const e = validateJsonEdit(obj);
    if (e === null) throw new ParseError(i + 1);
    edits.push(e);
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits.map(jsonEditToEdit);
}

function countOverlapping(text, sub) {
  let count = 0;
  let firstIdx = -1;
  let from = 0;
  for (;;) {
    const j = text.indexOf(sub, from);
    if (j < 0) break;
    if (firstIdx < 0) firstIdx = j;
    count++;
    from = j + 1;
  }
  return { count, firstIdx };
}

function jsonEditToEdit(e) {
  if (e.command === 'create') {
    return {
      apply(tree) {
        checkSafe(e.path);
        if (tree.exists(e.path)) throw new EditError('exists', e.path);
        tree.set(e.path, e.file_text);
      },
    };
  }
  if (e.command === 'str_replace') {
    return {
      apply(tree) {
        checkSafe(e.path);
        const curText = tree.get(e.path);
        if (curText === null) throw new EditError('missing', e.path);
        const doc = new Doc(curText);
        let text = curText;
        let oldS = e.old_str;
        let newS = e.new_str;
        if (doc.brk === '\r\n') {
          text = curText.replace(/\r\n/g, '\n');
          oldS = oldS.replace(/\r\n/g, '\n');
          newS = newS.replace(/\r\n/g, '\n');
        }
        const { count, firstIdx } = countOverlapping(text, oldS);
        if (count === 0) throw new EditError('no-match', e.path);
        if (count > 1) throw new EditError('ambiguous', e.path);
        let res = text.slice(0, firstIdx) + newS + text.slice(firstIdx + oldS.length);
        if (doc.brk === '\r\n') res = res.replace(/\n/g, '\r\n');
        tree.set(e.path, res);
      },
    };
  }
  return {
    apply(tree) {
      checkSafe(e.path);
      const curText = tree.get(e.path);
      if (curText === null) throw new EditError('missing', e.path);
      const doc = new Doc(curText);
      if (e.insert_line < 0 || e.insert_line > doc.lines.length) {
        throw new EditError('no-match', e.path);
      }
      const ins = splitNewStrLines(e.new_str);
      const lines = doc.lines.slice();
      lines.splice(e.insert_line, 0, ...ins);
      tree.set(e.path, freshDoc(doc, lines, doc.trail).toString());
    },
  };
}

// ---------- format detection (SPEC section 4) ----------

function detectFormat(lines) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const firstNonWs = lines[first].trimStart();
  if (firstNonWs.startsWith('[') || firstNonWs.startsWith('{')) return 'json';
  for (const l of lines) {
    if (trimEndWS(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (
      lines[i].startsWith('--- ') && i + 1 < lines.length
      && lines[i + 1].startsWith('+++ ')
    ) {
      return 'unified';
    }
  }
  return null;
}

// ---------- invocation (SPEC sections 1, 2 and 10) ----------

function main() {
  const args = process.argv.slice(2);
  let format = 'auto';
  let check = false;
  let strict = false;
  const positional = [];
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  let usage = false;
  for (const a of args) {
    if (endOpts) {
      positional.push(a);
      continue;
    }
    if (a === '--') {
      endOpts = true;
      continue;
    }
    if (a === '-') {
      positional.push(a);
      continue;
    }
    if (a.startsWith('-')) {
      if (a === '--check') {
        if (seenCheck) usage = true;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) usage = true;
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) usage = true;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (
          v === 'unified' || v === 'search-replace' || v === 'v4a'
          || v === 'json' || v === 'auto'
        ) {
          format = v;
        } else {
          usage = true;
        }
      } else {
        usage = true;
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) usage = true;
  if (usage) {
    writeStdout('error: usage\n');
    process.exit(2);
  }

  let patchText;
  const patchArg = positional[0];
  try {
    patchText = patchArg === undefined || patchArg === '-'
      ? readFileSync(0, 'utf8')
      : readFileSync(resolveRel(patchArg), 'utf8');
  } catch {
    writeStdout('error: no-patch\n');
    process.exit(2);
  }
  const lines = splitPatchLines(patchText);

  let fmt = format;
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      writeStdout('error: format\n');
      process.exit(2);
    }
    fmt = detected;
  }

  let edits;
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(patchText, lines);
  } catch (err) {
    if (err instanceof ParseError) {
      writeStdout(`error: parse ${err.line}\n`);
      process.exit(2);
    }
    throw err;
  }

  const tree = new Tree();
  const ctx = { strict, movePairs: [] };
  const failures = [];
  for (const e of edits) {
    try {
      e.apply(tree, ctx);
    } catch (err) {
      if (err instanceof EditError) {
        failures.push(err);
        continue;
      }
      throw err;
    }
  }

  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    writeStdout(out);
    process.exit(1);
  }

  const changeLines = tree.changes(ctx.movePairs);
  if (!check) tree.write();
  let out = '';
  for (const l of changeLines) out += `${l}\n`;
  out += changeLines.length === 1 ? 'ok: 1 file\n' : `ok: ${changeLines.length} files\n`;
  writeStdout(out);
  process.exit(0);
}

// A trial hands over to runner.ts: the env's checks are fetched, main.ts
// is run on each one, and the results are posted back.
const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  runTrial(envUrl).then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`trial failed: ${err && err.message ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
} else {
  main();
}
