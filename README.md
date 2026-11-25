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

部署由 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 完成：push 到 `main` 即构建并发布到 GitHub Pages。`vite.config.ts` 的 `base: './'` 与应用里的 `import.meta.env.BASE_URL` 前缀，是为了让产物在 `/<repo>/` 子路径下也能正确取到资产。

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

- Scene A 统计口径：Teeth3DS+ / 3DTeethSeg（<https://osf.io/um96h>，CC BY-NC-ND 4.0）。
- Scene B 语义口径：ToothFairy3 / ODIN2025（MICCAI 2025，CC BY-NC-SA 4.0）。
- 本仓库不包含上述数据集的原始文件；产物为合成资产。仅用于学术研究与演示。
