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
  // 0.35 rather than the old 0.55: 82k bone splats at 0.8 mm stack into fog long before they read as bone.
  { id: 3, key: 'alveolar', cn: '牙槽骨（上颌 + 下颌）', en: 'Alveolar bone', color: '#cec4b0', alpha: 0.35, note: 'DentVoxel 的 maxilla / mandible 两块' },
  { id: 1, key: 'teeth', cn: '牙体 · 牙根', en: 'Teeth + roots', color: '#eee8d8', alpha: 1 },
  { id: 4, key: 'nerve', cn: '下颌神经管', en: 'Mandibular canal', color: '#facc3c', alpha: 1, note: '左右两条，智齿关系判定层' },
  { id: 7, key: 'sinus', cn: '上颌窦', en: 'Maxillary sinus', color: '#78a0d2', alpha: 0.35 },
];

export const CASES: CaseSpec[] = [
  {
    id: 'A',
    nav: 'Case A',
    title: 'IOS 牙列 · Poseidon3D 真实扫描（下颌）',
    modality: 'IOS 口内扫描',
    dataset: 'Poseidon3D（Kubik & Španěl, Zenodo 15608906, CC BY 4.0）',
    datasetUrl: 'https://zenodo.org/records/15608906',
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '真实口内扫描（单侧下颌，190,724 个三角面，逐面 FDI 标签 31–37 / 41–47），表面按 0.35 mm ' +
      '采样为高斯：几何与牙位语义都来自这一例真实扫描。原始 STL 没有纹理，颜色是按层程序化生成的' +
      '釉质/牙龈色，所以这里真实的是形状与拓扑，不是外观。这是下颌单颌，不是上下颌咬合。',
    moneyShot: '牙位级点击/高亮与 2D 牙位图双向联动，剖切面在牙颈部直接显出牙本质色带。',
    fullUrl: asset('sceneA_poseidon_full.dspk'),
    prunedUrl: asset('sceneA_poseidon_pruned.dspk'),
    proxyUrl: asset('proxy_A_poseidon.glb'),
    metaUrl: asset('meta_A_poseidon.json'),
    layers: IOS_LAYERS,
    presets: STANDARD_VIEWS,
  },
  {
    id: 'B',
    nav: 'Case B',
    title: 'CBCT 阻生智齿与神经管 · DentVoxel 病例',
    modality: 'CBCT 锥形束 CT',
    dataset: 'DentVoxel v4 case 0095（figshare 31239889, CC BY 4.0）',
    datasetUrl: 'https://figshare.com/articles/dataset/DentVoxel_a_fully_annotated_dental_CBCT_dataset_with_38_instance_anatomical_structures/31239889',
    license: 'CC BY 4.0 · 允许署名改编与公开分发',
    blurb:
      '真实患者 CBCT（440×440×344，0.3 mm 各向同性）。DentVoxel 的 39 类标注里，牙位直接就是 FDI 编号，' +
      '左右下颌神经管与上颌窦各有独立标签；本库把它映射到渲染端的四个可调层（牙槽骨 / 牙体牙根 / 神经管 / 上颌窦）。' +
      'DentVoxel 不含牙髓与修复体标签，所以这两层在这例里是空的。',
    moneyShot: '拉动透明度滑块查看 38/48 与下颌神经管的真实几何关系——这一例是 100 例里两者最近的一例，' +
      '距离由点云直接量出，不是临床结论。',
    fullUrl: asset('sceneB_dentvoxel_full.dspk'),
    prunedUrl: asset('sceneB_dentvoxel_pruned.dspk'),
    proxyUrl: asset('proxy_B_dentvoxel.glb'),
    metaUrl: asset('meta_B_dentvoxel.json'),
    layers: CBCT_LAYERS,
    presets: [
      // The DentVoxel FOV is a whole-head 13x10 cm volume (~125 mm wide), so the same radii that frame
      // the 64 mm IOS arch leave the skull cropped; and the IAN preset targets the real right canal,
      // next to FDI 38 (centroid [37.5, -8.4, -8.3] from tooth_meta_cbct.json), not the old fixture.
      // Target the dentition, not the head's centroid: the FOV owns the whole mid-face, so a target of
      // (0,0,0) frames the sinuses and leaves the teeth at the bottom edge.
      { id: 'frontal', label: '正中咬合位', sub: 'Frontal / IC', theta: 0, phi: 9, radius: 150, target: [0, -1, 12] },
      { id: 'left', label: '左侧位', sub: 'Left lateral', theta: 90, phi: 6, radius: 150, target: [0, -1, 12] },
      { id: 'right', label: '右侧位', sub: 'Right lateral', theta: -90, phi: 6, radius: 150, target: [0, -1, 12] },
      { id: 'upper', label: '上颌牙合面', sub: 'Maxillary occlusal', theta: 0, phi: 84, radius: 120, target: [0, -1, 12] },
      { id: 'lower', label: '下颌牙合面', sub: 'Mandibular occlusal', theta: 0, phi: -84, radius: 120, target: [0, -1, 12] },
      { id: 'ian', label: '38–神经管 关系', sub: 'Wisdom-tooth / canal', theta: -50, phi: -14, radius: 72, target: [30, -9, -9] },
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
