#!/usr/bin/env python3
"""asset-prep: 刘看山素材加工（KSMark 头像抠图 + GIF→animated WebP）
复跑方式: apps/web/scripts/asset-prep.py
用法: python asset-prep.py ksmark | python asset-prep.py gif
"""
import sys
from pathlib import Path

from PIL import Image, ImageFilter, ImageSequence

# Resolve paths from the repository location so the public script contains no
# developer-specific absolute paths and works from any checkout directory.
ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "assets" / "liukanshan"
OUT = ROOT / "apps" / "web" / "src" / "assets" / "liukanshan"
TMP = ROOT / "apps" / "web" / "scripts" / "tmp"

OUT.mkdir(parents=True, exist_ok=True)


# ---------- KSMark 头像 ----------
def chroma_key(img: Image.Image) -> Image.Image:
    """绿幕色度键: 绿色 -> 透明 alpha, 并去绿边 (despill)。"""
    img = img.convert("RGB")
    px = img.load()
    w, h = img.size
    alpha_img = Image.new("L", (w, h), 255)
    a = alpha_img.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            # 绿色占优程度: g 超过其他通道越多, 越透明
            excess = g - max(r, b)
            if excess > 40 and g > 90:
                a[x, y] = 0
            elif excess > 12:
                # 边缘半透明, 平滑过渡
                a[x, y] = max(0, min(255, int(255 * (40 - excess) / 28)))
    out = img.convert("RGBA")
    out.putalpha(alpha_img)
    # despill: 把可见像素的绿色压到 r/b 最大值, 消除绿边
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, al = op[x, y]
            if al > 0 and g > max(r, b):
                op[x, y] = (r, max(r, b), b, al)
    return out


def do_ksmark() -> None:
    TMP.mkdir(parents=True, exist_ok=True)
    src = Image.open(SRC / "tri-view" / "立绘-绿幕.jpg")
    # 头部区域(含耳朵+鼻子; 按整图抠图 bbox 与目测比例定位, 覆盖耳朵顶到下巴)
    head = src.crop((300, 390, 970, 800))
    keyed = chroma_key(head)
    # 去边缘噪点: alpha 开运算(3x3 min->max)消掉孤立小点, 再 1px 羽化
    a = keyed.getchannel("A").filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    a = a.filter(ImageFilter.GaussianBlur(0.6))
    keyed.putalpha(a)
    bbox = keyed.getbbox()  # 非零 alpha 的包围盒
    head = keyed.crop(bbox)
    # 补成正方形画布(居中), 避免缩放变形
    side = max(head.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(head, ((side - head.size[0]) // 2, (side - head.size[1]) // 2))
    head = sq
    head.save(TMP / "ksmark-head-full.png")
    print("head size:", head.size)

    # 64px 母版(内容填满画布), 32 由 64 缩, 16 由 64 缩 (LANCZOS)
    m64 = head.resize((64, 64), Image.LANCZOS)
    m32 = m64.resize((32, 32), Image.LANCZOS)
    m16 = m64.resize((16, 16), Image.LANCZOS)
    for m, name in ((m64, "ksmark-64.png"), (m32, "ksmark-32.png"), (m16, "ksmark-16.png")):
        m.save(OUT / name, optimize=True)


# ---------- GIF -> animated WebP ----------
GIF_MAP = {
    "电脑_6秒_320x320_20fps_透明.gif": ("fox-t1.webp", 62),  # 帧数最多, 降质量压到 200KB 内
    "待机_5秒_320x320_20fps_透明.gif": ("fox-idle.webp", 80),
    "打招呼_4秒_320x320_20fps_透明.gif": ("fox-hello.webp", 80),
    "瞌睡_5秒_320x320_20fps_透明.gif": ("fox-sleep.webp", 80),
}


def do_gif() -> None:
    for src_name, (out_name, quality) in GIF_MAP.items():
        gif = Image.open(SRC / "motion" / src_name)
        frames, durations = [], []
        for i, fr in enumerate(ImageSequence.Iterator(gif)):
            if i % 2 == 0:  # 20fps -> 10fps
                frames.append(fr.convert("RGBA").resize((180, 180), Image.LANCZOS))
                durations.append(fr.info.get("duration", 50) * 2)
        total = sum(durations)
        avg = total / len(durations)
        durations = [round(avg)] * len(durations)  # 均匀化, 防累积误差
        frames[0].save(
            OUT / out_name,
            save_all=True,
            append_images=frames[1:],
            duration=durations,
            loop=0,
            lossless=False,
            quality=quality,
            method=4,
        )
        size_kb = (OUT / out_name).stat().st_size / 1024
        print(f"{out_name}: {len(frames)} frames, {size_kb:.0f} KB")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "ksmark":
        do_ksmark()
    elif cmd == "gif":
        do_gif()
    else:
        print("usage: asset-prep.py ksmark|gif")
        sys.exit(1)
