# fx_hissatsu.png(黒背景・白枠罫の6コマ縦シート)を切り出し、
# 輝度→アルファ変換(黒=透明。加算合成の見た目を通常合成で近似)して
# スプライトシート public/mock/assets/fx_hissatsu_sheet.png を出力する
import numpy as np
from PIL import Image
from pathlib import Path

SRC = Path(r"E:\dev\dq10-saihou-simulator\assets-src\fx_hissatsu.png")
OUT = Path(r"E:\dev\dq10-saihou-simulator\public\mock\assets\fx_hissatsu_sheet.png")

# 表示: 布グリッド幅(約280dp)に重ねる → @2x 560px 幅
TW = 560

img = np.asarray(Image.open(SRC).convert("RGB")).astype(np.float32)
h, w, _ = img.shape

# 枠線検出(黒地に白線): 行/列平均輝度のピーク
lum = img.mean(axis=2)
rows = lum.mean(axis=1)
cols = lum.mean(axis=0)
row_lines = [y for y in range(h) if rows[y] > 60]
col_lines = [x for x in range(w) if cols[x] > 60]


def runs(idx):
    out = []
    s = p = idx[0]
    for v in idx[1:]:
        if v > p + 2:
            out.append((s, p))
            s = v
        p = v
    out.append((s, p))
    return out


rr = runs(row_lines)
cc = runs(col_lines)
assert len(cc) == 2, f"expected 2 col lines, got {cc}"
x0, x1 = cc[0][1] + 2, cc[1][0] - 1
cells = []
for (a, b), (c, d) in zip(rr[:-1], rr[1:]):
    cells.append((b + 2, c - 1))
assert len(cells) == 6, f"expected 6 cells, got {len(cells)}"

frames = []
th = None
for (y0, y1) in cells:
    cell = img[y0:y1, x0:x1]
    if th is None:
        th = round(TW * cell.shape[0] / cell.shape[1])
    # 輝度→α: a = max(R,G,B)/255。色は unpremultiply(暗い火花も彩度を保つ)
    a = cell.max(axis=2) / 255.0
    rgb = np.clip(cell / np.maximum(a[..., None], 1e-3), 0, 255)
    premul = np.dstack([rgb * a[..., None], a * 255.0]).astype(np.uint8)
    fr = Image.fromarray(premul, "RGBA").resize((TW, th), Image.LANCZOS)
    arr = np.asarray(fr).astype(np.float32)
    ra = arr[..., 3:4] / 255.0
    out_rgb = np.clip(arr[..., :3] / np.maximum(ra, 1e-3), 0, 255)
    out = np.dstack([out_rgb, arr[..., 3]]).astype(np.uint8)
    # 低α画素のRGBノイズ対策(アルファブリードの簡易版: α<10 はRGBを0=黒でよい。
    # 火花はグローで縁が暗橙に落ちるため黒への収束はフリンジにならない)
    low = out[..., 3] < 10
    out[low, 0] = out[low, 1] = out[low, 2] = 0
    frames.append(out)

sheet = np.concatenate(frames, axis=0)
Image.fromarray(sheet, "RGBA").save(OUT)
print(f"fx_hissatsu_sheet: {len(frames)} frames x {TW}x{th} -> {sheet.shape[1]}x{sheet.shape[0]}")
