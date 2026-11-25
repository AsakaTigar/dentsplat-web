# DentSplat — 浏览器里的牙科 3D Gaussian Splatting 临床原型

**在线演示：<https://asakatigar.github.io/dentsplat-web/>** · 打开即用，无需安装任何软件。

一句话：把牙科数据压进一个自描述容器 `.dspk`，在浏览器里用**一次 draw call** 画出来，并让每一个交互、每一个数字都能被仓库里的脚本重新测出来。

> **当前资产是合成预览（SYNTHETIC PREVIEW），界面上常驻同一标注。** 几何按公开数据集的解剖统计生成，颜色与病灶位置为程序化合成；没有使用真实患者数据，也没有临床诊断验证。下文"已测量"一节的数字量化的是**编解码与渲染契约**，不是真实扫描训练出的 3DGS 的保真度。

## 能做什么

- **双场景**：A = IOS 牙列（Teeth3DS+ 统计口径），B = CBCT 阻生智齿与下牙槽神经管（ToothFairy3 六层语义口径）。
- **FDI 牙位**：点击 3D 牙齿或在二维牙位图上点选，整颗牙高亮、相机平滑聚焦；牙位语义写在 splat 的第四个字节里，随几何走，不靠旁挂文件。
- **着色器级裁剪**：X / Y / Z 三轴剖切 + 断面盖片，拖动即时生效；分层透明度滑块直接驱动 `uLayerAlpha` 数组。
- **Full vs Pruned 同屏对比**：同一个相机、同一帧，分屏显示完整包与剪枝包。
- **毫米测距**：基于不可见代理网格的水面距离，不是"最近高斯中心"。
- **证据面板**：每个数字标注它的仪器、口径与反例。

## 已测量（同机、同构建，脚本可复算）

| 指标 | Scene A | Scene B |
| --- | --- | --- |
| 体积（完整 → 剪枝） | 2,582,852 → 609,126 B（4.24×） | 1,301,244 → 379,898 B（3.43×） |
| PSNR（整帧 / 掩膜内） | 21.82 / 17.60 dB | 25.10 / 22.03 dB |
| GPU 单遍 | 2.6–2.9 → 0.7–0.9 ms | 1.3–1.5 → 0.5–0.7 ms |
| 几何覆盖间隙（剪枝后） | 0.314 / 0.691 / 4.796 mm | 0.349 / 0.946 / 1.297 mm |

离线链路（CBCT → 六层 → 容器）已完整执行：87,405 splats、46 项断言、重跑逐字节相同。所有数字的出处、仪器与失败反例见 [`MEASUREMENTS.md`](MEASUREMENTS.md)。

## 不证明什么

- **资产是合成的**：没有真实扫描网格，也没有训练过程；Blender → gsplat 那条训练链在本仓库里只到脚本，未在本机执行。
- **CBCT 链路用的是合成体数据**（1.0 mm 体素、0.6 mm splat），不是患者；真实病例与 nnU-Net 推理尚未接入。
- **单机单卡单浏览器**：RTX 5070 Ti / ANGLE-D3D11 / Chromium；低端集成显卡与远程桌面未实测。
- **"阻生智齿是否压迫神经管"目前只是可做的交互**，不是结果；合成模型上的 2.35 mm 是几何距离，不是临床测量。
- 没有任何诊断准确性结论。

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
- 本仓库不包含上述数据集的原始文件；产物为合成资产。仅用于学术研究与演示。
