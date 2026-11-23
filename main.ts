// main.ts is mend, the CLI SPEC.md specifies: it applies an edit that an AI
// model wrote to a tree of text files, in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A patches, JSON tool calls), every file changed or
// nothing. Sections 1 to 10 of SPEC.md. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines, with its own line break and whether it ends with one (section 3). */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** How a line compares at a tier of section 5: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions i at or after `from` where O matches lines[i..] at this tier; may overlap. */
function occAt(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const ok = O.map((l) => tierKey(l, tier));
  for (let i = from; i + O.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < O.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== ok[j]) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk. */
interface HunkItem {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
}

/** Split body items into old lines O and new lines N; nCtxO[i] is the O index of N[i] when it is a context line. */
function splitON(items: HunkItem[]): { O: string[]; N: string[]; nCtxO: (number | null)[] } {
  const O: string[] = [];
  const N: string[] = [];
  const nCtxO: (number | null)[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      nCtxO.push(O.length);
      O.push(it.text);
      N.push(it.text);
    } else if (it.kind === 'old') {
      O.push(it.text);
    } else if (it.kind === 'new') {
      nCtxO.push(null);
      N.push(it.text);
    }
  }
  return { O, N, nCtxO };
}

/** Replace the O lines at `pos` by the N lines (section 5): context lines are the file's own matched lines, and at
    tier 2 the other lines of N are re-indented from O's first line's leading whitespace to the file's. */
function applyReplace(f: FileState, pos: number, O: string[], N: string[], nCtxO: (number | null)[], tier: number): FileState {
  const rep: string[] = [];
  if (tier === 2) {
    const F = leadingWS(f.lines[pos] ?? '');
    const P = leadingWS(O[0] ?? '');
    for (let i = 0; i < N.length; i++) {
      const oi = nCtxO[i];
      if (oi !== null && oi !== undefined) {
        rep.push(f.lines[pos + oi]!);
        continue;
      }
      const line = N[i]!;
      if (line !== '' && line.trim() !== '' && line.startsWith(P)) rep.push(F + line.slice(P.length));
      else rep.push(line);
    }
  } else {
    for (let i = 0; i < N.length; i++) {
      const oi = nCtxO[i];
      rep.push(oi !== null && oi !== undefined ? f.lines[pos + oi]! : N[i]!);
    }
  }
  const lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + O.length)];
  return { lines, br: f.br, finalBreak: f.finalBreak };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Moves a move edit made, in the patch's order; the output turns a satisfied one into an `R` line. */
