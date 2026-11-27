#!/usr/bin/env node
/**
 * Fold the Stage-2 cross-case runs into public/assets/training_benchmark.json.
 *
 * Inputs (all produced on the local RTX 5070 Ti WSL2 box):
 *   - tools/out/stage2/<case>_geometry.json  (exact BVH audit, see geometry-audit-crosscase.mjs)
 *   - E:/dentsplat_work/out_s2_<case>_{3dgs,2dgs}/metrics_curve.json
 *
 *   node tools/merge-crosscase-benchmark.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const WORK = 'E:/dentsplat_work';
const OUT = 'public/assets/training_benchmark.json';
const bench = JSON.parse(readFileSync(OUT, 'utf8'));

const summary = (curve) => {
  const final = curve.curve[curve.curve.length - 1];
  return {
    method: curve.method,
    split: curve.split,
    steps: curve.steps,
    curve: curve.curve,
    final_test_psnr: final.test_psnr,
    final_test_ssim: final.test_ssim,
    final_test_lpips: final.test_lpips,
    train_sec: final.train_sec,
    num_gaussians: final.num_gaussians,
  };
};

const checkpointGeometry = (caseKey, geomKey, step) => {
  const path = `tools/out/stage2/geometry_checkpoints/${caseKey}_${geomKey}_${step}.json`;
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const g = doc.methods[geomKey];
  return {
    cloud_to_mesh: g.cloud_to_mesh,
    mesh_to_cloud: g.mesh_to_cloud,
    fscore: g.fscore,
    normal_abs_dot: g.normal_abs_dot,
  };
};
const trainingWithGeometry = (curve, caseKey, geomKey) => {
  const t = summary(curve);
  return { ...t, curve: t.curve.map((p) => ({ ...p, geometry: checkpointGeometry(caseKey, geomKey, p.step) })) };
};

const cases = [
  {
    key: 'maxilla',
    case: 'Poseidon3D 000114 maxilla',
    source: 'Poseidon3D 000114_MODEL_maxilla.stl (real IOS scan geometry, CC BY 4.0)',
    render: '120 views / 1024 px, three elevation rings (-18°, +2°, +22°), synthetic height/facing material on the decimated (18%) mesh',
    geometryFile: 'tools/out/stage2/maxilla_geometry.json',
    runs: {
      'gsplat-3dgs-mcmc': { metrics: `${WORK}/out_s2_maxilla_3dgs/metrics_curve.json`, geomKey: '3dgs' },
      'gsplat-2dgs': { metrics: `${WORK}/out_s2_maxilla_2dgs/metrics_curve.json`, geomKey: '2dgs' },
    },
  },
  {
    key: 'prostho601',
    case: 'ProsthoObjects3D 601 prepared tooth + scan body',
    source: 'ProsthoObjects3D record 18488594, 601.stl (real scanned preparation, CC BY 4.0)',
    render: '120 views / 1024 px, three elevation rings (-18°, +2°, +22°), synthetic height/facing material on the decimated (18%) mesh',
    geometryFile: 'tools/out/stage2/prostho601_geometry.json',
    runs: {
      'gsplat-3dgs-mcmc': { metrics: `${WORK}/out_s2_prostho601_3dgs/metrics_curve.json`, geomKey: '3dgs' },
      'gsplat-2dgs': { metrics: `${WORK}/out_s2_prostho601_2dgs/metrics_curve.json`, geomKey: '2dgs' },
    },
  },
];

const out = [];
const packageManifest = JSON.parse(readFileSync('tools/out/stage2/packaging_manifest.json', 'utf8'));
for (const c of cases) {
  const geom = JSON.parse(readFileSync(c.geometryFile, 'utf8'));
  const methods = {};
  for (const [name, r] of Object.entries(c.runs)) {
    const curve = JSON.parse(readFileSync(r.metrics, 'utf8'));
    const g = geom.methods[r.geomKey];
    if (!g) throw new Error(`${c.key}: geometry has no ${r.geomKey}`);
    methods[name] = {
      label: name === 'gsplat-3dgs-mcmc' ? 'gsplat MCMC 3DGS' : 'gsplat 2DGS surfels',
      config: bench.methods[name].config,
      training: trainingWithGeometry(curve, c.key, r.geomKey),
      geometry: {
        cloud_to_mesh: g.cloud_to_mesh,
        mesh_to_cloud: g.mesh_to_cloud,
        fscore: g.fscore,
        normal_abs_dot: g.normal_abs_dot,
      },
    };
  }
  out.push({
    case: c.case,
    source: c.source,
    render: c.render,
    data: { views: 120, train_images: 105, test_images: 15, resolution: '1024x1024', protocol: 'test_every=8' },
    reference_mesh: {
      role: geom.mesh.role,
      triangles: geom.mesh.triangles,
      vertices: geom.mesh.vertices,
      sha256: geom.mesh.sha256,
    },
    methods,
    packaging: (() => {
      const packets = packageManifest.rows.filter((r) => r.case === c.key);
      const labelled = packets.every((r) => r.labels.status === 'transferred');
      return {
        status: labelled ? 'packaged_with_fdi_labels' : 'packaged_unlabelled',
        pipeline: packageManifest.coordinate_pipeline,
        packet_count: packets.length,
        packets,
        reason: c.key === 'maxilla'
          ? 'FDI labels transferred from Poseidon3D exported_case_ortho23_000272_REGIONS_FACES_QUADRANT_NUMBERING_before_model_trimming_maxilla.pkl (300k area samples, original STL frame, nearest labelled sample within 0.75 mm).'
          : 'ProsthoObjects3D 601 has no per-vertex FDI / semantic-layer sidecars; the packet is aligned and packaged as unlabelled geometry (all FDI=0), with no invented tooth ids.',
      };
    })(),
  });
}

bench.cross_case = {
  status: 'ran',
  protocol_note: 'Same recipe as the 000125 benchmark (MCMC 3DGS cap_max=80k, opacity_reg/scale_reg=0.01, sh_degree=3; 2DGS depth+normal+dist; 15k steps, test_every=8, 120 views at 1024 px). Appearance supervision is a synthetic height/facing render of the real scan geometry, not a patient photograph, so PSNR/SSIM/LPIPS are comparable across these cases but not to clinical photography.',
  results: out,
};
bench.generated_at = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(bench, null, 2));
console.log(JSON.stringify({
  out: OUT,
  cases: out.map((c) => ({
    case: c.case,
    '3dgs': { psnr: +c.methods['gsplat-3dgs-mcmc'].training.final_test_psnr.toFixed(2), n: c.methods['gsplat-3dgs-mcmc'].training.num_gaussians, c2m: c.methods['gsplat-3dgs-mcmc'].geometry.cloud_to_mesh.mean_mm },
    '2dgs': { psnr: +c.methods['gsplat-2dgs'].training.final_test_psnr.toFixed(2), n: c.methods['gsplat-2dgs'].training.num_gaussians, c2m: c.methods['gsplat-2dgs'].geometry.cloud_to_mesh.mean_mm },
  })),
}, null, 2));
