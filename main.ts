// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** An occurrence of O in a file's lines: the tier it matched at and the 0-based position it starts at. */
type Occurrence = { tier: number; at: number };

/**
 * SPEC.md section 5: O occurs in the file's lines at the first tier where it occurs at least once —
 * tier 0 with every line equal, tier 1 equal once trailing spaces and tabs are removed from both,
 * tier 2 once leading and trailing ones are. Returns that tier and the earliest 0-based position of
 * an occurrence there (occurrences may overlap), or null when no tier has one. With `strict` only
 * tier 0 is tried.
 */
function findOccurrence(o: string[], file: string[], strict: boolean): Occurrence | null {
  const trims: ((s: string) => string)[] = [
    (s) => s,
    (s) => s.replace(/[ \t]+$/, ''),
    (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
  ];
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const oldLines = o.map(trims[tier]!);
    const fileLines = file.map(trims[tier]!);
    for (let at = 0; at + oldLines.length <= fileLines.length; at += 1) {
      if (oldLines.every((l, k) => fileLines[at + k] === l)) return { tier, at };
    }
  }
  return null;
}

/**
 * SPEC.md section 6: of the occurrences of O in the file's lines at the first tier where O occurs at
 * least once (the three tiers of findOccurrence, section 5; with `strict` only tier 0 is tried), the
 * one whose 0-based start is nearest to `target`; of two equally near, the earlier. Occurrences may
 * overlap. Returns that start index, or null when O is empty or occurs at no tier.
 */
function nearestOccurrence(o: string[], file: string[], target: number, strict: boolean): number | null {
  if (o.length === 0) return null;
  const trims: ((s: string) => string)[] = [
    (s) => s,
    (s) => s.replace(/[ \t]+$/, ''),
    (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
  ];
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const oldLines = o.map(trims[tier]!);
    const fileLines = file.map(trims[tier]!);
    let best = -1;
    let bestDist = Infinity;
    for (let at = 0; at + oldLines.length <= fileLines.length; at += 1) {
      if (!oldLines.every((l, k) => fileLines[at + k] === l)) continue;
      const dist = Math.abs(at - target);
      if (dist < bestDist) {
        best = at;
        bestDist = dist;
      }
    }
    if (best >= 0) return best;
  }
  return null;
}

/** One line of N as a format builds it: `context` marks a line of both O and N, already holding the file's own matched line. */
type NLine = { text: string; context?: boolean };

/**
 * SPEC.md section 5: the lines of N as they are written over the matched lines. A context line is
 * written as the file's own line the caller put in it. At tier 2 every other line of N that is not
 * empty and not only whitespace, and starts with P (the leading spaces and tabs of O's first line),
 * has that P replaced by F (the leading spaces and tabs of the file's first matched line); any other
 * line is written as it is. At tiers 0 and 1 the lines of N are written as they are.
 */
function newLines(n: NLine[], tier: number, fileFirst: string, oFirst: string): string[] {
  if (tier !== 2) return n.map((l) => l.text);
  const lead = (s: string): string => /^[ \t]*/.exec(s)![0] ?? '';
  const f = lead(fileFirst);
  const p = lead(oFirst);
  return n.map((l) => (l.context || blank(l.text) || !l.text.startsWith(p) ? l.text : f + l.text.slice(p.length)));
}

/** One body line of a unified hunk (SPEC.md section 6) with its kind; `text` is the line after its marker. */
type HunkLine = { kind: 'context' | 'old' | 'new' | 'backslash'; text: string };

type Hunk = { oldStart: number; newStart: number; body: HunkLine[]; end: number };

/**
 * SPEC.md section 6: one hunk of a unified diff whose header is patch line `at` (0-based). The header is
 * `@@ -A[,B] +C[,D] @@` optionally followed by more text; B and D are not used, and a line starting with
 * `@@` that is not a header is `error: parse <its 1-based line>`. The body is the lines after the header
 * that start with ` ` (context), `-` (old), `+` (new) or `\`, or are empty (a context line whose text is
 * empty); it ends at the first other line, at a `diff --git ` line, at a `--- ` line followed by a
 * `+++ ` line, or at the end of the patch, and trailing empty lines are not part of it. Returns the two
 * start numbers A and C, the body lines with their kinds, and `end`, the index of the first line after
 * the body.
 */
