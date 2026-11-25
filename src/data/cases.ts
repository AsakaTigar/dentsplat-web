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
  modality: 'IOS 口内扫描' | 'CBCT 锥形束 CT' | '修复体扫描';
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
  { id: 1, key: 'enamel', cn: '牙冠釉质', en: 'Enamel', color: '#eee8d8', alpha: 1 },
  { id: 0, key: 'gingiva', cn: '牙龈组织', en: 'Gingiva', color: '#c66c70', alpha: 1 },
  { id: 2, key: 'root', cn: '牙根 / 牙本质', en: 'Dentine', color: '#e2d6be', alpha: 1 },
  { id: 8, key: 'restoration', cn: '修复体', en: 'Restoration', color: '#bac4ce', alpha: 1 },
];

const CBCT_LAYERS: LayerSpec[] = [
  { id: 3, key: 'alveolar', cn: '牙槽骨（上下颌）', en: 'Alveolar Bone', color: '#cec4b0', alpha: 0.34, note: '半透明骨皮质外壳' },
  { id: 1, key: 'teeth', cn: '全口牙体与牙根', en: 'Teeth & Roots', color: '#eee8d8', alpha: 1 },
  { id: 4, key: 'nerve', cn: '下牙槽神经管', en: 'IAN Canal', color: '#facc3c', alpha: 1, note: '智齿根尖关系判定层' },
  { id: 7, key: 'sinus', cn: '上颌窦腔', en: 'Maxillary Sinus', color: '#78a0d2', alpha: 0.32 },
];

const LOWER_PRESETS: ViewPreset[] = [
  { id: 'frontal', label: '正中位', sub: 'Frontal', theta: 0, phi: 22, radius: 135 },
  { id: 'left', label: '左侧位', sub: 'Left', theta: 85, phi: 12, radius: 132 },
  { id: 'right', label: '右侧位', sub: 'Right', theta: -85, phi: 12, radius: 132 },
  { id: 'lower', label: '牙合面俯视', sub: 'Occlusal', theta: 0, phi: 78, radius: 108 },
];

const UPPER_PRESETS: ViewPreset[] = [
  { id: 'frontal', label: '正中位', sub: 'Frontal', theta: 0, phi: -18, radius: 128 },
  { id: 'left', label: '左侧位', sub: 'Left', theta: 85, phi: 6, radius: 126 },
  { id: 'right', label: '右侧位', sub: 'Right', theta: -85, phi: 6, radius: 126 },
  { id: 'upper', label: '腭侧仰视', sub: 'Palatal', theta: 0, phi: -78, radius: 104 },
];

const CBCT_PRESETS: ViewPreset[] = [
  { id: 'frontal', label: '正中咬合位', sub: 'Frontal', theta: 0, phi: 9, radius: 148, target: [0, -1, 12] },
  { id: 'left', label: '左侧位', sub: 'Left', theta: 88, phi: 6, radius: 148, target: [0, -1, 12] },
  { id: 'right', label: '右侧位', sub: 'Right', theta: -88, phi: 6, radius: 148, target: [0, -1, 12] },
  { id: 'upper', label: '上颌牙合面', sub: 'Upper', theta: 0, phi: 82, radius: 118, target: [0, -1, 12] },
  { id: 'lower', label: '下颌牙合面', sub: 'Lower', theta: 0, phi: -82, radius: 118, target: [0, -1, 12] },
  { id: 'ian', label: '38–神经管关系', sub: 'IAN Canal', theta: -50, phi: -14, radius: 90, target: [30, -9, -9] },
];

const CBCT_COHORT_PRESETS: ViewPreset[] = [
  { id: 'frontal', label: '正中咬合位', sub: 'Frontal', theta: 0, phi: 9, radius: 158, target: [0, 0, 2] },
  { id: 'left', label: '左侧位', sub: 'Left', theta: 88, phi: 6, radius: 158, target: [0, 0, 2] },
  { id: 'right', label: '右侧位', sub: 'Right', theta: -88, phi: 6, radius: 158, target: [0, 0, 2] },
  { id: 'upper', label: '上颌牙合面', sub: 'Upper', theta: 0, phi: 82, radius: 128, target: [0, 0, 2] },
  { id: 'lower', label: '下颌牙合面', sub: 'Lower', theta: 0, phi: -82, radius: 128, target: [0, 0, 2] },
  { id: 'ian', label: '下颌后牙–神经管', sub: 'IAN Canal', theta: -50, phi: -14, radius: 138, target: [0, -2, -4] },
];