interface Move {
  old: string;
  nw: string;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One hunk of a unified diff (section 6). */
interface Hunk {
  a: number;
  items: HunkItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noFinalBreak: boolean;
}

/** One section of a unified diff. A path is undefined when no line names it, null for `/dev/null`. */
interface Section {
  diffOld: string | undefined;
  diffNew: string | undefined;
  headOld: string | null | undefined;
  headNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` or `+++ ` header line, or null for `/dev/null`. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Whether a `\` line follows the last item of one of these kinds in the body items. */
function backslashAfterLastKind(items: HunkItem[], kinds: string[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (kinds.includes(it.kind)) {
      return items[i + 1] !== undefined && items[i + 1]!.kind === 'backslash';
    }
  }
  return false;
}

/** A hunk's body: the lines after its header, up to the first line that is not one. Empty lines at the end are not part of it. */
function parseHunkBody(lines: string[], i: number): { items: HunkItem[]; next: number } {
  const items: HunkItem[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '' });
      i++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      items.push({ kind: 'ctx', text: l.slice(1) });
      i++;
      continue;
    }
    if (c === '-') {
      items.push({ kind: 'old', text: l.slice(1) });
      i++;
      continue;
    }
    if (c === '+') {
      items.push({ kind: 'new', text: l.slice(1) });
      i++;
      continue;
    }
    if (c === '\\') {
      items.push({ kind: 'backslash', text: l.slice(1) });
      i++;
      continue;
    }
    break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  return { items, next: i };
}

/** Apply a section's hunks in order to a file's lines (section 6). */
function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let d = 0;
  for (const h of hunks) {
    const { O, N, nCtxO } = splitON(h.items);
    if (O.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const atEnd = pos === f.lines.length;
      const lines = [...f.lines.slice(0, pos), ...N, ...f.lines.slice(pos)];
      f = { lines, br: f.br, finalBreak: atEnd ? !h.noFinalBreak : f.finalBreak };
      d += N.length;
      continue;
    }
    let tier = -1;
    let occ: number[] = [];
    for (const t of tiersToTry(strict)) {
      occ = occAt(f.lines, O, t, 0);
      if (occ.length > 0) {
        tier = t;
        break;
      }
    }
    if (tier < 0) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + O.length === f.lines.length;
    const nf = applyReplace(f, best, O, N, nCtxO, tier);
    f = { ...nf, finalBreak: atEnd ? !h.noFinalBreak : nf.finalBreak };
    d += N.length - O.length;
  }
  return f;
}

/** One section's edit (section 6): creation, deletion, move or change of one path. */
function sectionEdit(sec: Section, strict: boolean, moves: Move[]): Edit {
  const oldPath = sec.headOld !== undefined ? sec.headOld : sec.renOld !== undefined ? sec.renOld : sec.diffOld !== undefined ? sec.diffOld : null;
  const newPath = sec.headNew !== undefined ? sec.headNew : sec.renNew !== undefined ? sec.renNew : sec.diffNew !== undefined ? sec.diffNew : null;
  const isCreate = sec.isCreate || oldPath === null;
  const isDelete = !isCreate && (sec.isDelete || newPath === null);
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      if (newPath === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const lines: string[] = [];
      let lastNewBackslash = false;
      for (const h of sec.hunks) {
        let hasNew = false;
        for (const it of h.items) {
          if (it.kind === 'new') {
            lines.push(it.text);
            hasNew = true;
          }
        }
        if (hasNew) lastNewBackslash = backslashAfterLastKind(h.items, ['new']);
      }
      tree.now.set(newPath, lines.length === 0 ? '' : lines.join('\n') + (lastNewBackslash ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath!;
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    const isMove = newPath !== null && newPath !== op;
    if (isMove && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    const out = applyHunks(splitFile(cur), sec.hunks, strict, op);
    const text = joinFile(out);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(newPath!, text);
      moves.push({ old: op, nw: newPath! });
    } else {
      tree.now.set(op, text);
    }
  };
}

/** Read a patch as a unified diff (section 6): its sections, each one edit. */
function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const startSection = (diffOld: string | undefined, diffNew: string | undefined): void => {
    const s: Section = {
      diffOld,
      diffNew,
      headOld: undefined,
      headNew: undefined,
      renOld: undefined,
      renNew: undefined,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), items: body.items, noFinalBreak: backslashAfterLastKind(body.items, ['ctx', 'new']) });
      inHeader = false;
      i = body.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.headOld = headerPath(line);
          cur.headNew = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection(undefined, undefined);
      continue;
    }
    i++;
  }
  return sections.map((s) => sectionEdit(s, strict, moves));
}

/** One SEARCH/REPLACE block's edit (section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    let tier = -1;
    let occ: number[] = [];
    for (const t of tiersToTry(strict)) {
      occ = occAt(f.lines, oldLines, t, 0);
      if (occ.length > 0) {
        tier = t;
        break;
      }
    }
    if (tier < 0) throw new Fail('no-match', path);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const nf = applyReplace(f, occ[0]!, oldLines, newLines, newLines.map(() => null), tier);
    tree.now.set(path, joinFile(nf));
  };
}

/** Read a patch as SEARCH/REPLACE blocks (section 7): each block is one edit. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '=======') {
        eq = j;
        break;
      }
      if (l === '>>>>>>> REPLACE') break;
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

/** One chunk of a V4A Update File section (section 8). `blanks` runs parallel to `items`: whether the patch line was blank. */
interface VChunk {
  anchor: string | null;
  items: HunkItem[];
  eof: boolean;
  blanks: boolean[];
}

/** One V4A Update File section's edit (section 8): chunks apply in order with a cursor. */
function updateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      const { O, N, nCtxO } = splitON(ch.items);
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tiersToTry(strict)) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (tierKey(f.lines[k]!, t) === tierKey(ch.anchor, t)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      if (O.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const lines = [...f.lines.slice(0, pos), ...N, ...f.lines.slice(pos)];
        f = { lines, br: f.br, finalBreak: f.finalBreak };
        cursor = pos + N.length;
      } else {
        let tier = -1;
        let occ: number[] = [];
        for (const t of tiersToTry(strict)) {
          occ = occAt(f.lines, O, t, cursor).filter((p) => !ch.eof || p + O.length === f.lines.length);
          if (occ.length > 0) {
            tier = t;
            break;
          }
        }
        if (tier < 0) throw new Fail('no-match', path);
        const pos = occ[0]!;
        f = applyReplace(f, pos, O, N, nCtxO, tier);
        cursor = pos + N.length;
      }
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

/** Read a patch as a V4A patch (section 8): its sections, each one edit. */
function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const body: { text: string; blank: boolean }[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          body.push({ text: l.slice(1), blank: false });
          i++;
          continue;
        }
        if (l === '') {
          body.push({ text: '', blank: true });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1]!.blank) body.pop();
      const text = body.map((b) => b.text);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, text.length === 0 ? '' : text.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const close = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('@@')) {
          close();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false, blanks: [] };
          i++;
          continue;
        }
        if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          close();
          i++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length === 0) cur = { anchor: null, items: [], eof: false, blanks: [] };
            else throw new Exit2(`error: parse ${i + 1}`);
          }
          if (l === '') {
            cur.items.push({ kind: 'ctx', text: '' });
            cur.blanks.push(true);
          } else if (l[0] === ' ') {
            cur.items.push({ kind: 'ctx', text: l.slice(1) });
            cur.blanks.push(l.slice(1).trim() === '');
          } else if (l[0] === '-') {
            cur.items.push({ kind: 'old', text: l.slice(1) });
            cur.blanks.push(false);
          } else {
            cur.items.push({ kind: 'new', text: l.slice(1) });
            cur.blanks.push(false);
          }
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        while (cur.items.length > 0 && cur.blanks[cur.blanks.length - 1]) {
          cur.items.pop();
          cur.blanks.pop();
        }
      }
      close();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(updateEdit(path, moveTo, chunks, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per path whose state changed, in byte order of the paths. A move that succeeded, whose old path
  // existed before and does not after and whose new path did not exist before and does after, replaces that
  // pair's D and A lines with one `R <old> -> <new>` line, sorted by <new>.
  const satisfied: Move[] = [];
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) satisfied.push(m);
  }
  const covered = new Set<string>();
  for (const m of satisfied) {
    covered.add(m.old);
    covered.add(m.nw);
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of satisfied) rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
