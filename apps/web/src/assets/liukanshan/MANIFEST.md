# 刘看山加工素材 MANIFEST

> 加工脚本：`apps/web/scripts/asset-prep.py`（可复跑：`python asset-prep.py ksmark|gif`）
> 处理日期：2026-09-12 · 处理环境：受管 Python 3.13.12 隔离 venv + Pillow 12.3.0
> 素材来源：`assets/liukanshan/`（只读官方素材库，未做改绘/混拼，仅裁切抠图与压缩）

## KSMark 头像（三档 PNG）

| 文件 | 尺寸 | 体积 | 帧数 | 源文件 | 处理参数 |
|---|---|---|---|---|---|
| `ksmark-64.png` | 64×64 | 4.3 KB | 静态 | `tri-view/立绘-绿幕.jpg` | 绿幕色度键(g-max(r,b)>40 全透明/12–40 渐变)→despill 去绿边→alpha 开运算去噪点→1px 羽化→bbox 裁剪→补正方形画布→LANCZOS 缩放 |
| `ksmark-32.png` | 32×32 | 1.8 KB | 静态 | 同上（由 64px 缩小） | LANCZOS |
| `ksmark-16.png` | 16×16 | 0.7 KB | 静态 | 同上（由 64px 缩小） | LANCZOS 重采样（非直接从原图缩） |

**目检结论**：三档在品红底拼图下检查，耳朵/眼睛/鼻子轮廓清晰，16px 档仍可辨识；边缘无绿边残留、无噪点。**Alpha 抽查**：四角 alpha=0，头部主体 alpha=255/254/255（16/32/64），透明度保真。

## 动图（animated WebP，保留 alpha）

| 文件 | 尺寸 | 体积 | 帧数 | 格式 | 源文件 | 处理参数 |
|---|---|---|---|---|---|---|
| `fox-t1.webp` | 180×180 | 196 KB | 60（6s） | WebP 动图 | `motion/电脑_6秒_320x320_20fps_透明.gif` | 降帧 20→10fps、LANCZOS 缩至 180px、有损 quality=62、method=4 |
| `fox-idle.webp` | 180×180 | 171 KB | 49（5s） | WebP 动图 | `motion/待机_5秒_320x320_20fps_透明.gif` | 同上，quality=80 |
| `fox-hello.webp` | 180×180 | 159 KB | 40（4s） | WebP 动图 | `motion/打招呼_4秒_320x320_20fps_透明.gif` | 同上，quality=80 |
| `fox-sleep.webp` | 180×180 | 177 KB | 49（5s） | WebP 动图 | `motion/瞌睡_5秒_320x320_20fps_透明.gif` | 同上，quality=80 |

- 原始 GIF 约 1MB/个 → WebP 159–196KB，**压缩率约 80–84%**（README 预期 60–80%，达标）
- 全部 ≤200KB 目标线；`fox-t1.webp` 帧数最多，quality 降到 62 后压线达标（目检无明显劣化）
- Pillow animated WebP 输出正常，**未触发 GIF 降级方案**
- `运球.gif` 按 README 跳过；`晃悠.gif` 未在本批任务范围

**目检结论**：四个文件首帧在品红底下检查，形象完整、背景透明、无花屏。**Alpha 抽查**（首帧）：四角 alpha=0，中心主体 alpha=255，透明度保真；`n_frames`/`is_animated` 校验均为动图且帧数齐全。

## 给 ui agent 的接线提示

- 动图仅按状态挂载（配 `loading="lazy"`），禁止首屏、禁止多只同屏循环
- KSMark 16px 用于 N3「看山解读」标识，32/64 可作 2x/4x 源或 hover 放大