function parseHunk(lines: string[], at: number): Hunk {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[at] ?? '');
  if (!m) throw new Exit2(`error: parse ${at + 1}`);
  const body: HunkLine[] = [];
  let end = at + 1;
  for (let i = at + 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    const c = l[0];
    if (c === ' ' || c === '-' || c === '+') {
      body.push({ kind: c === ' ' ? 'context' : c === '-' ? 'old' : 'new', text: l.slice(1) });
      end = i + 1;
    } else if (c === '\\') {
      body.push({ kind: 'backslash', text: l.slice(1) });
      end = i + 1;
    } else if (l === '') {
      body.push({ kind: 'context', text: '' });
    } else break;
  }
  body.length = end - (at + 1);
  return { oldStart: Number(m[1]), newStart: Number(m[2]), body, end };
}

/** The header of one unified diff section (SPEC.md section 6): its paths, kind and where its first hunk starts. */
type SectionHeader = { oldPath: string | null; newPath: string | null; create: boolean; del: boolean; hunkAt: number };

/**
 * SPEC.md section 6: the header of one unified diff section starting at patch line `at` (0-based) — a
 * `diff --git a/<X> b/<Y>` line or a `--- ` line followed by a `+++ ` line. The header is the lines up to
 * the section's first hunk (`@@` line), the next section's start, or the end of the patch. `--- `/`+++ `
 * name the old and new path (the text after the four characters, up to the first tab, trimmed; `/dev/null`
 * is no file; a leading `a/` or `b/` is removed), `rename from`/`rename to` name them when no pair does,
 * `new file mode`/`deleted file mode` mark a creation or deletion, and the `diff --git` paths are used when
 * nothing else names one; every other line is ignored. A `--- ` line not followed by a `+++ ` line is
 * `error: parse <the 1-based line after it>` and a malformed `diff --git` line is `error: parse <its line>`.
 * Returns the old and new path (null: no file), the creation and deletion flags, and `hunkAt`, the index of
 * the first hunk header or of the line the section header ends at.
 */
function parseSectionHeader(lines: string[], at: number): SectionHeader {
  const strip = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const headerPath = (l: string): string | null => {
    let p = l.slice(4);
    const t = p.indexOf('\t');
    if (t >= 0) p = p.slice(0, t);
    p = strip(p.trim());
    return p === '/dev/null' ? null : p;
  };
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renOld: string | null = null;
  let renNew: string | null = null;
  let gitOld: string | null = null;
  let gitNew: string | null = null;
  let create = false;
  let del = false;
  let paired = false;
  let i = at;
  for (; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git (\S+) (\S+)[ \t]*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (i !== at) break;
      gitOld = strip(m[1]!);
      gitNew = strip(m[2]!);
    } else if (l.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      if (paired) break;
      pairOld = headerPath(l);
      pairNew = headerPath(next);
      paired = true;
      i += 1;
    } else if (l.startsWith('rename from ')) {
      renOld = strip(l.slice(12).trim());
    } else if (l.startsWith('rename to ')) {
      renNew = strip(l.slice(10).trim());
    } else if (l.startsWith('new file mode')) {
      create = true;
    } else if (l.startsWith('deleted file mode')) {
      del = true;
    }
  }
  return { oldPath: paired ? pairOld : renOld ?? gitOld, newPath: paired ? pairNew : renNew ?? gitNew, create, del, hunkAt: i };
}

/** One unified diff section (SPEC.md section 6): its header and its hunks in order. */
type Section = { header: SectionHeader; hunks: Hunk[] };

