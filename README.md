# DentSplat Lab — 牙科 Gaussian Splatting 研究与交互式渲染平台

**在线演示：<https://asakatigar.github.io/dentsplat-web/>** · 打开即用，无需安装任何软件。

一句话：把真实牙科 3DGS / CBCT 资产压进自描述容器 `.dspk`，在浏览器里观察、检查和修改每一个高斯，并把不同表示、压缩与几何误差放到同一套可复算的坐标和相机下比较。

当前页面包含 **10 个真实资产条目**：6 个 Brush 训练的 IOS 3DGS、3 个 DentVoxel CBCT 贴面、1 个同源未训练表面采样基线。数据来源、许可和已知边界写在每个病例的 Data 面板与 `public/assets/report.json` 中。这里没有任何诊断准确性结论。

## 能做什么

- **Gaussian Lab**：RGB、真实 1/2/3σ 高斯椭球、中心点云、椭球线框、Opacity、Scale、估计法线与深度八种视图；椭球按真实协方差 `Σ = R diag(s²) Rᵀ` 构造。
- **Gaussian Inspector**：点击单个高斯，读取 μ、σ、四元数、不透明度、DC 颜色、SH1 系数、协方差与特征轴；可实时编辑位置、尺度和不透明度，并导出当前高斯云为标准 3DGS PLY。
- **FP32 PLY 导入**：浏览器直读 binary/ascii 3DGS PLY，位置/尺度/旋转/颜色/不透明度走 FP32 着色器路径，不先量化成 DSPK；PLY 不声明长度单位时界面以原始单位 `u` 展示。
- **同源方法对照**：Case 01（Brush 3DGS）与 Case 10（0.35 mm Surface Sampling）共用相机分屏；网格几何审计同时给出 DSPK 与 FP32 两行，以分离传输量化与重建误差。
- **重建产物时间轴**：除已发布的最终资产外，使用同一 120 视角数据和 Brush 独立重训了一次，导出 1k / 2k / 3k / 5k / 10k / 15k 六个真实高斯 checkpoint（25,581 → 28,694 splats），可直接在网页加载对比；训练 loss 行未输出，因此不画示意曲线。
- **压缩与研究对比**：10× 等字节 Uniform / Anatomy-Aware、Full 参考 PSNR/MAE、逐层误差、FDI 中心距变化，以及 160×140×128 CBCT MPR。
- **临床辅助仍保留**：FDI 牙位、三轴剖切、测量、MPR、AI 报告审计只作为辅助视图，不再占据产品中心。

## 已测量（同源、可复算）

| 证据 | 当前读数 |
| --- | --- |
| 训练资产 | Poseidon3D 000125 → 120 Blender 视角 → Brush v0.3.0 15,000 步 → 28,691 个 SH1 高斯 |
| 同源基线 | 0.35 mm 表面采样 → 59,808 高斯，SH0 |
| 几何审计（网格顶点样本） | Brush cloud→mesh mean **0.295 mm**，F@0.5 mm **84.5 / 96.5%**；Sampling **0.226 mm / 87.2 / 100.0%** |
| FP32→DSPK 传输差 | cloud→mesh mean 差 **0.0000 mm**（Brush / Sampling 均为 4 位小数） |
| 10× 同字节预算 | Uniform 22.28 dB overall；Anatomy 19.75 dB overall，但 L4 27.63→35.84 dB、FDI48–L4 clearance 0.724→0.427 mm |
| Brush 独立重训时间轴 | 1k: 25,581 splats / 742,552 B → 15k: 28,694 splats / 832,830 B；6 个 DSPK checkpoint 可在 Reconstruction 面板加载 |
| Case 05 标签诊断 | 1 mm 内 26.67%；FDI33 91.14% 对 FDI42/43 0%，bbox 差 0.08 mm、最佳 yaw 2.5°；结论是局部 Brush 表面偏差，不是坐标系错误 |

几何审计的距离是到 95,324 个焊接网格顶点的点集近似，不是精确 point-to-triangle Chamfer；法线一致性使用协方差最小主轴作为估计法线。完整字段、源文件 SHA 与反例见 [`MEASUREMENTS.md`](MEASUREMENTS.md) 和 `public/assets/geometry_metrics.json`。

## 不证明什么

