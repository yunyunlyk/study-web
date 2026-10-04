"""换图标：把一张方形 PNG 生成 web/icons 里的 4 个尺寸。

用法（在项目根目录下）：

    .venv\\Scripts\\python.exe tools\\make_icons.py 新图标.png

会覆盖这几个文件：

    web/icons/icon-192.png            桌面 / PWA 小图标（公网版会再缩成 96px 内嵌进单文件）
    web/icons/icon-512.png            桌面 / PWA 大图标
    web/icons/apple-touch-icon.png    iPhone / iPad「添加到主屏幕」
    web/icons/icon-maskable-512.png   Android 自适应图标（满幅背景 + 图案居中）

几点说明：

- 源图建议 **512×512 以上、正方形、图案居中、别放小字**（16px 的标签页图标上看不清）。
- 前三个做成**圆角 + 四角透明**，看起来才像 App 图标；
  maskable 那个必须**满幅背景**（系统会自己裁成圆形），所以脚本把四角用边缘颜色涂抹补满。
- 换完之后：**本机版**刷新浏览器（Ctrl+F5）即可；**公网版**要在管理端「发布公网版」
  重新生成一次，并把 `docs/index.html` 提交到仓库才会生效。
"""

import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "web" / "icons"
ROUNDED_CORNER_RATIO = 0.225  # 圆角半径占边长的比例，接近 iOS 图标观感


def rounded(img: Image.Image, size: int) -> Image.Image:
    """缩到 size×size，并把四个角切成透明圆角。"""
    im = img.convert("RGBA").resize((size, size), Image.LANCZOS)
    big = size * 4
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=int(big * ROUNDED_CORNER_RATIO), fill=255)
    im.putalpha(mask.resize((size, size), Image.LANCZOS))
    return im


def fill_corners(img: Image.Image) -> Image.Image:
    """把圆角外面的白底用「向外涂抹边缘颜色」的方式补满，得到满幅背景。"""
    a = np.array(img.convert("RGB"))
    white = a.min(axis=2) >= 245
    for y in range(a.shape[0]):
        row, w = a[y], white[y]
        if w.all():
            continue
        idx = np.where(~w)[0]
        first, last = idx[0], idx[-1]
        row[:first] = row[first]
        row[last + 1:] = row[last]
    return Image.fromarray(a)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    src_path = Path(sys.argv[1]).expanduser()
    if not src_path.is_absolute():
        src_path = (Path.cwd() / src_path).resolve()
    if not src_path.is_file():
        print("找不到这张图：%s" % src_path)
        return 2
    if not ICON_DIR.is_dir():
        print("找不到图标目录：%s" % ICON_DIR)
        return 2

    src = Image.open(src_path)
    w, h = src.size
    print("源图：%s  %d×%d" % (src_path.name, w, h))
    if w != h:
        print("提醒：源图不是正方形，会被拉伸变形；建议先用正方形图。")
    if min(w, h) < 512:
        print("提醒：源图小于 512×512，放大会糊；建议换更大的图。")

    for size, name in ((512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png")):
        out = ICON_DIR / name
        rounded(src, size).save(out, optimize=True)
        print("  写出 %-24s %d×%d  %.1f KB" % (name, size, size, out.stat().st_size / 1024))

    out = ICON_DIR / "icon-maskable-512.png"
    fill_corners(src).resize((512, 512), Image.LANCZOS).save(out, optimize=True)
    print("  写出 %-24s 512×512  %.1f KB（满幅 + 图案居中）" % (out.name, out.stat().st_size / 1024))

    print()
    print("本机版：刷新浏览器（Ctrl+F5）就能看到新图标。")
    print("公网版：管理端 →「发布公网版」→ 生成，然后把 docs/index.html 提交到仓库。")
    return 0


if __name__ == "__main__":
    os.chdir(ROOT)  # 让相对路径都相对项目根目录
    raise SystemExit(main())
