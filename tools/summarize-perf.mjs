// tools/summarize-perf.mjs — flatten the recorded perf sweeps into the table MEASUREMENTS.md uses.
//
// The captures in tools/out/perf-*.json are the raw probe payloads (4 resolutions x 2 instruments x
// 2 cases x 2 variants). Reading them by eye invites quoting the wrong row, so the summariser prints
// exactly the columns that get cited and refuses to invent any: a missing field prints as '-'.
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2).filter((f) => !f.startsWith('--'));
if (!files.length) { console.error('usage: node tools/summarize-perf.mjs tools/out/perf-*.json'); process.exit(2); }

const f = (x, d = '-') => (x === null || x === undefined ? d : x);
const s5 = (st) => (st ? `${f(st.p50)} (min ${f(st.min)} / p95 ${f(st.p95)})` : '-');

for (const file of files) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const r = raw.res ?? raw;
  const rows = r.res?.perf ?? r.perf ?? r.rows ?? [];
  const timer = r.res?.timer ?? r.timer ?? [];
  console.log(`\n== ${file}  job=${(raw.job ?? []).join('/')} wall=${raw.wallMs ?? '-'}ms probe=${(raw.sha ?? '-').slice(0, 12)}`);
  console.log(`   bundle=${(raw.bundle ?? ['-']).join(',')} dspk=${(raw.dspk ?? []).join(' ')}`);
  if (r.res?.fatal || r.fatal) console.log('   FATAL:', r.res?.fatal ?? r.fatal);
  console.log(`   canvas=${JSON.stringify((r.res ?? r).canvas ?? {})} selfTest=${JSON.stringify((r.res ?? r).selfTest ?? {})}`);
  console.log('   variant=' + f((r.res ?? r).variantNow) + ' gpu=' + f((r.res ?? r).gpu));
  console.log('   size      iters  serialMs p50            netGpuMs  fps      sortMs  painted  timer p50            got');
  for (const row of rows) {
    const t = timer.find((x) => x.w === row.w && x.h === row.h && x.tag === row.tag) ?? {};
    console.log('   ' +
      `${String(row.w + 'x' + row.h).padEnd(9)} ` +
      `${String(f(row.iters)).padEnd(6)} ` +
      `${s5(row.serialMs).padEnd(23)} ` +
      `${String(f(row.netGpuMs)).padEnd(9)} ` +
      `${String(f(row.fpsAtThisSize)).padEnd(8)} ` +
      `${String(f(row.sortMs)).padEnd(7)} ` +
      `${String(f(row.paintedFraction)).padEnd(8)} ` +
      `${s5(t.gpuMs).padEnd(20)} ` +
      `${f(t.got)}/${f(t.asked)}${t.unavailable ? ` unavail ${t.unavailable}` : ''}${t.disjoint ? ` disjoint ${t.disjoint}` : ''}`);
    if (row.glError) console.log('      glError after pass:', row.glError);
  }
  const methods = [...new Set(rows.map((x) => x.method))];
  methods.forEach((m) => console.log('   method: ' + m));
}
