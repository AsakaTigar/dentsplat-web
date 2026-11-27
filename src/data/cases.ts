import type { ViewPreset } from '../engine/Viewer.ts';

const asset = (file: string) => `${import.meta.env.BASE_URL}assets/${file}`;

export type LayerSpec = {
  id: number;
  key: string;
  cn: string;
  en: string;
  color: string;
  alpha: number;
  note?: string;
};

export type CaseTag = 'Trained 3DGS' | 'CBCT Surfel' | 'Sampled IOS';
export type CaseCohort = 'ios' | 'cbct';

export type CaseSpec = {
  id: string;
  code: string;
  shortTitle: string;
  nav: string;
  tag: CaseTag;
  cohort: CaseCohort;
  badge: string;
  title: string;
  modality: 'IOS intraoral scan' | 'CBCT cone-beam CT' | 'Prosthetic scan';
  dataset: string;
  datasetUrl: string;
  license: string;
  blurb: string;
  moneyShot: string;
  fullUrl: string;
  prunedUrl: string;
  proxyUrl: string;
  metaUrl: string;
  /** key in public/assets/report.json */
  sceneKey: string;
  /** only a two-jaw volume offers a hinge to open */
  hasJaw?: boolean;
  layers: LayerSpec[];
  presets: ViewPreset[];
};

const IOS_LAYERS: LayerSpec[] = [
  { id: 1, key: 'enamel', cn: 'Enamel', en: 'Enamel', color: '#eee8d8', alpha: 1 },
  { id: 0, key: 'gingiva', cn: 'Gingiva', en: 'Gingiva', color: '#c66c70', alpha: 1 },
  { id: 2, key: 'root', cn: 'Root / Dentine', en: 'Dentine', color: '#e2d6be', alpha: 1 },
  { id: 8, key: 'restoration', cn: 'Restoration', en: 'Restoration', color: '#bac4ce', alpha: 1 },
];

const CBCT_LAYERS: LayerSpec[] = [
  { id: 3, key: 'alveolar', cn: 'Alveolar Bone (Maxilla / Mandible)', en: 'Alveolar Bone', color: '#cec4b0', alpha: 0.34, note: 'Translucent cortical bone shell' },
  { id: 1, key: 'teeth', cn: 'Teeth & Roots', en: 'Teeth & Roots', color: '#eee8d8', alpha: 1 },
  { id: 4, key: 'nerve', cn: 'IAN Canal', en: 'IAN Canal', color: '#facc3c', alpha: 1, note: 'Layer for assessing third-molar root relationships' },
  { id: 7, key: 'sinus', cn: 'Maxillary Sinus', en: 'Maxillary Sinus', color: '#78a0d2', alpha: 0.32 },
];

const LOWER_PRESETS: ViewPreset[] = [
  { id: 'frontal', label: 'Frontal', sub: 'Frontal', theta: 0, phi: 22, radius: 135 },
  { id: 'left', label: 'Left lateral', sub: 'Left', theta: 85, phi: 12, radius: 132 },
  { id: 'right', label: 'Right lateral', sub: 'Right', theta: -85, phi: 12, radius: 132 },
  { id: 'lower', label: 'Occlusal view', sub: 'Occlusal', theta: 0, phi: 78, radius: 108 },
];

const UPPER_PRESETS: ViewPreset[] = [
  { id: 'frontal', label: 'Frontal', sub: 'Frontal', theta: 0, phi: -18, radius: 128 },
  { id: 'left', label: 'Left lateral', sub: 'Left', theta: 85, phi: 6, radius: 126 },
  { id: 'right', label: 'Right lateral', sub: 'Right', theta: -85, phi: 6, radius: 126 },
  { id: 'upper', label: 'Palatal view', sub: 'Palatal', theta: 0, phi: -78, radius: 104 },
];