function parseSections(lines: string[]): Section[] {
  const start = (i: number): boolean => {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return /^diff --git \S+ \S+[ \t]*$/.test(l);
    return l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  };
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length && !start(i)) {
    if (lines[i]!.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  while (i < lines.length) {
    const header = parseSectionHeader(lines, i);
    const hunks: Hunk[] = [];
    let j = header.hunkAt;
    while (j < lines.length && !start(j)) {
      if (lines[j]!.startsWith('@@')) {
        const h = parseHunk(lines, j);
        hunks.push(h);
        j = h.end;
      } else {
        j += 1;
      }
    }
    sections.push({ header, hunks });
    i = j;
  }
  return sections;
}

function applyHunk(hunk: Hunk, text: string, d: number, strict: boolean): string | null {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const file = text === '' ? [] : text.split(br);
  const final = text !== '' && text.endsWith(br);
  if (final) file.pop();
  const o: string[] = [];
  const n: NLine[] = [];
  let lastNBody = -1;
  hunk.body.forEach((l, i) => {
    if (l.kind === 'context' || l.kind === 'old') o.push(l.text);
    if (l.kind === 'context' || l.kind === 'new') {
      n.push({ text: l.text, context: l.kind === 'context' });
      lastNBody = i;
    }
  });
  const noNewBreak = lastNBody >= 0 && hunk.body[lastNBody + 1]?.kind === 'backslash';
  let start: number;
  let count: number;
  let written: string[];
  let atEnd: boolean;
  if (o.length > 0) {
    const occ = findOccurrence(o, file, strict);
    if (occ === null) return null;
    const at = nearestOccurrence(o, file, hunk.oldStart - 1 + d, strict);
    if (at === null) return null;
    start = at;
    count = o.length;
    let oi = 0;
    let ni = 0;
    for (const l of hunk.body) {
      if (l.kind === 'context') {
        n[ni]!.text = file[at + oi]!;
        ni += 1;
        oi += 1;
      } else if (l.kind === 'old') oi += 1;
      else if (l.kind === 'new') ni += 1;
    }
    written = newLines(n, occ.tier, file[at]!, o[0]!);
    atEnd = at + o.length === file.length;
  } else {
    start = Math.min(hunk.oldStart + d, file.length);
    count = 0;
    written = n.map((l) => l.text);
    atEnd = start === file.length;
  }
  const out = [...file.slice(0, start), ...written, ...file.slice(start + count)];
  const endBreak = atEnd ? !noNewBreak : final;
  return out.length === 0 ? '' : out.join(br) + (endBreak ? br : '');
}

/**
 * SPEC.md section 6: all of a section's hunks applied in order to a file's text, or null
 * when any hunk cannot be applied (the section then changes nothing). Each hunk is applied
 * with applyHunk to the result of the ones before it, with `d` the sum over the hunks
 * applied so far of (N's length minus O's length), starting at zero: N is the hunk's
 * context and `+` lines, O its context and `-` lines.
 */
function applySection(section: Section, text: string, strict: boolean): string | null {
  let result = text;
  let d = 0;
  for (const hunk of section.hunks) {
    const next = applyHunk(hunk, result, d, strict);
    if (next === null) return null;
    result = next;
    for (const l of hunk.body) {
      if (l.kind === 'context' || l.kind === 'old') d -= 1;
      if (l.kind === 'context' || l.kind === 'new') d += 1;
    }
  }
  return result;
}

function sectionEdits(sections: Section[], strict: boolean): Edit[] {
  return sections.map((section) => {
    const oldPath = section.header.oldPath;
    const newPath = section.header.newPath;
    return (tree) => {
      if (oldPath === null) {
        const p = newPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const out = applySection(section, '', strict);
        if (out === null) throw new Fail('no-match', p);
        tree.now.set(p, out);
      } else if (newPath === null) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        const text = tree.get(oldPath);
        if (text === null) throw new Fail('missing', oldPath);
        if (applySection(section, text, strict) !== '') throw new Fail('no-match', oldPath);
        tree.now.set(oldPath, null);
      } else if (oldPath !== newPath) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const text = tree.get(oldPath);
        if (text === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out = applySection(section, text, strict);
        if (out === null) throw new Fail('no-match', oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
      } else {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        const text = tree.get(oldPath);
        if (text === null) throw new Fail('missing', oldPath);
        const out = applySection(section, text, strict);
        if (out === null) throw new Fail('no-match', oldPath);
        tree.now.set(oldPath, out);
      }
    };
  });
}

/** One SEARCH/REPLACE block (SPEC.md section 7): the path and the old and new lines of one edit. */
type Block = { path: string; oldLines: string[]; newLines: string[] };

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let after = 0; // the line after the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${i + 1}`);
    if (l.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${i + 1}`);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${i + 1}`);
      k += 1;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let p = i - 1; p >= after; p -= 1) {
      const pl = lines[p]!;
      if (!blank(pl) && !pl.trim().startsWith('```')) {
        path = pl.trim();
        break;
      }
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${i + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    blocks.push({ path, oldLines: lines.slice(i + 1, j), newLines: lines.slice(j + 1, k) });
    after = k + 1;
    i = k + 1;
  }
  return blocks;
}

