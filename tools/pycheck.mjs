/**
 * pycheck.mjs — pre-flight lint for pipeline/*.py on a machine with no working Python.
 *
 * Why this exists: `python` here resolves to a venv whose base home (D:\Aodou) ships only
 * python311.dll + pythonw.exe and no Lib/encodings, so every invocation dies with
 * "Fatal Python error: init_fs_encoding". The pipeline scripts are therefore verified in two
 * steps: these text checks locally, and `python -m py_compile` + a real run on the server
 * (see pipeline/NOTES.md).
 *
 * These are HEURISTICS, not a parser. They catch the two failure modes that actually bit this
 * repo — an unbalanced bracket swallowing the rest of a function, and a call to a helper that
 * was renamed in one place only -- plus tabs/odd indents. They do NOT check block semantics.
 *
 *   node tools/pycheck.mjs pipeline/toothfairy2_to_layers.py pipeline/dental_lib.py
 */
import fs from 'fs';

const files = process.argv.slice(2).filter((f) => f.endsWith('.py'));
if (!files.length) {
  console.error('usage: node tools/pycheck.mjs path/to/script.py [...]');
  process.exit(2);
}

let failures = 0;

/**
 * Blank out comments and string literals, preserving every character position (newlines
 * included) so line numbers stay meaningful. Everything downstream then looks at real code
 * only, which is what stops English like "the value (see below)" inside a docstring from
 * being reported as an undefined call.
 */
