/**
 * tools/pickle_ints.mjs — read the int-only pickles Poseidon3D ships, without Python and without
 * executing anything.
 *
 * The dataset stores per-face region ids and a region->label map as Python pickles. Unpickling is
 * arbitrary code execution by design, so this file implements the opcode subset those files actually
 * use (verified with `python3 -m pickletools`) and refuses anything else. It is a reader, not a
 * runtime: BININT/BININT1/BININT2/LONG1, tuples, lists, APPENDS, memo, PROTO/FRAME/STOP. If a future
 * release uses GLOBAL or REDUCE, this throws instead of running it.
 *
 *   node tools/pickle_ints.mjs <file.pkl> [<file.pkl> ...]
 */
import { readFileSync } from 'node:fs';

const MAX_ITEMS = 5_000_000;

function unpickle(buf) {
  const stack = [];
  const memo = new Map();
  let mark = null;
  let i = 0;
  const need = (n) => { if (i + n > buf.length) throw new Error(`truncated at ${i}`); };
  const popToMark = () => {
    if (mark === null) throw new Error('popToMark without MARK');
    const items = stack.splice(mark);
    mark = null;
    return items;
  };
  for (;;) {
    need(1);
    const op = buf[i++];
    switch (op) {
      case 0x80: need(1); i += 1; break;                      // PROTO
      case 0x95: need(8); i += 8; break;                      // FRAME
      case 0x2e: return { value: stack.pop(), stack };         // STOP
      case 0x28: mark = stack.length; break;                   // MARK
      case 0x5d: stack.push([]); break;                        // EMPTY_LIST
      case 0x29: stack.push([]); break;                        // EMPTY_TUPLE (as array)
      case 0x71: need(1); memo.set(buf[i], stack[stack.length - 1]); i += 1; break;  // BINPUT
      case 0x72: need(4); memo.set(buf.readUInt32LE(i), stack[stack.length - 1]); i += 4; break;
      case 0x94: memo.set(memo.size, stack[stack.length - 1]); break;                // MEMOIZE
      case 0x68: need(1); stack.push(memo.get(buf[i])); i += 1; break;               // BINGET
      case 0x6a: need(4); stack.push(memo.get(buf.readUInt32LE(i))); i += 4; break;  // LONG_BINGET
      case 0x4b: need(1); stack.push(buf[i]); i += 1; break;                          // BININT1
      case 0x4d: need(2); stack.push(buf.readUInt16LE(i)); i += 2; break;             // BININT2
      case 0x4a: need(4); stack.push(buf.readInt32LE(i)); i += 4; break;              // BININT
      case 0x8a: { need(1); const n = buf[i]; i += 1; need(n); stack.push(readLong(buf, i, n)); i += n; break; }
      case 0x74: { const items = popToMark(); stack.push(items); break; }              // TUPLE
      case 0x85: { const a = stack.pop(); stack.push([a]); break; }                    // TUPLE1
      case 0x86: { const b = stack.pop(), a = stack.pop(); stack.push([a, b]); break; }// TUPLE2
      case 0x87: { const c = stack.pop(), b = stack.pop(), a = stack.pop(); stack.push([a, b, c]); break; }
      case 0x6c: { const items = popToMark(); stack.push(items); break; }              // LIST
      case 0x65: { const items = popToMark(); const top = stack.pop(); top.push(...items); stack.push(top); break; } // APPENDS
      case 0x47: need(8); stack.push(buf.readDoubleBE(i)); i += 8; break;              // BINFLOAT
      case 0x4e: stack.push(null); break;                                              // NONE
      case 0x88: stack.push(true); break;                                              // NEWTRUE
      case 0x89: stack.push(false); break;                                             // NEWFALSE
      case 0x58: { need(4); const n = buf.readUInt32LE(i); i += 4; need(n); stack.push(buf.toString('utf8', i, i + n)); i += n; break; } // BINUNICODE
      case 0x8c: { need(1); const n = buf[i]; i += 1; need(n); stack.push(buf.toString('utf8', i, i + n)); i += n; break; }             // SHORT_BINUNICODE
      case 0x62: stack.pop(); break;                                                   // BUILD
      default:
        throw new Error(`unsupported opcode 0x${op.toString(16)} at ${i - 1} -- refusing to guess`);
    }
    if (stack.length > MAX_ITEMS) throw new Error('runaway stack');
  }
}

function readLong(buf, off, n) {
  let v = 0;
  for (let k = 0; k < n; k++) v += buf[off + k] * 2 ** (8 * k);
  return v;
}

const main = () => {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node tools/pickle_ints.mjs <file.pkl> ...'); process.exit(2); }
  for (const f of files) {
    const { value } = unpickle(readFileSync(f));
    const name = f.split(/[\\/]/).pop();
    if (Array.isArray(value)) {
      const ints = value.filter((x) => Number.isInteger(x));
      const uniq = [...new Set(ints)].sort((a, b) => a - b);
      const counts = new Map();
      for (const x of ints) counts.set(x, (counts.get(x) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      console.log(`${name}: list n=${value.length} ints=${ints.length} domain=[${uniq[0]}..${uniq[uniq.length - 1]}] unique=${uniq.length}`);
      console.log(`  top: ${top.map(([k, v]) => `${k}:${v}`).join(' ')}`);
      console.log(`  head: ${JSON.stringify(value.slice(0, 16))}`);
    } else {
      console.log(`${name}: ${typeof value} ${JSON.stringify(value).slice(0, 300)}`);
    }
  }
};

main();
