/**
 * tools/build-method-doc.mjs — assemble the single-file method + core-code compendium.
 *
 * The compendium is generated, not hand-edited: the prose lives in docs/method-doc.template.md and every
 * code listing is read from the working tree at build time. Each listing carries its line count and full
 * sha256 in the block header, so `--verify` can prove two things without trusting anybody: that the
 * delivered file still contains exactly those bytes, and that the working tree still matches them. A
 * compendium that quietly describes yesterday's code is the same failure mode as a doc that cites a
 * stale digest.
 *
 *   node tools/build-method-doc.mjs             # -> Downloads/DentSplat-方法与核心代码-20261125.md
 *   node tools/build-method-doc.mjs --verify    # exit 1 if the delivered file is edited or stale
 *   node tools/build-method-doc.mjs --out x.md
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const VERIFY = argv.includes('--verify');
const OUT = resolve(val('--out', join(process.env.USERPROFILE || process.env.HOME, 'Downloads',
  'DentSplat-方法与核心代码-20261125.md')));
const TEMPLATE = join(root, 'docs', 'method-doc.template.md');

// Status vocabulary: the point of the column is that presence in this file is not evidence of execution.
const RAN = '已执行', COMPILED = '仅编译', NEVER = '未运行';
const GROUPS = [
  {
    title: 'A. 前端：容器解析、渲染与交互',
    intro: '这一组是浏览器里真正跑的那部分：DSPK 解码、GLSL 着色器、单层 splat 的几何与排序、渲染器与拾取，以及把它们组织成界面的状态机。页面探针（每组 B）只通过这里暴露的 `window.DentSplat` 读取事实。',
    files: [
      ['index.html', RAN, '页面骨架；`SYNTHETIC PREVIEW` 常驻标注的落点'],
      ['src/main.tsx', RAN, '挂载入口'],
      ['src/App.tsx', RAN, '状态机：场景切换、裁剪、层透明、隔离、测距、Full/Pruned 对比、HUD'],
      ['src/data/cases.ts', RAN, '场景资产表：容器与代理网格路径、牙位表、初始视角'],
      ['src/engine/dspk.ts', RAN, 'DSPK v1 编解码（容器契约的唯一实现）'],
      ['src/engine/shaders.ts', RAN, 'GLSL：协方差投影、剖面裁剪与盖片、层透明、高亮与隔离'],
      ['src/engine/SplatLayer.ts', RAN, '单层 splat：instanced 几何、材质、CPU 远到近计数排序'],
      ['src/engine/Viewer.ts', RAN, '渲染器：相机、输入、代理网格拾取、测距、探针入口（renderProbe/bench/selfTest）'],
      ['src/ui/Odontogram.tsx', RAN, '二维牙位图，与三维点选双向同步'],
      ['src/styles.css', RAN, 'PACS 深色主题（#0B0F17 / #38BDF8）'],
      ['package.json', RAN, '脚本即闸门清单：check 把下面所有断言串成一条'],
      ['vite.config.ts', RAN, '构建配置'],
      ['tsconfig.json', RAN, '类型检查配置（`tsc --noEmit` 是 check 的最后一步）'],
    ],
  },
  {
    title: 'B. 容器工具、探针与校验',
    intro: '这一组负责"把磁盘上的字节变成结论"：写入器与检查器、页面探针与它们的 mock 自检、文档与产物的互证、以及变异测试。除明确标注的以外，都在本机实际运行过并产生过被引用的产物。',
    files: [
      ['tools/ply2dspk.ts', RAN, 'PLY + 标签 → DSPK；路径与时间戳归一化，保证重跑逐字节相同'],
      ['tools/dspk-head.ts', RAN, '只读检查容器头与平面长度'],
      ['tools/test-ply2dspk.ts', RAN, '写入器往返测试（量化误差界限）'],
      ['tools/test-label-sync.mjs', RAN, '标签同步闸：行数、manifest sha、Morton 顺序；含 FLIP_ROWS / SCRAMBLE 反例'],
      ['tools/test-gpu-name.mjs', RAN, '`WEBGL_debug_renderer_info` 字符串解析（不轻信驱动名）'],
      ['tools/verify-claims.mjs', RAN, '文档→产物互证：解析 §7 表格重哈希；简报与视频字幕分面复算'],
      ['tools/mutate-claims-test.mjs', RAN, '23 条变异，逐条要求"退出非零且指名报错"'],
      ['tools/pycheck.mjs', RAN, 'Python 结构检查（括号配平、悬空调用）——不是替代真跑'],
      ['tools/pagefn-selftest.mjs', RAN, '探针自检框架：同一段源码在 Node + mock 下执行'],
      ['tools/probe-smoke.js', RAN, '页面冒烟探针：键位、层、uniform、徽标、泵帧'],
      ['tools/probe-perf.js', RAN, '性能探针：分辨率阶梯、回读计时、绘制统计'],
      ['tools/probe-bench.js', RAN, '保真探针：参考图像、PSNR、覆盖率、掩膜'],
      ['tools/probe-bench-opaque.js', RAN, '隔离实验：只画不透明 splat，检验"误差是否来自透明混合"'],
      ['tools/probe-smoke.selftest.mjs', RAN, '冒烟探针的 mock 自检'],
      ['tools/nifti-wrapper.js', RAN, '自动化桥的薄载荷：fetch → hash → eval，只此三件事'],
      ['tools/probe-nifti-launch.js', RAN, '第二跳：再取一次真身并哈希'],
      ['tools/probe-nifti.js', RAN, 'CBCT 容器的浏览器端验证：逐层点亮、行号约定、容器检查'],
      ['tools/probe-nifti.selftest.mjs', RAN, '23 项 mock 检查，含 FLIP_ROWS / SCRAMBLE'],
      ['tools/nifti-report.mjs', RAN, '把 capture 与磁盘产物对账，打印可引用的段落'],
      ['tools/test-pipeline.mjs', RAN, '46 项离线链路断言，含重跑逐字节一致'],
      ['tools/make_tf3_fixture.py', RAN, '合成但解析可标注的 CBCT 体数据（不是患者数据）'],
      ['tools/verify_cbct_route.py', RAN, '端到端执行转换器并对照真值，不信任转换器自己的退出码'],
      ['tools/probe_frame_signs.py', RAN, '坐标系探针：上颌在 +Y、切牙在 +Z、患者右侧 −X'],
      ['tools/gen-dental-assets.ts', RAN, '合成资产生成器（Scene A 的几何/颜色/病灶规则都出自这里）'],
      ['tools/sha-assets.mjs', RAN, '资产摘要清单（tools/out/PROVENANCE.md）'],
      ['tools/summarize-perf.mjs', RAN, '性能 capture → 表格'],
      ['tools/summarize-bench.mjs', RAN, '保真 capture → 表格'],
      ['tools/cap2png.mjs', RAN, '把桥返回的 base64 图像落成真正的 PNG 文件'],
      ['tools/png-probe.mjs', RAN, 'PNG 解码 + 覆盖率/均值色统计（不依赖第三方库）'],
      ['tools/vendor-toothfairy3-labels.mjs', RAN, '把公开标签表固化进仓库（可追溯的版本）'],
      ['tools/ffmpeg-drawtext-probe.mjs', RAN, '八种 fontfile 写法对照真二进制；两种必须失败'],
      ['tools/serve-subpath.mjs', RAN, '按 GitHub Pages 的子路径与 404 语义伺服 dist（预部署检查用它，不用 preview）'],
      ['tools/verify3.mjs.js', RAN, '交付前的端到端 UI 驱动：真实指针事件 + 证据 PNG + JSON 报告'],
      ['tools/build-method-doc.mjs', RAN, '本文件的生成器与校验器（自包含）'],
    ],
  },
  {
    title: 'C. 离线流水线（Python / shell）',
    intro: '这一组是"数据→容器"的离线部分，CPU 上运行。注意状态列：CBCT 路线真正跑通了；Blender 渲染与训练脚本从未在本机运行——它们在这里是为了让交接方读得懂，不构成"已验证"。',
    files: [
      ['pipeline/run_case.sh', NEVER, 'Scene A 编排（网格→训练→转换）；本机未端到端执行'],
      ['pipeline/toothfairy2_to_layers.py', RAN, 'CBCT 分割 → 六层 PLY + 标签 + manifest（Scene B 的核心）'],
      ['pipeline/dental_lib.py', RAN, '共享工具：FDI、层码、PLY 读写、量化'],
      ['pipeline/postprocess_dental_gs.py', COMPILED, '训练产物后处理（从未见过真实训练的 .ply）'],
      ['pipeline/dental_pipeline_blender.py', COMPILED, 'Blender 渲染脚本（本机无 Blender）'],
      ['pipeline/train_gsplat.sh', NEVER, 'gsplat 训练（本机无训练环境）'],
      ['pipeline/train_2dgs.sh', NEVER, '2DGS 训练（同上）'],
      ['pipeline/requirements.txt', RAN, '离线链路依赖'],
    ],
  },
  {
    title: 'D. 交付物生成：一页简报与 60 秒走查',
    intro: 'PDF 与 MP4 都是"被别的程序读"的交付物，所以它们各有一道能证伪的闸门。卡片 HTML 的底部品牌条同时是排版贴合标记——这是把 QA 装置做成设计元素的一次折中。',
    files: [
      ['brief/technical-brief.html', RAN, '一页简报的源（A4 打印样式，8.5pt）'],
      ['brief/build-pdf.mjs', RAN, 'headless Edge 渲染，断言 `/Count 1` 与内容流'],
      ['brief/build-pdf.selftest.mjs', RAN, '300 mm 填充物 → 必须翻页'],
      ['brief/demo/frames.json', RAN, '走查清单：每帧的 PNG、sha256 前缀、时长、字幕'],
      ['brief/demo/build.mjs', RAN, '逐帧哈希 → 卡片截图 → ffmpeg 切片 → 成片复核 + PROVENANCE'],
      ['brief/demo/card-fit.selftest.mjs', RAN, '400 px 填充物 → 贴合标记必须消失'],
      ['brief/demo/title-card.html', RAN, '片头：声明"画面为渲染视口，非实时录屏"'],
      ['brief/demo/end-card.html', RAN, '片尾：已测量 / 尚未测量两栏 + 复现命令'],
    ],
  },
];

const LANG = { ts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', py: 'python', sh: 'bash', json: 'json',
  html: 'html', css: 'css', md: 'markdown', txt: 'text' };
const fenceFor = (s) => {
  let max = 0;
  for (const m of s.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return '`'.repeat(Math.max(4, max + 1));
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const anchor = (p) => p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------------------------------------------------------------- the two generated sections
const map = [], code = [];
let totalLines = 0, totalBytes = 0;
const missing = [];
for (const g of GROUPS) {
  map.push(`### ${g.title}`, '', '| 文件 | 行数 | sha256 | 状态 | 作用 |', '| --- | ---: | --- | --- | --- |');
  code.push(`## ${g.title}`, '', g.intro, '');
  for (const [p, status, why] of g.files) {
    const abs = join(root, p);
    if (!existsSync(abs)) { missing.push(p); continue; }
    const buf = readFileSync(abs);
    // The listing must be the file's exact bytes, and a markdown block can only carry a body terminated by
    // one newline. So: require a trailing newline, drop exactly that one, and let the closing fence supply
    // it again. CRLFs are left alone -- they survive split('\n')/join('\n') and therefore stay byte-exact.
    const raw = buf.toString('utf8');
    if (!raw.endsWith('\n')) { console.error(`${p}: no trailing newline, cannot embed byte-exactly`); process.exit(2); }
    const text = raw.slice(0, -1);
    const lines = text.split('\n').length;
    const sha = sha256(buf);
    totalLines += lines; totalBytes += buf.length;
    map.push(`| [\`${p}\`](#${anchor(p)}) | ${lines} | \`${sha.slice(0, 16)}\` | ${status} | ${why} |`);
    const fence = fenceFor(text);
    const ext = p.split('.').pop();
    code.push(`<a id="${anchor(p)}"></a>`, `### \`${p}\``, '',
      `<!-- BEGIN ${p} | lines=${lines} | sha256=${sha} | fence=${fence.length} -->`,
      `${fence}${LANG[ext] ?? ''}`, text, fence, `<!-- END ${p} -->`, '');
  }
  map.push('');
}
if (missing.length) { console.error(`missing files:\n  ${missing.join('\n  ')}`); process.exit(2); }

const template = readFileSync(TEMPLATE, 'utf8');
if (!template.includes('<!-- INSERT:CODE_MAP -->') || !template.includes('<!-- INSERT:CODE -->')) {
  console.error('template is missing its INSERT markers'); process.exit(2);
}
const doc = template
  .replace('<!-- INSERT:CODE_MAP -->', map.join('\n'))
  .replace('<!-- INSERT:CODE -->', code.join('\n'))
  .replace(/\s+$/, '') + '\n';

// ---------------------------------------------------------------- verify (source of truth for both modes)
const verify = (mdPath) => {
  const md = readFileSync(mdPath, 'utf8').split('\n');
  const blocks = [];
  for (let i = 0; i < md.length; i++) {
    const m = md[i].match(/^<!-- BEGIN (.+?) \| lines=(\d+) \| sha256=([0-9a-f]{64}) \| fence=(\d+) -->$/);
    if (!m) continue;
    const [, p, lines, sha, k] = m;
    const kk = Number(k);
    const open = md[i + 1] ?? '';
    if (!open.startsWith('`'.repeat(kk))) throw new Error(`${p}: opening fence missing`);
    const body = [];
    let j = i + 2;
    while (j < md.length && md[j] !== '`'.repeat(kk)) { body.push(md[j]); j++; }
    if (j >= md.length) throw new Error(`${p}: unterminated fence`);
    if ((md[j + 1] ?? '') !== `<!-- END ${p} -->`) throw new Error(`${p}: END marker missing or misnamed`);
    blocks.push({ p, lines: Number(lines), sha, text: body.join('\n') + '\n' });
    i = j + 1;
  }
  const bad = [];
  for (const b of blocks) {
    const got = sha256(Buffer.from(b.text, 'utf8'));
    if (got !== b.sha) bad.push(`${b.p}: delivered bytes say ${got.slice(0, 16)}…, header says ${b.sha.slice(0, 16)}…`);
    if (b.text.split('\n').length - 1 !== b.lines) bad.push(`${b.p}: ${b.text.split('\n').length - 1} lines in the file, header says ${b.lines}`);
    const abs = join(root, b.p);
    if (!existsSync(abs)) { bad.push(`${b.p}: cited by the document, not in the working tree`); continue; }
    const now = sha256(readFileSync(abs));
    if (now !== b.sha) bad.push(`${b.p}: working tree changed since the document was built (${now.slice(0, 16)}…)`);
  }
  return { blocks, bad };
};

// ---------------------------------------------------------------- run
if (VERIFY) {
  if (!existsSync(OUT)) { console.log(`note: no compendium at ${OUT} -- run \`node tools/build-method-doc.mjs\``); process.exit(0); }
  const { blocks, bad } = verify(OUT);
  console.log(`${blocks.length} code blocks, ${GROUPS.reduce((n, g) => n + g.files.length, 0)} listed files`);
  console.log(bad.length ? bad.map((b) => `FAIL ${b}`).join('\n') : 'ok   the compendium matches both its own bytes and the working tree');
  process.exit(bad.length ? 1 : 0);
}

if (argv.includes('--selftest')) {
  // The verifier has two legs, and both have to be shown capable of failing: a delivered file whose bytes
  // were edited after the fact, and a working tree that moved on after the document was built. Each leg is
  // exercised on a throwaway copy; the one source file touched for the staleness leg is restored from the
  // exact buffer it was read from, in a finally block.
  const tmp = join(root, 'tools', 'out', 'method-doc.selftest.md');
  const victim = 'tools/ffmpeg-drawtext-probe.mjs';
  const victimBuf = readFileSync(join(root, victim));
  let good = 0, bad = 0;
  const leg = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); ok ? good++ : bad++; };
  let restored;
  try {
    writeFileSync(tmp, doc, 'utf8');
    leg(verify(tmp).bad.length === 0, 'a freshly generated copy verifies clean');
    writeFileSync(tmp, doc.replace('export const DSPK_MAGIC', 'export const DSPK_MAGIX'), 'utf8');
    const edited = verify(tmp);
    leg(edited.bad.some((b) => b.includes('delivered bytes')), `an edited code block is caught (${edited.bad.length} problem(s))`);
    writeFileSync(tmp, doc, 'utf8');
    writeFileSync(join(root, victim), Buffer.concat([victimBuf, Buffer.from('\n')]));
    const stale = verify(tmp);
    leg(stale.bad.some((b) => b.includes('working tree changed')), `a source file that moved on is caught (${stale.bad.length} problem(s))`);
  } finally {
    writeFileSync(join(root, victim), victimBuf);
    writeFileSync(tmp, doc, 'utf8');
    restored = verify(tmp);
    rmSync(tmp, { force: true });
  }
  console.log(bad === 0 && restored.bad.length === 0 ? '\nthe verifier fails on tampering and on drift, and passes once restored'
    : `\n${bad + restored.bad.length} problem(s) -- the verifier is not trustworthy`);
  process.exit(bad === 0 && restored.bad.length === 0 ? 0 : 1);
}

writeFileSync(OUT, doc, 'utf8');
const { blocks, bad } = verify(OUT);                      // never hand over a document we have not re-read
console.log(`wrote  : ${OUT}`);
console.log(`size   : ${statSync(OUT).size.toLocaleString('en-US')} B, ${doc.split('\n').length.toLocaleString('en-US')} lines`);
console.log(`code   : ${blocks.length} blocks, ${totalLines.toLocaleString('en-US')} lines / ${(totalBytes / 1024).toFixed(0)} KiB of source`);
console.log(bad.length ? bad.map((b) => `FAIL ${b}`).join('\n') : 'ok   re-read and re-hashed every block against the working tree');
process.exit(bad.length ? 1 : 0);