function maskLiterals(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  const notes = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      const j = src.indexOf('\n', i);
      const end = j < 0 ? src.length : j;
      blank(i, end);
      i = end;
      continue;
    }
    const m = /^([rRbBuUfF]{0,3})('''|"""|'|")/.exec(src.slice(i));
    if (m) {
      const q = m[2];
      const raw = /[rR]/.test(m[1]);
      let j = i + m[0].length;
      const startLine = countLines(src, i);
      let closed = false;
      while (j < src.length) {
        if (!raw && src[j] === '\\') { j += 2; continue; }
        if (src.startsWith(q, j)) { closed = true; j += q.length; break; }
        j++;
      }
      // Blank the whole literal, quotes included -- leaving the body in place is what made
      // English inside a docstring ("the jawbone (1,2) labels") look like an undefined call.
      blank(i, closed ? j : src.length);
      if (!closed) notes.push(`line ${startLine}: ${q.length === 3 ? 'triple-quoted' : 'single-quoted'} string never closed`);
      i = closed ? j : src.length;
      continue;
    }
    i++;
  }
  return { code: out.join(''), notes };
}

const countLines = (s, upto) => {
  let n = 1;
  for (let k = 0; k < upto; k++) if (s[k] === '\n') n++;
  return n;
};

/* ------------------------------------------------------------- delimiters / balance */
function checkDelims(code, errs) {
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const lines = code.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    for (const c of lines[ln]) {
      if (c === '(' || c === '[' || c === '{') stack.push([c, ln + 1]);
      else if (c === ')' || c === ']' || c === '}') {
        const top = stack.pop();
        if (!top) errs.push(`line ${ln + 1}: unmatched closing '${c}'`);
        else if (top[0] !== pairs[c]) errs.push(`line ${ln + 1}: '${c}' closes '${top[0]}' opened at line ${top[1]}`);
      }
    }
  }
  for (const [op, ln] of stack) errs.push(`unclosed '${op}' opened at line ${ln}`);
}

/* ------------------------------------------------------- indentation / whitespace */
function checkLayout(code, errs) {
  const widths = new Set([0]);
  code.split('\n').forEach((ln, idx) => {
    if (ln.includes('\t')) errs.push(`line ${idx + 1}: tab in indentation (Python 3 forbids mixing)`);
    const m = /^([ ]*)\S/.exec(ln);
    if (m) widths.add(m[1].length);
  });
  code.split('\n').forEach((ln, idx) => {
    const m = /^([ ]*)\S/.exec(ln);
    if (m && !widths.has(m[1].length)) errs.push(`line ${idx + 1}: indent ${m[1].length} is unique to this line`);
  });
}

/* ------------------------------------------------------------- calls to undeclared names */
const BUILTINS = new Set(['print', 'len', 'range', 'int', 'float', 'str', 'bool', 'list', 'dict', 'set',
  'tuple', 'enumerate', 'zip', 'sorted', 'min', 'max', 'sum', 'abs', 'any', 'all', 'open', 'isinstance',
  'round', 'type', 'getattr', 'setattr', 'hasattr', 'repr', 'format', 'map', 'filter', 'next', 'reversed',
  'complex', 'bytes', 'bytearray', 'frozenset', 'divmod', 'pow', 'slice', 'id', 'hash', 'callable', 'iter',
  'exit', 'quit', 'vars', 'dir', 'globals', 'locals', 'ord', 'chr', 'bin', 'hex', 'oct', 'raise', 'super']);
// Keywords that only ever look like calls once strings are gone (they sit in type params etc.).
const KEYWORDS = new Set(['if', 'for', 'while', 'with', 'in', 'or', 'and', 'not', 'return', 'else', 'yield',
  'import', 'from', 'as', 'del', 'assert', 'lambda', 'pass', 'break', 'continue', 'try', 'except']);

function collectDefined(code) {
  const defined = new Set();
  for (const m of code.matchAll(/^\s*(?:def|class)\s+([A-Za-z_]\w*)/gm)) defined.add(m[1]);
  // `from x import (a, b,` ... `c)` -- the parenthesised form spans lines, so a single-line
  // capture reports nine "undefined" helpers in dental_pipeline_blender.py for no reason.
  for (const m of code.matchAll(/^[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm))
    for (const part of m[1].replace(/[()]/g, '').split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().replace(/[()]/g, '').trim();
      if (t) defined.add(t);
    }
  for (const m of code.matchAll(/^\s*import\s+([\w.]+)/gm)) defined.add(m[1].split('.')[0]);
  for (const m of code.matchAll(/^\s*([A-Za-z_]\w*)\s*(?::[^=\n]+)?=/gm)) defined.add(m[1]);
  for (const m of code.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\b/g)) defined.add(m[1]);
  for (const m of code.matchAll(/\bas\s+([A-Za-z_]\w*)\b/g)) defined.add(m[1]);
  for (const m of code.matchAll(/^\s*def\s+[A-Za-z_]\w*\s*\(([\s\S]*?)\)\s*(?:->[^:\n]*)?:/gm))
    for (const p of m[1].split(',')) {
      const t = p.trim().split(':')[0].split('=')[0].replace(/\*/g, '').trim();
      if (t && /^[A-Za-z_]\w*$/.test(t)) defined.add(t);
    }
  for (const m of code.matchAll(/^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)+)\s*=/gm))
    for (const p of m[1].split(',')) defined.add(p.trim());
  return defined;
}

function checkNames(code, errs) {
  const defined = collectDefined(code);
  const seen = new Map();
  code.split('\n').forEach((ln, idx) => {
    for (const m of ln.matchAll(/(?<![.\w])([a-z_][a-z0-9_]*)\s*\(/g)) {
      const n = m[1];
      if (defined.has(n) || BUILTINS.has(n) || KEYWORDS.has(n)) continue;
      if (!seen.has(n)) seen.set(n, []);
      if (seen.get(n).length < 3) seen.get(n).push(idx + 1);
    }
  });
  for (const [n, ls] of [...seen.entries()].sort())
    errs.push(`'${n}(...)' is called (lines ${ls.join(', ')}) but never defined or imported here`);
}

for (const f of files) {
  let src;
  try {
    src = fs.readFileSync(f, 'utf8');
  } catch (exc) {
    console.log(`READ-FAIL ${f}: ${exc.message}`);
    failures++;
    continue;
  }
  const { code, notes } = maskLiterals(src);
  const errs = [...notes];
  checkDelims(code, errs);
  checkLayout(code, errs);
  checkNames(code, errs);
  const uniq = [...new Set(errs)];
  if (uniq.length) {
    failures++;
    console.log(`FAIL ${f}`);
    uniq.slice(0, 14).forEach((e) => console.log(`   ${e}`));
    if (uniq.length > 14) console.log(`   ...and ${uniq.length - 14} more`);
  } else {
    console.log(`OK   ${f}  (${src.split('\n').length} lines, balanced + no dangling calls)`);
  }
}
process.exit(failures ? 1 : 0);
