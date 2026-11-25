/**
 * test-pipeline.mjs — run the Python CBCT-route verifier with an interpreter that has the deps.
 *
 * The `python` on PATH here is a broken stub (it exits before importing anything), so
 * tools/verify_cbct_route.py -- the only thing that proves toothfairy2_to_layers.py still emits the
 * layer/FDI contract -- needs an explicit interpreter. Resolution order: $PIPELINE_PYTHON, the uv
 * venv this repo has been using, then plain `python`.
 *
 * It is deliberately NOT part of `npm run check`. A check that quietly skips when its dependency is
 * missing is how a green chain stops meaning anything, and this one needs numpy, scipy, plyfile and
 * a ~10 s fixture build. So run it on purpose and read its own summary line.
 *
 *   node tools/test-pipeline.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Git Bash writes /tmp/dspy; node does not resolve that, so rebuild it from $TMP (which is where the
// shell's /tmp actually lives on this machine) and keep the POSIX spelling for a real unix run.
const tmpVenv = process.env.TMP
  ? path.join(process.env.TMP, 'dspy', 'Scripts', 'python.exe') : null;
const candidates = [process.env.PIPELINE_PYTHON, tmpVenv, '/tmp/dspy/bin/python',
  '/tmp/dspy/Scripts/python.exe', 'python', 'python3'].filter(Boolean);

let chosen = null;
for (const c of candidates) {
  if (c.startsWith('/') && !existsSync(c)) continue;      // a POSIX-only venv path on Windows
  const probe = spawnSync(c, ['-c', 'import numpy, plyfile'], { encoding: 'utf8' });
  if (probe.status === 0) { chosen = c; break; }
  console.log(`  -- ${c}: ${String(probe.stderr || probe.error?.message || `exit ${probe.status}`).split('\n')[0]}`);
}
if (!chosen) {
  console.error('no interpreter with numpy+plyfile found -- set PIPELINE_PYTHON and re-run');
  process.exit(1);
}
console.log(`interpreter: ${chosen}`);
const r = spawnSync(chosen, [path.join(here, 'verify_cbct_route.py')], {
  cwd: path.join(here, '..'), stdio: 'inherit',
});
console.log(r.status === 0
  ? '\npipeline verifier passed; artefacts are in tools/out/cbct_route/web_assets/'
  : `\npipeline verifier exited ${r.status} -- read the FAIL lines above, do not paraphrase them`);
process.exit(r.status ?? 1);
