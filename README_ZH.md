<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/logo.svg" />
    <img src="docs/logo.svg" alt="DentSplat" width="420" height="97" />
  </picture>
</p>

<p align="center">
  面向牙科三维扫描与 CBCT 数据的浏览器原生 WebGL2 3D Gaussian Splatting 渲染与基准测试平台。
</p>

<p align="center">
  <a href="https://asakatigar.github.io/dentsplat-web/"><strong>在线演示</strong></a> ·
  <a href="MEASUREMENTS.md"><strong>完整评测日志</strong></a> ·
  <a href="README.md"><strong>English</strong></a> ·
  <strong>中文</strong>
</p>

---

## 简介

**DentSplat** 是一个面向牙科三维扫描与 CBCT 数据的浏览器端 WebGL2 3D Gaussian Splatting 渲染与基准测试平台。项目通过自描述二进制容器 `.dspk` 与原生 FP32 `.ply` 解码，实现零安装的高斯体素可视化、单高斯参数检查与编辑、多方法同视角对照及可复算几何审计。

当前在线演示包含 10 个公开牙科资产条目——6 个 Brush 训练的口扫（IOS）3DGS 场景、3 个 DentVoxel CBCT 贴面高斯体数据与 1 个未训练表面采样基线，全部在统一坐标系与相机下对比。

## 主要功能

* **Gaussian Lab 与属性检查器**：支持 RGB、真实协方差椭球（`1σ / 2σ / 3σ`）、中心点云、线框、Opacity、Scale、法线与深度 8 种模式；点击单个高斯可读取并实时编辑位置、尺度、不透明度、颜色、SH 系数与协方差矩阵，并导出标准 3DGS `.ply`。
* **原生 FP32 PLY 与 SH3 支持**：浏览器直接解析 binary / ASCII `.ply`，位置与协方差走 FP32 着色器路径，`l=2 / l=3` 球谐系数通过顶点浮点纹理在 GPU 实时计算。
* **多方法同相机对照**：支持 `gsplat 3DGS MCMC`、`gsplat 2DGS`、`Brush 3DGS` 与 `Surface Sampling` 四视口同步相机比较，并提供 Surface-Aligned Disks 基线与独立重训的 `1k–15k` 检查点时间轴。
* **压缩与解剖视图**：支持 CBCT `10×` 同字节 Uniform / Anatomy-Aware 压缩对比、实时 PSNR/MAE 像素回读、`160×140×128` CBCT 三视图 MPR 联动、FDI 牙位图及三轴剖切。

## 核心实验数据

在 `Poseidon3D case 000125` 同一源网格上的几何与渲染实测如下（精确 point-to-triangle BVH 距离；gsplat 3DGS / 2DGS 采用统一 `105 train / 15 test` Blender 视角划分）：

| 方法 | 高斯数 | 测试集 PSNR / SSIM / LPIPS | Cloud→Mesh Mean | P95 | F@0.5 mm (P / R) |
| --- | ---: | :---: | ---: | ---: | :---: |
| **Brush 3DGS** (15k) | 28,691 | — | **0.168 mm** | **0.469 mm** | **95.9% / 94.7%** |
| **gsplat 3DGS MCMC** (15k) | 80,000 | **38.54 dB** / **0.9855** / **0.02245** | 0.370 mm | 1.544 mm | 79.2% / 76.5% |
| **gsplat 2DGS** (15k) | 24,198 | 38.48 dB / 0.9842 / 0.02340 | 0.416 mm | 1.643 mm | 72.9% / 65.0% |
| **Surface Sampling** (基线) | 59,808 | — | 0.0002 mm | 0.0004 mm | 100.0% / 99.97% |

* **CBCT 10× 同字节压缩（DentVoxel case 0095，322 KB）**：Uniform 全局 PSNR `22.28 dB`；Anatomy-Aware 全局 `19.75 dB`，但将下颌神经管（L4）重建从 `27.63 dB` 提升至 `35.84 dB`，FDI 48–L4 间隙偏差由 `0.724 mm` 降至 `0.427 mm`。
* **Brush 独立时间轴（`1k → 15k`）**：高斯数由 `25,581` 增至 `28,694`，Cloud→Mesh 均距由 `0.078 mm` 变为 `0.166 mm`，法线一致性由 `0.613` 变为 `0.606`。

## 本地运行

```bash
npm ci
npm run dev           # 启动开发服务 http://localhost:5177
npm run build         # 构建生产产物至 dist/
npm run check         # 全链路一致性与类型校验
npm run test:pipeline # 46 项离线 CPU 管线测试
```

> *声明：本项目仅用于三维图形学与牙科计算成像学术研究及演示，不构成医疗器械或临床诊断依据。公开仓库仅包含按 CC BY 4.0 许可生成的派生 `.dspk` / `.glb` 展示资产，不含原始患者影像数据。*
