#!/usr/bin/env node
/** Inventory the aligned SH0 DSPK packets produced from every Stage-2 checkpoint. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'E:/dentsplat_work/stage2_packaged';
const OUT = 'tools/out/stage2/packaging_manifest.json';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const rows = [];
for (const [caseKey, dirName, labelReason] of [
  ['maxilla', 'maxilla_packaged', null],
  ['prostho601', 'prostho601_packaged', 'The published ProsthoObjects3D STL has no per-vertex FDI or semantic-layer sidecars; packet is aligned and packaged as unlabelled geometry (all FDI=0), not assigned invented tooth ids.'],
]) {
  const base = join(ROOT, dirName);
  for (const sub of readdirSync(base).sort()) {
    const m = /^(3dgs|2dgs)_step(\d+)$/.exec(sub); if (!m) continue;
    const d = join(base, sub), step = Number(m[2]);
    const dspk = join(d, `point_cloud_${step}.dspk`);
    const meta = JSON.parse(readFileSync(join(d, `point_cloud_${step}.json`), 'utf8'));
    const manPath = join(d, 'labels', 'labels_manifest.json');
    const man = existsSync(manPath) ? JSON.parse(readFileSync(manPath, 'utf8')) : null;
    rows.push({
      case: caseKey,
      method: m[1],
      step,
      dspk: dspk.split('\\').join('/'),
      sha256: sha(dspk),
      bytes: readFileSync(dspk).length,
      splats: meta.source.ply_vertices,
      sh_degree: 0,
      labels: man
        ? { status: 'transferred', assigned_fraction: man.assigned_fraction, assigned_mean_distance_mm: man.assigned_mean_distance_mm, fdi_histogram: man.fdi_histogram, reference_sha256: man.reference.source_face_labels_sha256 }
        : { status: 'not_available', reason: labelReason },
    });
  }
}
const doc = {
  schema: 'dentsplat-stage2-packaging-v1',
  generated_at: new Date().toISOString(),
  coordinate_pipeline: 'normalized gsplat PLY -> inverse COLMAP transform + R_y(-90) viewer PLY -> SH0 web PLY -> DSPK; labels were transferred in the original STL frame before packaging and kept in PLY row order',
  rows,
};
writeFileSync(OUT, JSON.stringify(doc, null, 2));
console.log(JSON.stringify({ out: OUT, packets: rows.length, labelled: rows.filter((r) => r.labels.status === 'transferred').length, unlabelled: rows.filter((r) => r.labels.status === 'not_available').length }, null, 2));