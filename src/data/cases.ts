import type { ViewPreset } from '../engine/Viewer.ts';

/**
 * Static assets resolve against Vite's BASE_URL rather than the site root. The app is published under a
 * repository subpath on GitHub Pages (`base: './'`), where a leading '/' would request
 * https://<user>.github.io/assets/... and 404 -- the build still boots, so the failure looks like an
 * empty scene rather than a wrong path. One helper, used by every URL below.
 */
const asset = (file: string) => `${import.meta.env.BASE_URL}assets/${file}`;

export type LayerSpec = {
  id: number;
  key: string;
  cn: string;
  en: string;
  color: string;
  /** Slider default: the clinically useful starting transparency for this case. */
  alpha: number;
  note?: string;
};

export type CaseSpec = {
  id: 'A' | 'B';
  nav: string;
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

/** Five standard dental views, in the engine's orbit parametrisation (Y-up, +Z = lips). */
export const STANDARD_VIEWS: ViewPreset[] = [
  { id: 'frontal', label: '正中咬合位', sub: 'Frontal / IC', theta: 0, phi: 9, radius: 178 },
  { id: 'left', label: '左侧位', sub: 'Left lateral', theta: 90, phi: 6, radius: 168 },
  { id: 'right', label: '右侧位', sub: 'Right lateral', theta: -90, phi: 6, radius: 168 },
  { id: 'upper', label: '上颌牙合面', sub: 'Maxillary occlusal', theta: 0, phi: 84, radius: 132 },
  { id: 'lower', label: '下颌牙合面', sub: 'Mandibular occlusal', theta: 0, phi: -84, radius: 126 },
];

const IOS_LAYERS: LayerSpec[] = [
  { id: 1, key: 'enamel', cn: '牙冠釉质', en: 'Enamel', color: '#eee8d8', alpha: 1 },
  { id: 0, key: 'gingiva', cn: '牙龈 / 软组织', en: 'Gingiva', color: '#c66c70', alpha: 1 },
  { id: 2, key: 'root', cn: '牙根 / 牙本质', en: 'Root · dentine', color: '#e2d6be', alpha: 1 },
  { id: 8, key: 'restoration', cn: '修复体', en: 'Restoration', color: '#bac4ce', alpha: 1 },
];

const CBCT_LAYERS: LayerSpec[] = [
  { id: 3, key: 'alveolar', cn: '牙槽骨', en: 'Alveolar bone', color: '#cec4b0', alpha: 0.55, note: '皮质骨 + 松质骨壳' },
  { id: 1, key: 'teeth', cn: '牙体 · 牙根', en: 'Teeth + roots', color: '#eee8d8', alpha: 1 },
  { id: 6, key: 'pulp', cn: '髓腔 · 根管', en: 'Pulp · canals', color: '#e2565f', alpha: 1, note: '暖红高亮' },
  { id: 4, key: 'nerve', cn: '下牙槽神经管', en: 'IAN canal', color: '#facc3c', alpha: 1, note: '荧光黄，智齿关系判定层' },
  { id: 7, key: 'sinus', cn: '上颌窦', en: 'Maxillary sinus', color: '#78a0d2', alpha: 0.35 },
  { id: 8, key: 'restoration', cn: '修复体 / 种植体', en: 'Restoration · implant', color: '#bac4ce', alpha: 0.9 },
];

export const CASES: CaseSpec[] = [
  {
    id: 'A',
    nav: 'Case A',
    title: 'IOS 牙列 · 合成几何（Teeth3DS+ 统计口径）',
    modality: 'IOS 口内扫描',
    dataset: 'Teeth3DS+ 公开统计口径（未使用其网格）',
    datasetUrl: 'https://osf.io/um96h',
    license: 'CC BY-NC-ND 4.0 · academic non-commercial',
    blurb:
      '32 颗牙的 FDI 语义按 Teeth3DS+ 的牙位规则生成（11–48，0 = 牙龈）。牙冠/牙根比例、邻接与龈缘高度' +
      '取自公开统计，几何与外观由解剖度量模型程序化合成——没有使用其真实扫描网格，也没有训练过程。' +
      'Blender → gsplat 那条训练链在本仓库里只到脚本，未在本机执行。',
    moneyShot: '牙位级点击/高亮与 2D 牙位图双向联动，剖切面在牙颈部直接显出牙本质色带。',
    fullUrl: asset('sceneA_full.dspk'),
    prunedUrl: asset('sceneA_pruned.dspk'),
    proxyUrl: asset('proxy_A.glb'),
    metaUrl: asset('meta_A.json'),
    layers: IOS_LAYERS,
    presets: STANDARD_VIEWS,
  },
  {
    id: 'B',
    nav: 'Case B',
    title: 'CBCT 阻生智齿与神经管 · 合成体数据',
    modality: 'CBCT 锥形束 CT',
    dataset: 'ToothFairy3 六层语义口径（合成体数据，非患者）',
    datasetUrl: 'https://ditto.ing.unimore.it/toothfairy3/',
    license: 'CC BY-NC-SA 4.0 · academic non-commercial',
    blurb:
      '按 ToothFairy3 的六层语义约定生成（牙体/牙槽骨/神经管/牙髓/修复体/上颌窦）。离线链路已在合成体' +
      '数据上完整跑通：NIfTI → 六层 PLY + 标签 → .dspk，46 项断言、重跑逐字节相同。真实病例体数据、' +
      'nnU-Net 推理与 0.3 mm 原始分辨率尚未接入。',
    moneyShot: '拉动透明度滑块查看 48 牙与下牙槽神经管的几何关系——合成模型上的最近距离为 2.35 mm，' +
      '仅作几何演示，不是临床测量。',
    fullUrl: asset('sceneB_full.dspk'),
    prunedUrl: asset('sceneB_pruned.dspk'),
    proxyUrl: asset('proxy_B.glb'),
    metaUrl: asset('meta_B.json'),
    layers: CBCT_LAYERS,
    presets: [
      ...STANDARD_VIEWS,
      { id: 'ian', label: '48–IAN 关系', sub: 'Wisdom-tooth / canal', theta: -58, phi: -16, radius: 54, target: [-19.5, -6.5, -12] },
    ],
  },
];

/** Lesions baked into the synthetic preview assets; replace with inference output later. */
export const LESION_LABEL: Record<string, { cn: string; en: string; code: string }> = {
  'occlusal-caries': { cn: '咬合面龋', en: 'Occlusal caries', code: 'ICDAS 3' },
  'white-spot': { cn: '白斑脱矿', en: 'White spot lesion', code: 'ICDAS 1–2' },
  calculus: { cn: '牙石沉积', en: 'Calculus deposit', code: 'CPITN 2' },
  impaction: { cn: '近中阻生', en: 'Mesioangular impaction', code: 'Pell–Gregory B' },
};

export const AUDIT_BASIS = [
  {
    k: '坐标契约',
    en: 'Coordinate contract',
    detail: '1 unit = 1 mm，Y-up，牙合平面 ∥ XZ，上颌在 +Y，唇侧在 +Z，放射学约定（患者右侧 = −X）。',
    evidence: 'DSPK 头写 bbox（mm），代理网格与 Gaussian 由同一解析牙列模型采样，位置不可能漂移。',
  },
  {
    k: '语义来源',
    en: 'Semantic source',
    detail: 'Case A 逐顶点 FDI 标签 11–48（0 = 牙龈）；Case B 77 类体素标签映射到 6 个渲染层。',
    evidence: 'FDI 直接编码进 splat 的 misc 字节，剔除/压缩后仍然对齐——不依赖外部索引表。',
  },
  {
    k: '渲染证据',
    en: 'Rendering evidence',
    detail: 'EWA splatting：解析 2×2 协方差特征分解，3σ 四边形，前后向 alpha 合成；剖切与高亮都在自定义 shader 内完成。',
    evidence: 'src/engine/shaders.ts 全文可见，未调用任何现成 3DGS 渲染库。',
  },
  {
    k: '压缩证据',
    en: 'Compression evidence',
    detail: 'Full 与 Pruned 两个包同时驻留显存，同帧同相机分屏对比，PSNR/MAE 由浏览器实际回读像素计算。',
    evidence: 'bench() 渲染到 WebGLRenderTarget 后 readRenderTargetPixels，指标不是估算值。',
  },
];
