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

export type CaseSpec = {
  id: string;
  nav: string;
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

export const CASES: CaseSpec[] = [
  {
    id: 'A2',
    nav: '01 下颌 · 3DGS',
    badge: 'REAL IOS · TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D 真实下颌口扫 · Brush 3DGS',
    modality: 'IOS 口内扫描',
    dataset: 'Poseidon3D case 000125 (Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: 'https://zenodo.org/records/15608906',
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
    presets: [
      { id: 'frontal', label: '正中位', sub: 'Frontal', theta: 0, phi: 22, radius: 135 },
      { id: 'left', label: '左侧位', sub: 'Left', theta: 85, phi: 12, radius: 132 },
      { id: 'right', label: '右侧位', sub: 'Right', theta: -85, phi: 12, radius: 132 },
      { id: 'lower', label: '牙合面俯视', sub: 'Occlusal', theta: 0, phi: 78, radius: 108 },
    ],
  },
  {
    id: 'U',
    nav: '02 上颌 · 3DGS',
    badge: 'REAL MAXILLA · TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D 真实上颌口扫 · Brush 3DGS',
    modality: 'IOS 口内扫描',
    dataset: 'Poseidon3D case 000122 (ortho23-000337, Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: 'https://zenodo.org/records/15608906',
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '另一例独立的真实上颌扫描（88 例上颌病例之一，标注文件名为 ortho23，属正畸病例）：完整腭穹窿、腭皱襞与牙列。' +
      '同一套 Blender 120 视角 → Brush 15,000 步 → 帧变换（含 SH1 旋转）→ DSPK 流程，与下颌病例没有共享任何几何。',
    moneyShot: '从下方牙合面视角看腭穹窿与腭皱襞；与 01 下颌病例并排切换即可看出是两口不同的扫描。',
    fullUrl: asset('scene_upper_full.dspk'),
    prunedUrl: asset('scene_upper_pruned.dspk'),
    proxyUrl: asset('proxy_U.glb'),
    metaUrl: asset('meta_U.json'),
    sceneKey: 'sceneU_upper',
    layers: IOS_LAYERS,
    presets: [
      { id: 'frontal', label: '正中位', sub: 'Frontal', theta: 0, phi: -18, radius: 128 },
      { id: 'left', label: '左侧位', sub: 'Left', theta: 85, phi: 6, radius: 126 },
      { id: 'right', label: '右侧位', sub: 'Right', theta: -85, phi: 6, radius: 126 },
      { id: 'upper', label: '腭侧仰视', sub: 'Palatal', theta: 0, phi: -78, radius: 104 },
    ],
  },
  {
    id: 'B',
    nav: '03 CBCT 透视',
    badge: 'REAL CBCT · CC BY 4.0',
    title: 'DentVoxel 真实患者 CBCT · 解剖贴面高斯',
    modality: 'CBCT 锥形束 CT',
    dataset: 'DentVoxel v4 Case 0095 (440×440×344, 0.3 mm, CC BY 4.0)',
    datasetUrl: 'https://figshare.com/articles/dataset/DentVoxel_a_fully_annotated_dental_CBCT_dataset_with_38_instance_anatomical_structures/31239889',
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '牙槽骨、牙体牙根、下牙槽神经管与上颌窦四层等值面，法线对齐生成 111,000 个贴面高斯（s3 = 0.2 s1），烘焙三点医学光照与曲率 AO。' +
      '这是唯一含上下颌的真实体数据：下颌铰链只在它上面出现，单颌口扫不提供张口。',
    moneyShot: '调低牙槽骨透明度，或点 38–神经管特写，直视阻生智齿牙根与神经管的真实空间关系。',
    fullUrl: asset('sceneB_dentvoxel_full.dspk'),
    prunedUrl: asset('sceneB_dentvoxel_pruned.dspk'),
    proxyUrl: asset('proxy_B_dentvoxel.glb'),
    metaUrl: asset('meta_B_dentvoxel.json'),
    sceneKey: 'sceneB_cbct',
    hasJaw: true,
    layers: CBCT_LAYERS,
    presets: [
      { id: 'frontal', label: '正中咬合位', sub: 'Frontal', theta: 0, phi: 9, radius: 148, target: [0, -1, 12] },
      { id: 'left', label: '左侧位', sub: 'Left', theta: 88, phi: 6, radius: 148, target: [0, -1, 12] },
      { id: 'right', label: '右侧位', sub: 'Right', theta: -88, phi: 6, radius: 148, target: [0, -1, 12] },
      { id: 'upper', label: '上颌牙合面', sub: 'Upper', theta: 0, phi: 82, radius: 118, target: [0, -1, 12] },
      { id: 'lower', label: '下颌牙合面', sub: 'Lower', theta: 0, phi: -82, radius: 118, target: [0, -1, 12] },
      { id: 'ian', label: '38–神经管关系', sub: 'IAN Canal', theta: -50, phi: -14, radius: 90, target: [30, -9, -9] },
    ],
  },
  {
    id: 'P',
    nav: '04 修复体',
    badge: 'REAL PROSTHETIC SCAN · CC BY 4.0',
    title: 'ProsthoObjects3D 全瓷修复体扫描 · Brush 3DGS',
    modality: '修复体扫描',
    dataset: 'ProsthoObjects3D scan 608 (Zenodo 18488594) · 12 个冠/扫描杆',
    datasetUrl: 'https://zenodo.org/records/18488594',
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '同一批数据里的另一类真实对象：一例上颌固定修复扫描（905,782 面）。12 个修复体按厂商 JSON 包围盒 + 临床 CSV 标注到 FDI，' +
      '其余为软组织；Blender 以同一套高光釉质/牙龈材质渲染 120 视角，再训练 15,000 步。',
    moneyShot: '绕到侧位看全瓷冠与扫描杆的镜面高光如何随视角移动；与 01/02 的自然牙列对照。',
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
    detail: '右手系 Y-up，牙合平面平行 XZ，上颌 +Y，唇侧 +Z，患者右侧 −X。',
    evidence: 'DSPK 头记录毫米包围盒；splat 与隐形代理共用世界坐标，测距以代理表面为参照。',
  },
  {
    k: '牙位级语义绑定',
    en: 'In-band FDI byte',
    detail: 'FDI 编号与解剖层代码直接编码在每个高斯的 misc 字节流内。',
    evidence: '旁挂标签受行数/manifest sha 闸保护；A2 训练标签由采样包迁移，1.0 mm 内命中 99.5%。',
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
