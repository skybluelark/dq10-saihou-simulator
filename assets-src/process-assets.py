# assets-src の生成PNGを 透過化(緑背景アンミックス) + トリム + リサイズ して
# public/mock/assets/ へ出力する
import numpy as np
from PIL import Image
from pathlib import Path

SRC = Path(r"E:\dev\dq10-saihou-simulator\assets-src")
OUT = Path(r"E:\dev\dq10-saihou-simulator\public\mock\assets")

# id: (target_w, target_h)  — §4.4 の作成px(@2x)
PARTS = {
    "bg_main": (860, 1864),
    "panel_window": (384, 384),          # 結果窓の表示幅28px(56dev px)に耐えるよう角96で拡大採用
    "panel_grid_normal": (128, 128),
    "panel_grid_regen": (128, 128),
    "panel_grid_rainbow": (128, 128),
    "panel_grid_light": (128, 128),
    "cell": (176, 116),
    "cell_shitsuke": (176, 116),
    "cell_glow": (176, 116),
    "cell_shitsuke_glow": (176, 116),
    "cell_ol_target": (176, 116),
    # ※9-slice対象(btn_skill/finish/undo/primary/secondary, chip)は幅None=縦横比保持
    #   (border-image で伸縮するため元のARを保つ方が装飾が歪まない)
    "badge_trait_regen": (30, 30),
    "badge_trait_rain_half": (30, 30),
    "badge_trait_rain_crit": (30, 30),
    "badge_trait_light": (30, 30),
    "badge_sparkle": (30, 30),
    "btn_header_normal": (152, 80),
    "btn_header_pressed": (152, 80),
    "btn_skill_normal": (None, 88),
    "btn_skill_pressed": (None, 88),
    "btn_skill_selected": (None, 88),
    "btn_skill_disabled": (None, 88),
    "btn_finish_normal": (None, 88),
    "btn_finish_pressed": (None, 88),
    "btn_undo_normal": (None, 88),
    "btn_undo_pressed": (None, 88),
    "btn_primary_normal": (None, 104),
    "btn_primary_pressed": (None, 104),
    "btn_primary_disabled": (None, 104),
    # 9-slice で横に伸ばすため、生成物の縦横比を保って高さ基準で出力(幅は None=自動)
    "btn_secondary_normal": (None, 92),
    "btn_secondary_pressed": (None, 92),
    "chip_on": (None, 64),
    "chip_off": (None, 64),
    "badge_cloth_regen": (100, 40),
    "badge_cloth_rainbow": (100, 40),
    "badge_cloth_light": (100, 40),
    "badge_cloth_normal": (100, 40),
    "star_result_on": (80, 80),
    "star_result_off": (80, 80),
    "plate_crit": (120, 48),
    "icon_power": (116, 64),
    "label_power": (136, 48),
}
# fx_hissatsu は黒背景コマ連番のため対象外(演出実装時に別処理)

T = 90.0  # 背景色からのRGB距離がこの値でアルファ1になる

# 広い発光減衰を持つパーツ: 全域クロマαで抜く(fg に緑成分を含まないことが前提)
GLOW_PARTS = {"star_result_on", "star_result_off", "badge_sparkle"}

def process(name, tw, th):
    img = np.asarray(Image.open(SRC / f"{name}.png").convert("RGB")).astype(np.float32)
    h, w, _ = img.shape
    # 背景色 = 外周1pxの中央値
    border = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.sqrt(((img - bg) ** 2).sum(axis=2))
    solid = dist > 25.0
    # 3px 侵食した確実な内部は α=1(緑がかった布地等を保護)
    er = solid.copy()
    for dy in (-3, -2, -1, 0, 1, 2, 3):
        for dx in (-3, -2, -1, 0, 1, 2, 3):
            er &= np.roll(np.roll(solid, dy, 0), dx, 1)
    # 境界・グロー帯は緑過剰(G - max(R,B))から α を推定(混色の unmix 用)
    g_ex = img[..., 1] - np.maximum(img[..., 0], img[..., 2])
    bg_ex = max(bg[1] - max(bg[0], bg[2]), 1.0)
    alpha_chroma = np.clip(1.0 - g_ex / bg_ex, 0.0, 1.0)
    if name in GLOW_PARTS:
        alpha = np.where(dist > 15.0, alpha_chroma, 0.0)
    else:
        alpha = np.where(er, 1.0, np.where(dist > 20.0, alpha_chroma, 0.0))
    # アンミックス: pixel = fg*a + bg*(1-a) → fg = (pixel - bg*(1-a)) / a
    a3 = alpha[..., None]
    with np.errstate(divide="ignore", invalid="ignore"):
        fg = np.where(a3 > 0.003, (img - bg * (1.0 - a3)) / np.maximum(a3, 0.003), 0.0)
    fg = np.clip(fg, 0, 255)
    # トリム: 右下のウォーターマーク(✦)を無視するため、行/列の被覆率が5%以上の範囲を外接矩形とする
    mask = alpha > 0.03
    rowfrac = mask.mean(axis=1)
    colfrac = mask.mean(axis=0)
    rows = np.where(rowfrac > 0.15)[0]
    cols = np.where(colfrac > 0.15)[0]
    y0, y1, x0, x1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
    # パネル類は正方形前提: 下側に落ち影が混入するため、幅を基準に上端から正方形で切る
    if name.startswith(("panel_window", "panel_grid")):
        y1 = min(y0 + (x1 - x0), h)
    # 事前乗算アルファでリサイズ(縁のフリンジ防止)
    premul = np.dstack([fg * a3[..., 0][..., None] / 1.0, alpha * 255.0]).astype(np.uint8)[y0:y1, x0:x1]
    ar_src = (x1 - x0) / (y1 - y0)
    if tw is None:
        tw = round(th * ar_src)
    resized = np.asarray(Image.fromarray(premul, "RGBA").resize((tw, th), Image.LANCZOS)).astype(np.float32)
    ra = resized[..., 3:4] / 255.0
    rgb = np.clip(resized[..., :3] / np.maximum(ra, 1e-3), 0, 255)
    out_arr = np.dstack([rgb, resized[..., 3]]).astype(np.uint8)
    Image.fromarray(out_arr, "RGBA").save(OUT / f"{name}.png")
    ar_tgt = tw / th
    warn = " <-- AR diff!" if abs(ar_src / ar_tgt - 1) > 0.12 else ""
    print(f"{name}: crop {x1-x0}x{y1-y0} -> {tw}x{th} (AR {ar_src:.2f} -> {ar_tgt:.2f}){warn}")

for name, (tw, th) in PARTS.items():
    process(name, tw, th)
print("done:", len(PARTS), "files")