- **没有 2DGS / Mip-Splatting / SuGaR / R²-Gaussian 训练结果**：Methods 页只把已有真实导出标为 AVAILABLE；切换网页显示模式不算算法实现。R²-Gaussian 需要 X 射线投影几何，当前 CBCT 分割体不能替代。
- **时间轴来自独立重训**：已发布 Case 01 本身没有保存中间 checkpoint；网页里的 1k–15k 序列是一次独立 Brush 重训（最终 28,694 vs 已发布 28,691），两者不能当作同一条训练轨迹。Brush 未输出 loss/PSNR 行，所以没有伪造的曲线。
- **SH 高阶尚未渲染**：导入器读取 SH degree，但 GPU 路径只评估 DC + l=1；SH3 文件不会被宣称成 SH3 渲染。
- **单机单卡单浏览器**：RTX 5070 Ti / ANGLE-D3D11 / Chromium；低端集显、移动端和远程桌面未做性能结论。
- **不是医疗器械**：测量、审计与 MPR 不构成诊断，`0.06 mm` 级数字是贴面中心距，不是根尖表面距离或神经损伤风险预测。

## 本地运行

```bash
npm ci
npm run dev          # http://localhost:5177
npm run build        # 产物在 dist/
npm run check        # 容器往返、标签同步、GPU 名解析、探针自检、文档数字复算、变异测试、pycheck、tsc
npm run test:pipeline # 离线链路 46 项断言（CPU，无 GPU）
```

部署由 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 完成：push 到 `main` 后，工作流用 `npm ci && npm run build` 构建，再把 `dist/` 强制推送到 `gh-pages` 分支，Pages 从该分支发布。`vite.config.ts` 的 `base: './'` 与应用里的 `import.meta.env.BASE_URL` 前缀，是为了让产物在 `/<repo>/` 子路径下也能正确取到资产。

预部署检查不依赖线上：`node tools/serve-subpath.mjs --port 5288 --prefix dentsplat-web` 按 Pages 的语义伺服 `dist/`（子路径之外 404、缺文件 404，而不是回落到 `index.html`），随后用浏览器探针确认 `paintedFraction > 0`、`glError = 0`。

## 接入一例真实 CBCT（数据需自行取得）

ToothFairy3 / ToothFairy2 的体数据在 ditto.ing.unimore.it 上需要账号，本仓库不含任何患者数据。拿到一例（`<case>.nii.gz` + `<case>_0000.nii.gz`，nnU-Net 布局）后：

```bash
# 1) 六层点云 + 逐点 FDI/层标签
python pipeline/toothfairy2_to_layers.py --case_dir raw/<case> --out_dir output/<case>/web_assets \
  --schema tf3 --spacing_mm 0.8 --surface_only 1

# 2) 不可见代理：每个 FDI 一颗凸包，与 splat 同帧（少了它，点击与毫米测距没有参照）
python pipeline/cbct_proxy.py --labels_nii raw/<case>/<case>.nii.gz \
  --frame_json output/<case>/frame_cbct.json \
  --meta_json output/<case>/web_assets/tooth_meta_cbct.json \
  --out output/<case>/web_assets/proxy_B.glb

# 3) 容器 + 结构校验
node tools/ply2dspk.ts --in output/<case>/web_assets/cbct_layers.ply \
  --fdi output/<case>/web_assets/fdi_labels.bin --layer output/<case>/web_assets/layer_labels.bin \
  --manifest output/<case>/web_assets/labels_manifest.json \
  --out public/assets/sceneB_from_nifti.dspk --meta-out public/assets/meta_B.json --kind cbct --name sceneB
node tools/check-glb.mjs output/<case>/web_assets/proxy_B.glb --min-teeth 26
```

**换资产必须重测。** `report.json` 里的 PSNR、覆盖间隙和体积比是在**当前合成资产**上测出来的；替换成真实病例后，这些数字与页面上的模型不再对应，必须重跑浏览器探针的 `bench()` 并更新 `MEASUREMENTS.md` 与简报，或者在重测前把该场景的指标卡明确标成"未测"。把旧数字留在新资产旁边，比没有数字更糟。

## 训练交接包（gsplat 未跑完的那一步）

