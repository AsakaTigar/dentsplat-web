// Summarise a bench capture (tools/out/bench-*.json) written by tools/pagefn-summarize.mjs.
// Lives on disk instead of `node -e` because the shell's double escaping mangles regexes and
// property accessors, which is how a previous check here produced a phantom diff.
const file = process.argv[2];
import { readFileSync } from 'node:fs';
if (!file) { console.error('usage: node tools/summarize-bench.mjs tools/out/bench-*.json'); process.exit(2); }
const raw = JSON.parse(readFileSync(file, 'utf8'));
const o = raw.res ?? raw;
const d = o.direct ?? {};
const c = d.control ?? {};
console.log(file);
console.log('  job        ', raw.job ? raw.job.join('/') : '-', '| wall', raw.wallMs ?? '-', 'ms | probe sha', (raw.sha ?? o.sha ?? '-').slice(0, 16));
console.log('  bundle     ', (raw.bundle ?? ['-']).join(','), '| dspk', (raw.dspk ?? ['-']).join(' '));
if (raw.ua) console.log('  ua         ', raw.ua);
console.log('  pruneMeta  ', raw.pruneMeta ? JSON.stringify(raw.pruneMeta) : '(not captured)');
console.log('  settled    ', o.settled, '| busy', o.busyAfter, '| agrees', o.agrees, '| frames', o.settleFrames);
console.log('  DOM row    ', o.after);
console.log('  full vs pruned  PSNR', d.psnr, 'dB | in-mask', d.psnrInMask, 'dB | MAE', d.mae,
  '| identical', d.identicalFraction, '| covered', d.covered, '| top1% err', d.errorInTop1Percent, '| maxDiff', d.maxDiff);
console.log('  mean RGB       full', JSON.stringify(d.meanFull), ' pruned', JSON.stringify(d.meanPruned));
console.log('  control (self)  PSNR', d.psnrSelf, '| identical', d.identicalSelfFraction, '| top1% err', c.errorInTop1Percent);
console.log('  stats          ', JSON.stringify(o.stats));
if (o.opaqueOnly) {
  console.log('  OPAQUE-ONLY (sub-surface layers hidden, both variants)');
  console.log('    PSNR', o.opaqueOnly.psnr, '| in-mask', o.opaqueOnly.psnrInMask, '| MAE', o.opaqueOnly.mae,
    '| covered', o.opaqueOnly.covered, '| identical', o.opaqueOnly.identicalFraction, '| self', o.opaqueOnly.psnrSelf);
  console.log('    hidden', JSON.stringify(o.layersHidden), '| restored', o.restoredMatchesPrev, '| all-layers row:', o.allLayers);
}
