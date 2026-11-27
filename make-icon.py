# -*- coding: utf-8 -*-
"""
生成塔罗工具的快捷方式图标。

画一个和应用风格一致的小图标：深紫底 + 金色四角星 + 细金环。
不用系统图标库里的索引是因为「shell32 第 N 号是星星」这种说法只能靠猜，
猜错了得到一个完全不搭的图标（可能是垃圾桶或文件夹）。自己画反而确定。

用 8 倍超采样再缩小，这样圆形和斜边都不会有锯齿——Pillow 本身不做抗锯齿。
"""
import math
import os

from PIL import Image, ImageDraw

SIZE = 256          # 输出尺寸
SS = 8              # 超采样倍数
W = SIZE * SS

# 与页面同一套配色
BG_OUTER = (19, 20, 39)      # 深靛
BG_INNER = (86, 74, 200)     # 紫（#564ac8 附近）
GOLD = (201, 162, 39)        # 主金色
GOLD_LIGHT = (240, 210, 110) # 亮金，用于星心


def radial_background():
    """画一个从中心发亮的圆形底。"""
    base = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw = ImageDraw.Draw(base)

    cx = cy = W / 2
    radius = W / 2 - 2 * SS
    steps = 160

    # 由外向内逐圈缩小，同时把颜色从中性深紫混到亮紫，形成发光感
    for i in range(steps):
        t = i / (steps - 1)          # 0 = 外圈，1 = 圆心
        r = radius * (1 - t) + radius * 0.05 * t
        color = tuple(
            int(BG_OUTER[c] + (BG_INNER[c] - BG_OUTER[c]) * (t ** 1.6))
            for c in range(3)
        )
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (255,))

    return base


def star_points(cx, cy, outer, inner, points=4, rotation=-math.pi / 2):
    """四角星的顶点序列。"""
    pts = []
    for i in range(points * 2):
        r = outer if i % 2 == 0 else inner
        a = rotation + i * math.pi / points
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def main():
    img = radial_background()
    draw = ImageDraw.Draw(img)

    cx = cy = W / 2

    # 细金环
    ring_r = W * 0.435
    ring_w = 2.6 * SS
    draw.ellipse(
        [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
        outline=GOLD + (210,), width=int(ring_w)
    )

    # 四角星：大而细长，像页面顶部那个 ✦
    outer = W * 0.315
    inner = outer * 0.20
    star = star_points(cx, cy, outer, inner)
    draw.polygon(star, fill=GOLD_LIGHT + (255,))

    # 再叠一层稍小的金星，做出边缘过渡
    outer2 = outer * 0.86
    star2 = star_points(cx, cy, outer2, inner * 0.86)
    draw.polygon(star2, fill=GOLD + (255,))

    # 星心一点亮
    r_core = W * 0.035
    draw.ellipse([cx - r_core, cy - r_core, cx + r_core, cy + r_core],
                 fill=(255, 245, 210, 255))

    # 缩小到目标尺寸（这一步产生抗锯齿）
    icon = img.resize((SIZE, SIZE), Image.LANCZOS)

    out_dir = os.path.dirname(os.path.abspath(__file__))
    ico_path = os.path.join(out_dir, "tarot.ico")
    png_path = os.path.join(out_dir, "tarot-icon.png")

    # Windows 会按场景挑合适尺寸，所以多存几档
    icon.save(ico_path, format="ICO",
              sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
    icon.save(png_path, format="PNG")

    print("已生成:")
    print("  " + ico_path + "  (" + str(os.path.getsize(ico_path)) + " 字节)")
    print("  " + png_path + "  (" + str(os.path.getsize(png_path)) + " 字节)")


if __name__ == "__main__":
    main()
