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
  id: 'A' | 'A2' | 'B';
  nav: string;
  badge: string;
  title: string;
  modality: 'IOS 口内扫描' | 'CBCT 锥形束 CT';
  dataset: string;
  datasetUrl: string;
  license: string;
  blurb: string;
  moneyShot: string;
  fullUrl: string;
  prunedUrl: string;
  proxyUrl: string;
  metaUrl: string;
  layers: LayerSpec[];
  presets: ViewPreset[];
};

export const STANDARD_VIEWS: ViewPreset[] = [
  { id: 'frontal', label: '正中咬合位', sub: 'Frontal', theta: 0, phi: 14, radius: 145 },
  { id: 'left', label: '左侧位', sub: 'Left', theta: 88, phi: 8, radius: 142 },
  { id: 'right', label: '右侧位', sub: 'Right', theta: -88, phi: 8, radius: 142 },
  { id: 'upper', label: '上颌牙合面', sub: 'Upper', theta: 0, phi: 82, radius: 118 },
  { id: 'lower', label: '下颌牙合面', sub: 'Lower', theta: 0, phi: -82, radius: 118 },
];

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
    nav: 'Demo 1 · 训练版 IOS',
    badge: 'TRAINED 3DGS · CC BY 4.0',
    title: 'Poseidon3D 真实口扫 · Brush 3DGS 训练模型',
    modality: 'IOS 口内扫描',
    dataset: 'Poseidon3D Case 000125 (Zenodo 15608906) · Brush 0.3.0',
    datasetUrl: 'https://zenodo.org/records/15608906',
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '基于真实口扫网格（190,724 面）渲染 120 视角后，在 RTX 5070 Ti 上经 15,000 步优化得到的 28,691 个各向异性高斯椭球（0.79 MB）。' +
      '每颗高斯携带独立 FDI 牙位字节（1.0 mm 最近邻迁移命中率 99.5%），支持牙位点击高亮与亚毫米表面测距。',
    moneyShot: '点击任意牙齿或下方 2D 牙位图即可平滑聚焦，支持 Full / Pruned（3× 压缩）同屏保真对比。',
    fullUrl: asset('sceneA_trained_full.dspk'),
    prunedUrl: asset('sceneA_trained_pruned.dspk'),
    proxyUrl: asset('proxy_A_poseidon.glb'),
    metaUrl: asset('meta_A_trained.json'),
    layers: IOS_LAYERS,
    presets: [
      { id: 'frontal', label: '正中位', sub: 'Frontal', theta: 0, phi: 22, radius: 135 },
      { id: 'left', label: '左侧位', sub: 'Left', theta: 85, phi: 12, radius: 132 },
      { id: 'right', label: '右侧位', sub: 'Right', theta: -85, phi: 12, radius: 132 },
      { id: 'lower', label: '牙合面俯视', sub: 'Occlusal', theta: 0, phi: 78, radius: 108 },
    ],
  },
  {
    id: 'B',
    nav: 'Demo 2 · CBCT 透视',
    badge: 'REAL CBCT · CC BY 4.0',
    title: 'DentVoxel 真实患者 CBCT · 解剖贴面高斯',
    modality: 'CBCT 锥形束 CT',
    dataset: 'DentVoxel v4 Case 0095 (440×440×344, 0.3 mm, CC BY 4.0)',
    datasetUrl: 'https://figshare.com/articles/dataset/DentVoxel_a_fully_annotated_dental_CBCT_dataset_with_38_instance_anatomical_structures/31239889',
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '提取牙槽骨、全口牙体牙根、左右下颌神经管与上颌窦四层光滑等值面，按临床重要性分配预算（牙体 58.6% / 牙槽骨 27% / 神经管 7.2%），' +
      '法线对齐生成 111,000 个贴面高斯并烘焙三点医学光照与曲率 AO。',
    moneyShot: '调节「牙槽骨」透明度或点击右侧「38/48–神经管特写」，可直观检视阻生智齿牙根与下颌神经管的真实空间关系。',
    fullUrl: asset('sceneB_dentvoxel_full.dspk'),
    prunedUrl: asset('sceneB_dentvoxel_pruned.dspk'),
    proxyUrl: asset('proxy_B_dentvoxel.glb'),
    metaUrl: asset('meta_B_dentvoxel.json'),
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
    id: 'A',
    nav: 'Demo 3 · 采样基线',
    badge: 'SAMPLED BASELINE · CC BY 4.0',
    title: 'Poseidon3D 原始表面采样基线（对照组）',
    modality: 'IOS 口内扫描',
    dataset: 'Poseidon3D Case 000125 · 0.35 mm 表面点采样 (SH0)',
    datasetUrl: 'https://zenodo.org/records/15608906',
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '同一例 Poseidon3D 真实口扫的直接表面点采样基线（59,808 个等向高斯，SH0），用于与 Demo 1 的 3DGS 训练版并排对照，' +
      '直观展示多视角光度优化与各向异性椭球对牙冠高光与窝沟细节的提升。',
    moneyShot: '可与 Demo 1（训练版）切换对比表征差异，或开启三轴剖切检视内部轮廓。',
    fullUrl: asset('sceneA_poseidon_full.dspk'),
    prunedUrl: asset('sceneA_poseidon_pruned.dspk'),
    proxyUrl: asset('proxy_A_poseidon.glb'),
    metaUrl: asset('meta_A_poseidon.json'),
    layers: IOS_LAYERS,
    presets: [
      { id: 'frontal', label: '正中位', sub: 'Frontal', theta: 0, phi: 22, radius: 135 },
      { id: 'left', label: '左侧位', sub: 'Left', theta: 85, phi: 12, radius: 132 },
      { id: 'right', label: '右侧位', sub: 'Right', theta: -85, phi: 12, radius: 132 },
      { id: 'lower', label: '牙合面俯视', sub: 'Occlusal', theta: 0, phi: 78, radius: 108 },
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
    evidence: 'DSPK 头记录毫米包围盒； splat 与隐形代理共用世界坐标，测距以代理表面为参照。',
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

/** Five demonstration entry points. The top bar keeps the three primary assets compact; the
 *  clinical modes are deep links and also appear as buttons in the side panel. */
export const DEMOS = [
  { id: 'recon', n: '01', label: '牙列高光重建', sub: 'A2 · Brush 3DGS', hash: '#A2' },
  { id: 'cbct', n: '02', label: 'CBCT 透明解剖', sub: 'B · DentVoxel', hash: '#B' },
  { id: 'clip', n: '03', label: '三轴剖切封顶', sub: 'B · GLSL Cap', hash: '#B,clip' },
  { id: 'jaw', n: '04', label: '下颌铰链运动', sub: 'A2 · 0–45 mm', hash: '#A2,jaw' },
  { id: 'audit', n: '05', label: '压缩同屏审计', sub: 'B · Full / Pruned', hash: '#B,split' },
];