/**
 * SPEC.md section 7: the blocks of a SEARCH/REPLACE patch as the edits the tool applies, one per
 * block, in patch order. Each edit checks its path for safety first (section 3). A block with no
 * old lines creates the file with its new lines joined by line breaks plus a final one, and fails
 * `exists` when the path is already there. Otherwise the file must exist (else `missing`), and
 * the old lines must occur at their tier of section 5 exactly once: findOccurrence gives the
 * tier, the occurrences at that tier are counted, none is `no-match` and more than one is
 * `ambiguous`; the matched lines are replaced by the new lines built with newLines at that tier,
 * keeping the file's own line break and final break. A failed edit throws before it touches the
 * tree, so it changes nothing.
 */
function blockEdits(blocks: Block[], strict: boolean): Edit[] {
  return blocks.map((block) => {
    const p = block.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (block.oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, block.newLines.join('\n') + '\n');
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const nl = text.indexOf('\n');
      const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
      const file = text === '' ? [] : text.split(br);
      const final = text !== '' && text.endsWith(br);
      if (final) file.pop();
      const occ = findOccurrence(block.oldLines, file, strict);
      const trims: ((s: string) => string)[] = [
        (s) => s,
        (s) => s.replace(/[ \t]+$/, ''),
        (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
      ];
      const trim = trims[occ?.tier ?? 0]!;
      const oldLines = block.oldLines.map(trim);
      const fileLines = file.map(trim);
      let count = 0;
      for (let at = 0; at + oldLines.length <= fileLines.length; at += 1) {
        if (oldLines.every((l, k) => fileLines[at + k] === l)) count += 1;
      }
      if (occ === null || count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const written = newLines(block.newLines.map((l) => ({ text: l })), occ.tier, file[occ.at]!, block.oldLines[0]!);
      const out = [...file.slice(0, occ.at), ...written, ...file.slice(occ.at + block.oldLines.length)];
      tree.now.set(p, out.length === 0 ? '' : out.join(br) + (final ? br : ''));
    };
  });
}

/** One chunk of a V4A update section (SPEC.md section 8): the anchor line list (empty when the chunk has no anchor), the body lines after it, and whether the chunk is anchored to the end of the file. */
type Chunk = { anchor: string[]; body: string[]; endOfFile: boolean };

/** One V4A file section (SPEC.md section 8): the path, whether it is an add, a delete or an update, an optional move-to path, the new content lines of an add, and the chunks of an update. */
type FileOp = { path: string; kind: 'add' | 'delete' | 'update'; moveTo: string | null; addLines: string[]; chunks: Chunk[] };

function parseChunk(lines: string[], at: number): { chunk: Chunk; next: number } {
  const anchored = lines[at]!.startsWith('@@');
  const anchor = anchored ? [lines[at]!.slice(2).trim()] : [];
  const body: string[] = [];
  let endOfFile = false;
  let next = anchored ? at + 1 : at;
  for (let i = next; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('@@') || l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ') || l.trim() === '*** End Patch') break;
    if (l === '*** End of File') {
      endOfFile = true;
      next = i + 1;
      break;
    }
    body.push(l);
    next = i + 1;
  }
  while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
  return { chunk: { anchor, body, endOfFile }, next };
}

/**
 * SPEC.md section 8: a V4A patch split into its file sections, in patch order. The first non-blank line must be
 * `*** Begin Patch` and the last `*** End Patch` (both with surrounding whitespace removed); a wrong first one is
 * `error: parse <its line>` (`error: parse 1` when there is none), a wrong last one `error: parse <patch lines + 1>`.
 * Sections start at `*** Add File: `, `*** Delete File: ` and `*** Update File: ` lines, blanks between sections
 * ignored, any other line `error: parse <its line>`. Add lines are `+` lines or empty, and blanks at the end of a
 * section are not part of it; a Delete File section has no lines, so the next line after it (blanks ignored) must be a
 * section header or `*** End Patch`; an Update File section may start with `*** Move to: `, then chunks from
 * parseChunk, and one with no chunk and no move-to is `error: parse <its line>`. A path is the text after its marker,
 * surrounding spaces removed.
 */
function parseV4A(lines: string[]): FileOp[] {
  const ADD = '*** Add File: ', DEL = '*** Delete File: ', UPD = '*** Update File: ', MOV = '*** Move to: ';
  let first = -1, last = -1;
  for (let k = 0; k < lines.length; k += 1) if (!blank(lines[k]!)) { if (first < 0) first = k; last = k; }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const ops: FileOp[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    if (l.startsWith(ADD)) {
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !(lines[j]!.startsWith(ADD) || lines[j]!.startsWith(DEL) || lines[j]!.startsWith(UPD))) {
        const bl = lines[j]!;
        if (!bl.startsWith('+') && !blank(bl)) throw new Exit2(`error: parse ${j + 1}`);
        raw.push(bl);
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const addLines: string[] = [];
      for (const bl of raw) addLines.push(bl.startsWith('+') ? bl.slice(1) : '');
      ops.push({ path: l.slice(ADD.length).trim(), kind: 'add', moveTo: null, addLines, chunks: [] });
      i = j;
    } else if (l.startsWith(DEL)) {
      let k = i + 1;
      while (k < last && blank(lines[k]!)) k += 1;
      if (k < last && !(lines[k]!.startsWith(ADD) || lines[k]!.startsWith(DEL) || lines[k]!.startsWith(UPD))) throw new Exit2(`error: parse ${k + 1}`);
      ops.push({ path: l.slice(DEL.length).trim(), kind: 'delete', moveTo: null, addLines: [], chunks: [] });
      i += 1;
    } else if (l.startsWith(UPD)) {
      let moveTo: string | null = null;
      let j = i + 1;
      if (j < last && lines[j]!.startsWith(MOV)) { moveTo = lines[j]!.slice(MOV.length).trim(); j += 1; }
      const chunks: Chunk[] = [];
      while (j < last && !(lines[j]!.startsWith(ADD) || lines[j]!.startsWith(DEL) || lines[j]!.startsWith(UPD))) {
        const r = parseChunk(lines, j);
        chunks.push(r.chunk);
        j = r.next;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      ops.push({ path: l.slice(UPD.length).trim(), kind: 'update', moveTo, addLines: [], chunks });
      i = j;
    } else throw new Exit2(`error: parse ${i + 1}`);
  }
  return ops;
}


/**
 * SPEC.md section 8: the V4A file sections as the edits the tool applies, one per section, in patch
 * order. Each edit checks its paths for safety first (section 3), then applies its section. A failed
 * edit throws before it touches the tree, so it changes nothing.
 */
function fileOpEdits(ops: FileOp[], strict: boolean): Edit[] {
  return ops.map((op) => (tree) => {
    if (op.kind === 'add') {
      if (!safe(op.path)) throw new Fail('unsafe', op.path);
      if (tree.get(op.path) !== null) throw new Fail('exists', op.path);
      tree.now.set(op.path, op.addLines.join('\n') + '\n');
      return;
    }
    if (op.kind === 'delete') {
      if (!safe(op.path)) throw new Fail('unsafe', op.path);
      if (tree.get(op.path) === null) throw new Fail('missing', op.path);
      tree.now.set(op.path, null);
      return;
    }
    if (!safe(op.path)) throw new Fail('unsafe', op.path);
    if (op.moveTo !== null && !safe(op.moveTo)) throw new Fail('unsafe', op.moveTo);
    const text = tree.get(op.path);
    if (text === null) throw new Fail('missing', op.path);
    if (op.moveTo !== null && tree.get(op.moveTo) !== null) throw new Fail('exists', op.moveTo);
    const nl = text.indexOf('\n');
    const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
    const file = text === '' ? [] : text.split(br);
    const final = text !== '' && text.endsWith(br);
    if (final) file.pop();
    let cursor = 0;
    for (const chunk of op.chunks) {
      const anchor = chunk.anchor.join('');
      if (anchor !== '') {
        const a = findOccurrence([anchor], file.slice(cursor), strict);
        if (a === null) throw new Fail('no-match', op.path);
        cursor += a.at + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      chunk.body.forEach((l) => {
        if (l.startsWith(' ') || l === '') {
          o.push(l === '' ? '' : l.slice(1));
          n.push({ text: l === '' ? '' : l.slice(1), context: true });
        } else if (l.startsWith('-')) o.push(l.slice(1));
        else if (l.startsWith('+')) n.push({ text: l.slice(1) });
      });
      if (o.length > 0) {
        let at = -1, tier = 0;
        if (chunk.endOfFile) {
          const pos = file.length - o.length;
          if (pos >= cursor) {
            const occ = findOccurrence(o, file.slice(pos), strict);
            if (occ !== null) { at = pos + occ.at; tier = occ.tier; }
          }
        } else {
          const occ = findOccurrence(o, file.slice(cursor), strict);
          if (occ !== null) { at = cursor + occ.at; tier = occ.tier; }
        }
        if (at < 0) throw new Fail('no-match', op.path);
        let oi = 0, ni = 0;
        for (const l of chunk.body) {
          if (l.startsWith(' ') || l === '') { n[ni]!.text = file[at + oi]!; ni += 1; oi += 1; }
          else if (l.startsWith('-')) oi += 1;
          else if (l.startsWith('+')) ni += 1;
        }
        const written = newLines(n, tier, file[at]!, o[0]!);
        file.splice(at, o.length, ...written);
        cursor = at + n.length;
      } else {
        const insertAt = chunk.endOfFile ? file.length : cursor;
        file.splice(insertAt, 0, ...n.map((l) => l.text));
        cursor = insertAt + n.length;
      }
    }
    const endBreak = final;
    const out = file.length === 0 ? '' : file.join(br) + (endBreak ? br : '');
    tree.now.set(op.path, op.moveTo === null ? out : null);
    if (op.moveTo !== null) tree.now.set(op.moveTo, out);
  });
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
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? sectionEdits(parseSections(lines), strict) : kind === 'search-replace' ? blockEdits(parseBlocks(lines), strict) : kind === 'v4a' ? fileOpEdits(parseV4A(lines), strict) : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves = new Map<string, string>();
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
      let from: string | null = null;
      let to: string | null = null;
      for (const [p, v] of tree.now) {
        const b = before.has(p) ? before.get(p)! : tree.original(p);
        if (v === b) continue;
        if (v === null) from = p;
        else if (b === null) to = p;
      }
      if (from !== null && to !== null) moves.set(to, from);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const movedFrom = new Set(moves.values());
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const from = moves.get(p);
    if (from !== undefined) rows.push({ key: p, line: `R ${from} -> ${p}` });
    else if (!movedFrom.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