const CBCT_PRESETS: ViewPreset[] = [
  { id: 'frontal', label: 'Centric occlusion', sub: 'Frontal', theta: 0, phi: 9, radius: 148, target: [0, -1, 12] },
  { id: 'left', label: 'Left lateral', sub: 'Left', theta: 88, phi: 6, radius: 148, target: [0, -1, 12] },
  { id: 'right', label: 'Right lateral', sub: 'Right', theta: -88, phi: 6, radius: 148, target: [0, -1, 12] },
  { id: 'upper', label: 'Maxillary occlusal', sub: 'Upper', theta: 0, phi: 82, radius: 118, target: [0, -1, 12] },
  { id: 'lower', label: 'Mandibular occlusal', sub: 'Lower', theta: 0, phi: -82, radius: 118, target: [0, -1, 12] },
  { id: 'ian', label: '38–IAN Canal', sub: 'IAN Canal View', theta: -50, phi: -14, radius: 90, target: [30, -9, -9] },
];

const CBCT_COHORT_PRESETS: ViewPreset[] = [
  { id: 'frontal', label: 'Centric occlusion', sub: 'Frontal', theta: 0, phi: 9, radius: 158, target: [0, 0, 2] },
  { id: 'left', label: 'Left lateral', sub: 'Left', theta: 88, phi: 6, radius: 158, target: [0, 0, 2] },
  { id: 'right', label: 'Right lateral', sub: 'Right', theta: -88, phi: 6, radius: 158, target: [0, 0, 2] },
  { id: 'upper', label: 'Maxillary occlusal', sub: 'Upper', theta: 0, phi: 82, radius: 128, target: [0, 0, 2] },
  { id: 'lower', label: 'Mandibular occlusal', sub: 'Lower', theta: 0, phi: -82, radius: 128, target: [0, 0, 2] },
  { id: 'ian', label: 'Posterior–IAN Canal', sub: 'IAN Canal View', theta: -50, phi: -14, radius: 138, target: [0, -2, -4] },
];

const POSEIDON_URL = 'https://zenodo.org/records/15608906';
const DENTVOXEL_URL =
  'https://figshare.com/articles/dataset/DentVoxel_a_fully_annotated_dental_CBCT_dataset_with_38_instance_anatomical_structures/31239889';