const POSEIDON_URL = 'https://zenodo.org/records/15608906';
const DENTVOXEL_URL =
  'https://figshare.com/articles/dataset/DentVoxel_a_fully_annotated_dental_CBCT_dataset_with_38_instance_anatomical_structures/31239889';

export const CASES: CaseSpec[] = [
  {
    id: 'A2',
    code: 'Case 01',
    shortTitle: '下颌口扫 · Brush 3DGS 训练版',
    nav: '01 下颌 · 3DGS',
    tag: 'Trained 3DGS',
    cohort: 'ios',
    badge: 'REAL IOS · TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D 真实下颌口扫 · Brush 3DGS',
    modality: 'IOS 口内扫描',
    dataset: 'Poseidon3D case 000125 (Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: POSEIDON_URL,
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '真实口扫网格（190,724 面）经 Blender 120 视角渲染后，在 RTX 5070 Ti 上用 Brush 训练 15,000 步，得到 28,691 个各向异性高斯（SH1）。' +
      'FDI 牙位从采样包迁移（1.0 mm 内命中 99.5%）；坐标绕 Y 轴修正 -90° 后，l=1 系数按 (c0,c1,c2) -> (c0,-c2,c1) 同步旋转。',
    moneyShot: '点击任意牙齿或牙位图聚焦；拖动底部 Pruned 比较 3× 压缩后的形态。',
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
    shortTitle: '上颌牙列与腭穹窿 · Brush 3DGS',
    nav: '02 上颌 · 3DGS',
    tag: 'Trained 3DGS',
    cohort: 'ios',
    badge: 'REAL MAXILLA · TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D 真实上颌口扫 · Brush 3DGS',
    modality: 'IOS 口内扫描',
    dataset: 'Poseidon3D case 000122 (ortho23-000337, Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: POSEIDON_URL,
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '另一例独立的真实上颌扫描（88 例上颌病例之一，标注文件名为 ortho23，属正畸病例）：完整腭穹窿、腭皱襞与牙列。' +
      '同一套 Blender 120 视角 → Brush 15,000 步 → 帧变换（含 SH1 旋转）→ DSPK 流程，与下颌病例没有共享任何几何。',
    moneyShot: '从下方牙合面视角看腭穹窿与腭皱襞；与 Case 01 下颌病例并排切换即可看出是两口不同的扫描。',
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
    shortTitle: '全口 CBCT · 四层贴面高斯 (0095)',
    nav: '03 CBCT 透视',
    tag: 'CBCT Surfel',
    cohort: 'cbct',
    badge: 'REAL CBCT · CC BY 4.0',
    title: 'DentVoxel 真实患者 CBCT · 解剖贴面高斯',
    modality: 'CBCT 锥形束 CT',
    dataset: 'DentVoxel v4 Case 0095 (440×440×344, 0.3 mm, CC BY 4.0)',
    datasetUrl: DENTVOXEL_URL,
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '牙槽骨、牙体牙根、下牙槽神经管与上颌窦四层等值面，法线对齐生成 111,000 个贴面高斯（s3 = 0.2 s1），烘焙三点医学光照与曲率 AO。' +
      '这是三例真实 CBCT 体数据中的第一例：含上下颌，下颌铰链只在这类体数据上出现，单颌口扫不提供张口。',
    moneyShot: '调低牙槽骨透明度，或点 38–神经管特写，直视阻生智齿牙根与神经管的真实空间关系。',
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
    shortTitle: '修复前扫描 · 牙冠与扫描杆',
    nav: '04 修复体',
    tag: 'Trained 3DGS',
    cohort: 'ios',
    badge: 'REAL PROSTHETIC SCAN · CC BY 4.0',
    title: 'ProsthoObjects3D 全瓷修复体扫描 · Brush 3DGS',
    modality: '修复体扫描',
    dataset: 'ProsthoObjects3D scan 608 (Zenodo 18488594) · 12 个冠/扫描杆',
    datasetUrl: 'https://zenodo.org/records/18488594',
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '同一批数据里的另一类真实对象：一例上颌固定修复扫描（905,782 面）。12 个修复体按厂商 JSON 包围盒 + 临床 CSV 标注到 FDI，' +
      '其余为软组织；Blender 以同一套高光釉质/牙龈材质渲染 120 视角，再训练 15,000 步。',
    moneyShot: '绕到侧位看全瓷冠与扫描杆的镜面高光如何随视角移动；与 Case 01/02 的自然牙列对照。',
    fullUrl: asset('scene_crown_full.dspk'),
    prunedUrl: asset('scene_crown_pruned.dspk'),
    proxyUrl: asset('proxy_P.glb'),
    metaUrl: asset('meta_P.json'),
    sceneKey: 'sceneP_crown',
    layers: IOS_LAYERS,
    presets: [
      { id: 'frontal', label: '正中位', sub: 'Frontal', theta: 0, phi: -12, radius: 118 },
      { id: 'right', label: '右侧位', sub: 'Right', theta: -72, phi: 4, radius: 112 },
      { id: 'upper', label: '牙合面仰视', sub: 'Occlusal', theta: 0, phi: -72, radius: 100 },
    ],
  },
  {
    id: 'C05',
    code: 'Case 05',
    shortTitle: '下颌牙列样本 #2 · Brush 3DGS',
    nav: '05 下颌 · 样本 2',
    tag: 'Trained 3DGS',
    cohort: 'ios',
    badge: 'REAL IOS · TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D case 000113 真实下颌口扫 · Brush 3DGS',
    modality: 'IOS 口内扫描',
    dataset: 'Poseidon3D case 000113 (Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: POSEIDON_URL,
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '与 Case 01 不同的真实下颌个体：同一套 Blender 120 视角 → Brush 15,000 步 → 帧变换 → DSPK 流程，牙位标签由同源 0.35 mm 采样包在 1.0 mm 内迁移。',
    moneyShot: '旋转比较牙弓形态与磨牙咬合面细节；点选牙位验证不同个体上的 FDI 绑定仍然对齐。',
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
    shortTitle: '上颌牙列样本 #2 · Brush 3DGS',
    nav: '06 上颌 · 样本 2',
    tag: 'Trained 3DGS',
    cohort: 'ios',
    badge: 'REAL MAXILLA · TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D case 000114 真实上颌口扫 · Brush 3DGS',
    modality: 'IOS 口内扫描',
    dataset: 'Poseidon3D case 000114 (Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: POSEIDON_URL,
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '第二例独立真实上颌个体（与 Case 02 的 000122 不同病例）：完整腭侧软组织与牙列，经同一套 Brush 流程训练，牙位标签由同源采样包迁移。',
    moneyShot: '腭侧仰视检查腭皱襞与牙列过渡；与 Case 02 并排切换观察两名不同个体的上颌形态差异。',
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
    shortTitle: '下颌牙列样本 #3 · Brush 3DGS',
    nav: '07 下颌 · 样本 3',
    tag: 'Trained 3DGS',
    cohort: 'ios',
    badge: 'REAL IOS · TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D case 000178 真实下颌口扫 · Brush 3DGS',
    modality: 'IOS 口内扫描',
    dataset: 'Poseidon3D case 000178 (Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: POSEIDON_URL,
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '第三例真实下颌个体，与 Case 01/05 不共享任何几何；同样记录 120 视角渲染、15,000 步 Brush 训练与 SH1 帧变换的完整链路。',
    moneyShot: '用 Full / Pruned 切换观察 3× 压缩在牙龈与牙尖边缘的保真差异。',
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
    shortTitle: 'CBCT #2 · 智齿与神经管',
    nav: '08 CBCT · 智齿',
    tag: 'CBCT Surfel',
    cohort: 'cbct',
    badge: 'REAL CBCT · CC BY 4.0',
    title: 'DentVoxel v4 case 0001 · 智齿与下牙槽神经管',
    modality: 'CBCT 锥形束 CT',
    dataset: 'DentVoxel v4 Case 0001 (440×440×344, 0.3 mm, CC BY 4.0)',
    datasetUrl: DENTVOXEL_URL,
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '第二例真实患者 CBCT：四层等值面重建成 111,000 个法线对齐贴面高斯，逐高斯 FDI 直接从 0.3 mm 标注体素回读。' +
      '该例同时存在 38/48 与双侧下颌神经管，适合检查阻生第三磨牙与神经管的相对位置。',
    moneyShot: '切换「下颌后牙–神经管」预设，调低骨透明度并打开冠状剖切，检查第三磨牙根尖与神经管。',
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
    shortTitle: 'CBCT #3 · 上颌窦与后牙区',
    nav: '09 CBCT · 上颌窦',
    tag: 'CBCT Surfel',
    cohort: 'cbct',
    badge: 'REAL CBCT · CC BY 4.0',
    title: 'DentVoxel v4 case 0069 · 上颌窦与后牙根尖区',
    modality: 'CBCT 锥形束 CT',
    dataset: 'DentVoxel v4 Case 0069 (440×440×344, 0.3 mm, CC BY 4.0)',
    datasetUrl: DENTVOXEL_URL,
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '第三例真实患者 CBCT，双侧上颌窦气化显著（标注体素约 236 万），窦腔等值面面积约 12,552 mm²。' +
      '上颌窦（L7）与牙槽骨（L3）、牙体（L1）分层独立编码，可实时调低骨透明度检查后牙根尖与窦底关系。',
    moneyShot: '关掉牙槽骨或把窦腔调到 55% 透明度，从侧位看后牙根尖与上颌窦底的空间关系。',
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
    shortTitle: 'Poseidon3D 0.35 mm 表面采样基线',
    nav: '10 采样基线',
    tag: 'Sampled IOS',
    cohort: 'ios',
    badge: 'SAMPLED BASELINE · CC BY 4.0',
    title: 'Poseidon3D case 000125 · 0.35 mm 表面采样基线',
    modality: 'IOS 口内扫描',
    dataset: 'Poseidon3D Case 000125 · 0.35 mm Surface Sample',
    datasetUrl: POSEIDON_URL,
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '与 Case 01 同源、但未经训练的 0.35 mm 表面采样对照组（59,808 个高斯，SH0）：几何来自真实口扫网格，' +
      '不经过 Brush 优化，用于把训练带来的高光、边缘与遮挡差异单独拿出来看。',
    moneyShot: '与 Case 01 来回切换：采样基线在牙尖高光与牙龈过渡处更平，训练版保留各向异性椭球细节。',
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
  'occlusal-caries': { cn: '咬合面龋', en: 'Occlusal caries', code: 'ICDAS 3' },
  'white-spot': { cn: '白斑脱矿', en: 'White spot lesion', code: 'ICDAS 1–2' },
  calculus: { cn: '牙石沉积', en: 'Calculus deposit', code: 'CPITN 2' },
  impaction: { cn: '近中阻生', en: 'Mesioangular impaction', code: 'Pell–Gregory B' },
};

export const AUDIT_BASIS = [
  {
    k: '物理坐标系契约',
    en: '1 unit = 1 mm',
    detail: '右手系 Y-up，1 unit = 1 mm；牙合平面大致平行 XZ，上颌 +Y。每个病例的代理网格与高斯共用同一世界坐标。',
    evidence: 'DSPK 头记录毫米包围盒；splat 与隐形代理共用世界坐标，测距以代理表面为参照。',
  },
  {
    k: '牙位级语义绑定',
    en: 'In-band FDI byte',
    detail: 'FDI 编号与解剖层代码直接编码在每个高斯的 misc 字节流内。',
    evidence: '旁挂标签受行数/manifest sha 闸保护；训练标签由同源采样包迁移，超距高斯保留 FDI 0 而不猜。',
  },
  {
    k: '着色器级解剖交互',
    en: 'GLSL clinical controls',
    detail: '三轴剖切、断面封顶、分层透视与牙位高亮在 GLSL 顶点/片元阶段执行。',
    evidence: '页面探针直接读取 uniform 与回读像素；不把未实测机型的 FPS 写成结论。',
  },
  {
    k: '压缩保真可复算',
    en: 'Live pixel readback',
    detail: 'Full 与 Pruned 同驻显存，可同帧分屏，并用浏览器像素回读计算 PSNR/MAE。',
    evidence: 'Scene B 28.04 / 27.20 dB；A2 31.04 / 26.37 dB；两者同包重渲染均逐比特一致。',
  },
];