`Downloads/DentSplat-training-bundle-20261125.tar.gz`（3,734,216 B，sha256 `1d20dee2…`，120 张 1024² Cycles 渲染 + COLMAP 文本 + 代理 GLB + 脚本）。解包后 `bash run_all.sh` 会建 venv、装 torch/gsplat、跑 15k 步训练、再剪枝绑标签。

**如实说明**：这个包没有在任何机器上端到端跑完过。本次会话把 V100 的 torch 装好、gsplat 克隆到一半就被跳板机的凭据级限流掐断；渲染与 COLMAP 是在本机真跑的。所以包里给的是"应当得到"的路径，不是已有的结果。

## 仓库结构

```
src/engine/        DSPK 容器、GLSL 着色器、单层排序、渲染器与拾取
src/ui/            二维牙位图与界面
pipeline/          CBCT → 六层 PLY + 标签 → 容器的离线链路（Python）
tools/             写入器、页面探针与其 mock 自检、文档→产物互证、变异测试
brief/             一页技术简报与 60 秒走查的生成器
docs/              方法论与核心代码的单文件汇编（生成物）
MEASUREMENTS.md    每个数字的仪器、口径与反例
```

## 数据与许可

- **Scene A（在售资产）**：Poseidon3D 单侧下颌扫描，case 000125（Kubik & Španěl，<https://zenodo.org/records/15608906>，CC BY 4.0）。
  几何与逐面 FDI 标签来自这一例真实扫描；STL 无纹理，颜色为程序化生成。允许署名改编与公开分发。
- **Research Mode（不入库、不上线）**：Teeth3DS+ 的真实网格在 <https://osf.io/xctdy/>（单例样本 <https://osf.io/download/vr38s/>），
  协议 CC BY-NC-ND 4.0——可以本地跑通转换与论文实验，**不得**把衍生的 .dspk/.ply 提交到公开仓库或放到 Pages。
  `tools/obj_labels_to_assets.mjs` 就是为这条路准备的，输出固定写在 `tools/out/research/`（已 gitignore）。
- **Scene B（在售资产）**：DentVoxel v4 case 0095（<https://figshare.com/articles/dataset/DentVoxel_a_fully_annotated_dental_CBCT_dataset_with_38_instance_anatomical_structures/31239889>，CC BY 4.0）。
  真实患者 CBCT，440×440×344 / 0.3 mm，39 类标注（牙位即 FDI，左右下颌神经管与上颌窦独立）；`pipeline/dentvoxel_to_tf3.py` 把它映射到渲染端的四层，`tools/ziprange.mjs` 只从 8.8 GB 的发布包里取这一例。
- ToothFairy3 / ODIN2025 语义口径（CC BY-NC-SA 4.0）仍是手册里的对照，需要 ditto 账号；仓库不含任何患者原始数据。
- 本仓库不包含上述数据集的原始文件。两个场景的几何与 FDI 语义都来自真实公开病例（CC BY 4.0）；
  外观（颜色/光照）是程序化烘焙，不是训练出来的 3DGS 外观。仅用于学术研究与演示。
- Scene B 已改为 **oriented-surfel** 包（`pipeline/cbct_surfel.py`）：Marching Cubes 曲面、Poisson
  抽稀采样、四元数对齐法线、s3 = 0.2 s1、SH1 + 曲率 AO。blob 审计的前后对照在
  `tools/out/blob_audit_before.json` 与 `tools/out/blob_audit_after.json`
  （0% 各向同性 / 100% 贴面盘 / 欠覆盖 12.1%，改前为 100% 圆球 / 欠覆盖 49%）。

- **Case A · Trained** (`#A2`, default first screen): the same Poseidon3D scan trained as a real 3DGS on
  the local RTX 5070 Ti with Brush v0.3.0 (15,000 steps, 120 Blender renders, SH1, 28,691 Gaussians).
  The export is rotated -90 deg about Y into the viewer frame, including the l=1 coefficients
  (`tools/ply-frame-fix.mjs`); FDI is transferred from the sampled packet (99.5 % within 1.0 mm,
  `tools/label-transfer.mjs`). The 3x decimation has 9,564 splats / 278,146 B, coverage gap
  0.496 / 0.885 / 2.857 mm, and browser PSNR 31.04 / 26.37 dB (`tools/report-trained.mjs`).