export const CASES: CaseSpec[] = [
  {
    id: 'A2',
    code: 'Case 01',
    shortTitle: 'Mandibular intraoral scan · Brush 3DGS',
    nav: '01 Mandible · 3DGS',
    tag: 'Trained 3DGS',
    cohort: 'ios',
    badge: 'REAL IOS · TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D real mandibular intraoral scan · Brush 3DGS',
    modality: 'IOS intraoral scan',
    dataset: 'Poseidon3D case 000125 (Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: POSEIDON_URL,
    license: 'CC BY 4.0 · Attribution, adaptation and redistribution permitted',
    blurb:
      'A 190,724-face intraoral scan mesh was rendered from 120 Blender views and trained for 15,000 steps with Brush on an RTX 5070 Ti, producing 28,691 anisotropic Gaussians (SH1).' +
      'FDI labels were transferred from the sampling packet (99.5% within 1.0 mm). After a -90° Y-axis correction, l=1 coefficients were rotated synchronously using (c0,c1,c2) -> (c0,-c2,c1).',
    moneyShot: 'Select any tooth or odontogram cell to focus; drag the Pruned split to compare morphology after 3× compression.',
    fullUrl: asset('sceneA_trained_full.dspk'),
    prunedUrl: asset('sceneA_trained_pruned.dspk'),
    proxyUrl: asset('proxy_A_poseidon.glb'),
    metaUrl: asset('meta_A_trained.json'),
    sceneKey: 'sceneA_trained',
    layers: IOS_LAYERS,
    presets: LOWER_PRESETS,
  },
  {
    id: 'U',
    code: 'Case 02',
    shortTitle: 'Maxillary dentition and palatal vault · Brush 3DGS',
    nav: '02 Maxilla · 3DGS',
    tag: 'Trained 3DGS',
    cohort: 'ios',
    badge: 'REAL MAXILLA · TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D real maxillary intraoral scan · Brush 3DGS',
    modality: 'IOS intraoral scan',
    dataset: 'Poseidon3D case 000122 (ortho23-000337, Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: POSEIDON_URL,
    license: 'CC BY 4.0 · Attribution, adaptation and redistribution permitted',
    blurb:
      'A separate real maxillary scan (one of 88 maxillary cases; annotation filename ortho23, an orthodontic case) includes the complete palatal vault, rugae and dentition.' +
      'It followed the same Blender 120-view → Brush 15,000-step → frame transform (including SH1 rotation) → DSPK pipeline and shares no geometry with the mandibular case.',
    moneyShot: 'Inspect the palatal vault and rugae from below; alternate with Case 01 to confirm two distinct scans.',
    fullUrl: asset('scene_upper_full.dspk'),
    prunedUrl: asset('scene_upper_pruned.dspk'),
    proxyUrl: asset('proxy_U.glb'),
    metaUrl: asset('meta_U.json'),
    sceneKey: 'sceneU_upper',
    layers: IOS_LAYERS,
    presets: UPPER_PRESETS,
  },
  {
    id: 'B',
    code: 'Case 03',
    shortTitle: 'Full-arch CBCT · four-layer surfels (0095)',
    nav: '03 CBCT sectional view',
    tag: 'CBCT Surfel',
    cohort: 'cbct',
    badge: 'REAL CBCT · CC BY 4.0',
    title: 'DentVoxel real patient CBCT · anatomical surfel Gaussians',
    modality: 'CBCT cone-beam CT',
    dataset: 'DentVoxel v4 Case 0095 (440×440×344, 0.3 mm, CC BY 4.0)',
    datasetUrl: DENTVOXEL_URL,
    license: 'CC BY 4.0 · Attribution, adaptation and redistribution permitted',
    blurb:
      'Four isosurfaces—alveolar bone, teeth/roots, IAN canal and maxillary sinus—generated 111,000 normal-aligned surfel Gaussians (s3 = 0.2 s1), with baked three-point medical lighting and curvature AO.' +
      'This first of three real CBCT volumes includes both jaws; mandibular hinge motion is available only for these volumes, not single-jaw intraoral scans.',
    moneyShot: 'Reduce alveolar bone opacity or open IAN Canal View to inspect the actual spatial relationship between impacted third-molar roots and the canal.',
    fullUrl: asset('sceneB_dentvoxel_full.dspk'),
    prunedUrl: asset('sceneB_dentvoxel_pruned.dspk'),
    proxyUrl: asset('proxy_B_dentvoxel.glb'),
    metaUrl: asset('meta_B_dentvoxel.json'),
    sceneKey: 'sceneB_cbct',
    hasJaw: true,
    layers: CBCT_LAYERS,
    presets: CBCT_PRESETS,
  },
  {
    id: 'P',
    code: 'Case 04',
    shortTitle: 'Pre-restoration scan · crowns and scan bodies',
    nav: '04 Prosthetics',
    tag: 'Trained 3DGS',
    cohort: 'ios',
    badge: 'REAL PROSTHETIC SCAN · CC BY 4.0',
    title: 'ProsthoObjects3D all-ceramic restoration scan · Brush 3DGS',
    modality: 'Prosthetic scan',
    dataset: 'ProsthoObjects3D scan 608 (Zenodo 18488594) · 12 crowns/scan bodies',
    datasetUrl: 'https://zenodo.org/records/18488594',
    license: 'CC BY 4.0 · Attribution, adaptation and redistribution permitted',
    blurb:
      'A maxillary fixed-prosthesis scan (905,782 faces) from the same dataset. Twelve restorations were mapped to FDI notation using manufacturer JSON bounding boxes and clinical CSV annotations; the remaining objects are soft tissue.' +
      'Blender rendered 120 views with the same glossy-enamel/gingival materials, followed by 15,000 training steps.',
    moneyShot: 'View from the side to see specular highlights move across all-ceramic crowns and scan bodies; compare with the natural dentition in Cases 01/02.',
    fullUrl: asset('scene_crown_full.dspk'),
    prunedUrl: asset('scene_crown_pruned.dspk'),
    proxyUrl: asset('proxy_P.glb'),
    metaUrl: asset('meta_P.json'),
    sceneKey: 'sceneP_crown',
    layers: IOS_LAYERS,
    presets: [
      { id: 'frontal', label: 'Frontal', sub: 'Frontal', theta: 0, phi: -12, radius: 118 },
      { id: 'right', label: 'Right lateral', sub: 'Right', theta: -72, phi: 4, radius: 112 },
      { id: 'upper', label: 'Occlusal view', sub: 'Occlusal', theta: 0, phi: -72, radius: 100 },
    ],
  },
  {
    id: 'C05',
    code: 'Case 05',
    shortTitle: 'Mandibular sample #2 · Brush 3DGS',
    nav: '05 Mandible · sample 2',
    tag: 'Trained 3DGS',
    cohort: 'ios',
    badge: 'REAL IOS · TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D case 000113 real mandibular intraoral scan · Brush 3DGS',
    modality: 'IOS intraoral scan',
    dataset: 'Poseidon3D case 000113 (Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: POSEIDON_URL,
    license: 'CC BY 4.0 · Attribution, adaptation and redistribution permitted',
    blurb:
      'A real mandibular patient distinct from Case 01, following the same Blender 120-view → Brush 15,000-step → frame transform → DSPK pipeline. FDI labels were transferred within 1.0 mm from the same-source 0.35 mm sampling packet.',
    moneyShot: 'Rotate to compare arch form and molar occlusal detail; select teeth to verify FDI binding across patients.',
    fullUrl: asset('scene_case05_full.dspk'),
    prunedUrl: asset('scene_case05_pruned.dspk'),
    proxyUrl: asset('proxy_case05.glb'),
    metaUrl: asset('meta_case05.json'),
    sceneKey: 'scene_case05',
    layers: IOS_LAYERS,
    presets: LOWER_PRESETS,
  },
  {
    id: 'C06',
    code: 'Case 06',
    shortTitle: 'Maxillary sample #2 · Brush 3DGS',
    nav: '06 Maxilla · sample 2',
    tag: 'Trained 3DGS',
    cohort: 'ios',
    badge: 'REAL MAXILLA · TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D case 000114 real maxillary intraoral scan · Brush 3DGS',
    modality: 'IOS intraoral scan',
    dataset: 'Poseidon3D case 000114 (Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: POSEIDON_URL,
    license: 'CC BY 4.0 · Attribution, adaptation and redistribution permitted',
    blurb:
      'A second independent real maxillary patient, distinct from Case 02 (000122), with complete palatal soft tissue and dentition. The same Brush pipeline was used, with FDI labels transferred from the same-source sampling packet.',
    moneyShot: 'Inspect the rugae-to-dentition transition from the palatal view; alternate with Case 02 to compare maxillary morphology across patients.',
    fullUrl: asset('scene_case06_full.dspk'),
    prunedUrl: asset('scene_case06_pruned.dspk'),
    proxyUrl: asset('proxy_case06.glb'),
    metaUrl: asset('meta_case06.json'),
    sceneKey: 'scene_case06',
    layers: IOS_LAYERS,
    presets: UPPER_PRESETS,
  },
  {
    id: 'C07',
    code: 'Case 07',
    shortTitle: 'Mandibular sample #3 · Brush 3DGS',
    nav: '07 Mandible · sample 3',
    tag: 'Trained 3DGS',
    cohort: 'ios',
    badge: 'REAL IOS · TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D case 000178 real mandibular intraoral scan · Brush 3DGS',
    modality: 'IOS intraoral scan',
    dataset: 'Poseidon3D case 000178 (Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: POSEIDON_URL,
    license: 'CC BY 4.0 · Attribution, adaptation and redistribution permitted',
    blurb:
      'A third real mandibular patient sharing no geometry with Cases 01/05. The complete chain of 120-view rendering, 15,000-step Brush training and SH1 frame transformation is documented.',
    moneyShot: 'Toggle Full / Pruned to assess fidelity at gingival and cusp edges after 3× compression.',
    fullUrl: asset('scene_case07_full.dspk'),
    prunedUrl: asset('scene_case07_pruned.dspk'),
    proxyUrl: asset('proxy_case07.glb'),
    metaUrl: asset('meta_case07.json'),
    sceneKey: 'scene_case07',
    layers: IOS_LAYERS,
    presets: LOWER_PRESETS,
  },
  {
    id: 'C08',
    code: 'Case 08',
    shortTitle: 'CBCT #2 · third molars and IAN canal',
    nav: '08 CBCT · third molars',
    tag: 'CBCT Surfel',
    cohort: 'cbct',
    badge: 'REAL CBCT · CC BY 4.0',
    title: 'DentVoxel v4 case 0001 · third molars and IAN canal',
    modality: 'CBCT cone-beam CT',
    dataset: 'DentVoxel v4 Case 0001 (440×440×344, 0.3 mm, CC BY 4.0)',
    datasetUrl: DENTVOXEL_URL,
    license: 'CC BY 4.0 · Attribution, adaptation and redistribution permitted',
    blurb:
      'A second real patient CBCT reconstructed from four isosurfaces into 111,000 normal-aligned surfel Gaussians. Per-Gaussian FDI labels are read directly from 0.3 mm annotated voxels.' +
      'Teeth 38/48 and bilateral mandibular canals are present, allowing inspection of impacted third molars relative to the canals.',
    moneyShot: 'Select the Posterior–IAN Canal preset, reduce bone opacity and enable a coronal section to inspect third-molar root apices and the canal.',
    fullUrl: asset('scene_case08_full.dspk'),
    prunedUrl: asset('scene_case08_pruned.dspk'),
    proxyUrl: asset('proxy_case08.glb'),
    metaUrl: asset('meta_case08.json'),
    sceneKey: 'scene_case08',
    hasJaw: true,
    layers: CBCT_LAYERS,
    presets: CBCT_COHORT_PRESETS,
  },
  {
    id: 'C09',
    code: 'Case 09',
    shortTitle: 'CBCT #3 · maxillary sinus and posterior region',
    nav: '09 CBCT · maxillary sinus',
    tag: 'CBCT Surfel',
    cohort: 'cbct',
    badge: 'REAL CBCT · CC BY 4.0',
    title: 'DentVoxel v4 case 0069 · maxillary sinus and posterior root apices',
    modality: 'CBCT cone-beam CT',
    dataset: 'DentVoxel v4 Case 0069 (440×440×344, 0.3 mm, CC BY 4.0)',
    datasetUrl: DENTVOXEL_URL,
    license: 'CC BY 4.0 · Attribution, adaptation and redistribution permitted',
    blurb:
      'A third real patient CBCT with marked bilateral maxillary sinus pneumatisation (approximately 2.36 million annotated voxels) and a sinus isosurface area of approximately 12,552 mm².' +
      'The maxillary sinus (L7), alveolar bone (L3) and teeth (L1) are independently layer-coded; reduce bone opacity in real time to inspect posterior root apices relative to the sinus floor.',
    moneyShot: 'Hide alveolar bone or set sinus opacity to 55%, then view from the side to inspect posterior root apices relative to the maxillary sinus floor.',
    fullUrl: asset('scene_case09_full.dspk'),
    prunedUrl: asset('scene_case09_pruned.dspk'),
    proxyUrl: asset('proxy_case09.glb'),
    metaUrl: asset('meta_case09.json'),
    sceneKey: 'scene_case09',
    hasJaw: true,
    layers: CBCT_LAYERS,
    presets: CBCT_COHORT_PRESETS,
  },
  {
    id: 'A',
    code: 'Case 10',
    shortTitle: 'Poseidon3D 0.35 mm surface-sampling baseline',
    nav: '10 Sampling baseline',
    tag: 'Sampled IOS',
    cohort: 'ios',
    badge: 'SAMPLED BASELINE · CC BY 4.0',
    title: 'Poseidon3D case 000125 · 0.35 mm surface-sampling baseline',
    modality: 'IOS intraoral scan',
    dataset: 'Poseidon3D Case 000125 · 0.35 mm Surface Sample',
    datasetUrl: POSEIDON_URL,
    license: 'CC BY 4.0 · Attribution, adaptation and redistribution permitted',
    blurb:
      'An untrained 0.35 mm surface-sampling control from the same source as Case 01 (59,808 Gaussians, SH0). Geometry comes from the real intraoral scan mesh without Brush optimisation,' +
      'isolating highlight, edge and occlusion differences attributable to training.',
    moneyShot: 'Alternate with Case 01: the sampling baseline has flatter cusp highlights and gingival transitions, while the trained version retains anisotropic ellipsoid detail.',
    fullUrl: asset('sceneA_poseidon_full.dspk'),
    prunedUrl: asset('sceneA_poseidon_pruned.dspk'),
    proxyUrl: asset('proxy_A_poseidon.glb'),
    metaUrl: asset('meta_A_poseidon.json'),
    sceneKey: 'sceneA_ios',
    layers: IOS_LAYERS,
    presets: LOWER_PRESETS,
  },
];

export const LESION_LABEL: Record<string, { cn: string; en: string; code: string }> = {
  'occlusal-caries': { cn: 'Occlusal caries', en: 'Occlusal caries', code: 'ICDAS 3' },
  'white-spot': { cn: 'White spot lesion', en: 'White spot lesion', code: 'ICDAS 1–2' },
  calculus: { cn: 'Calculus deposit', en: 'Calculus deposit', code: 'CPITN 2' },
  impaction: { cn: 'Mesioangular impaction', en: 'Mesioangular impaction', code: 'Pell–Gregory B' },
};

export const AUDIT_BASIS = [
  {
    k: 'Physical coordinate contract',
    en: '1 unit = 1 mm',
    detail: 'Right-handed, Y-up; 1 unit = 1 mm. The occlusal plane is approximately parallel to XZ, with the maxilla at +Y. Each case proxy mesh and its Gaussians share one world coordinate frame.',
    evidence: 'The DSPK header stores the millimetre bounding box; splats and the invisible proxy share world coordinates. Measurements reference the proxy surface.',
  },
  {
    k: 'Tooth-level semantic binding',
    en: 'In-band FDI byte',
    detail: 'FDI numbers and anatomical layer codes are encoded directly in each Gaussian misc byte stream.',
    evidence: 'Sidecar labels are gated by row count and manifest SHA. Training labels are transferred from the same-source sampling packet; out-of-radius Gaussians retain FDI 0 rather than being guessed.',
  },
  {
    k: 'Shader-level anatomical interaction',
    en: 'GLSL clinical controls',
    detail: 'Three-axis clipping, section caps, layered transparency and tooth highlighting execute in the GLSL vertex/fragment stages.',
    evidence: 'Page probes read uniforms and pixels directly; FPS is not asserted for untested hardware.',
  },
  {
    k: 'Recomputable compression fidelity',
    en: 'Live pixel readback',
    detail: 'Full and Pruned reside together in GPU memory for same-frame split comparison, with PSNR/MAE calculated from browser pixel readback.',
    evidence: 'Scene B 28.04 / 27.20 dB; A2 31.04 / 26.37 dB; repeated renders from the same packages are bit-identical.',
  },
];
