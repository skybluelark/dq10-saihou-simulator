# assets-src の生成PNGを 透過化(緑背景アンミックス) + トリム + リサイズ して
# public/mock/assets/ へ出力する
import sys
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
    "btn_undo_normal": (None, 88),   # btn_step_* に置換予定(D45改定)
    "btn_undo_pressed": (None, 88),
    "btn_step_undo_normal": (88, 88),
    "btn_step_undo_pressed": (88, 88),
    "btn_step_undo_disabled": (88, 88),
    "btn_step_redo_normal": (88, 88),
    "btn_step_redo_pressed": (88, 88),
    "btn_step_redo_disabled": (88, 88),
    "btn_primary_normal": (None, 104),
    "btn_primary_pressed": (None, 104),
    "btn_primary_disabled": (None, 104),
    # 9-slice で横に伸ばすため、生成物の縦横比を保って高さ基準で出力(幅は None=自動)
    "btn_secondary_normal": (None, 92),
    "btn_secondary_pressed": (None, 92),
    "chip_on": (None, 64),
    "chip_off": (None, 64),
    # badge_cloth_* は実装側描画(SVG/CSS)に戻したため廃止(2026-07-10)
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
# 白リム外周の落ち影が緑背景と混色し半透明の緑被りが残るパーツ: アンミックス後にGをクランプして中和
SHADOW_CLAMP_PARTS = {"btn_skill_selected"}
# ビネット/焼き込み影で緑背景の明度が不均一なパーツ: 背景色とのRGB距離(絶対値)ではなく
# 色味比率(greenness = 緑超過量 / 最大チャンネル値)で背景判定する。greenness は明度が
# 落ちても(R,B が0のまま暗くなるだけなら)ほぼ不変なので、コーナーのモヤや残存する
# 生の緑画素を確実に検出できる。この12点は素材上に正当な緑色が存在しない前提。
GREEN_WIPE_PARTS = {
    "cell", "cell_shitsuke", "cell_glow", "cell_shitsuke_glow", "cell_ol_target",
    "btn_skill_normal", "btn_skill_pressed", "btn_skill_selected", "btn_skill_disabled",
    "btn_finish_normal", "btn_finish_pressed", "icon_power",
    # 2026-07-11 追加: いずれも正当な緑を含まない(生成り/金/紺)
    "btn_step_undo_normal", "btn_step_undo_pressed", "btn_step_undo_disabled",
    "btn_step_redo_normal", "btn_step_redo_pressed", "btn_step_redo_disabled",
    "chip_on", "chip_off",
}
GREEN_HI = 0.35  # これを超えたら確実に背景 → α=0(solid判定・侵食保護より優先)
GREEN_LO = 0.12  # これ以下は前景 → 既存のdist/erosionロジックに委ねる(中間はAA帯として半透明処理)
# 生成時に全周へ焼き込まれた純白アウトライン(最外周1px・四隅では弧沿いに2px幅)を持つパーツ:
# 透明領域に接する「ほぼ無彩色の白」(unmix後RGBで min>=180 かつ max-min<=50)を外周から
# 連鎖的に剥離して α=0 にする。内側の装飾ハイライト(金色系=彩度あり)で連鎖が止まるため
# 本体には及ばない。btn_undo/btn_header は最外周が金色/暗色のため対象外。
WHITE_RIM_PARTS = {
    "btn_skill_normal", "btn_skill_pressed", "btn_skill_selected", "btn_skill_disabled",
    "btn_finish_normal", "btn_finish_pressed",
}
# 正円ボタン: 円の上下端・左右端は行/列の被覆率が薄く、標準しきい値(15%)のトリムでは
# 縁が切れて非正方形クロップ→88×88圧縮で楕円化する。低しきい値でトリムし、
# 中心維持の正方形+マージン(片側4%)で切り出して真円と縁の完全性を保つ
ROUND_PARTS = {
    "btn_step_undo_normal", "btn_step_undo_pressed", "btn_step_undo_disabled",
    "btn_step_redo_normal", "btn_step_redo_pressed", "btn_step_redo_disabled",
}
# 左右反転で生成するパーツ: 値のIDの原本を水平反転して処理する。
# (redo を生成AIで左右反転させると意図しない差異が入るため、プログラムで鏡像を作る)
MIRROR_SRC = {
    "btn_step_redo_normal": "btn_step_undo_normal",
    "btn_step_redo_pressed": "btn_step_undo_pressed",
    "btn_step_redo_disabled": "btn_step_undo_disabled",
}

def process(name, tw, th):
    src_img = Image.open(SRC / f"{MIRROR_SRC.get(name, name)}.png").convert("RGB")
    if name in MIRROR_SRC:
        src_img = src_img.transpose(Image.FLIP_LEFT_RIGHT)
    img = np.asarray(src_img).astype(np.float32)
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
    elif name in GREEN_WIPE_PARTS:
        maxc = np.maximum(np.maximum(img[..., 0], img[..., 1]), img[..., 2])
        greenness = g_ex / np.maximum(maxc, 1.0)
        bg_maxc = max(bg[0], bg[1], bg[2])
        bg_greenness = max((bg[1] - max(bg[0], bg[2])) / max(bg_maxc, 1.0), 0.05)
        # 中間帯(AA境界)用: 明度非依存の比率でクロマαを再計算(影で暗くなっても破綻しない)
        alpha_chroma_g = np.clip(1.0 - greenness / bg_greenness, 0.0, 1.0)
        alpha = np.where(
            greenness > GREEN_HI, 0.0,
            np.where(
                greenness > GREEN_LO, alpha_chroma_g,
                np.where(er, 1.0, np.where(dist > 20.0, alpha_chroma, 0.0)),
            ),
        )
    else:
        alpha = np.where(er, 1.0, np.where(dist > 20.0, alpha_chroma, 0.0))
    # アンミックス: pixel = fg*a + bg*(1-a) → fg = (pixel - bg*(1-a)) / a
    a3 = alpha[..., None]
    with np.errstate(divide="ignore", invalid="ignore"):
        fg = np.where(a3 > 0.003, (img - bg * (1.0 - a3)) / np.maximum(a3, 0.003), 0.0)
    fg = np.clip(fg, 0, 255)
    if name in SHADOW_CLAMP_PARTS:
        # 白リム外周の落ち影は、緑背景を暗くしただけの色(なお緑相が強い)が dist>25 の
        # solid 判定+3px侵食で「確実な不透明前景」に分類されてしまい、alpha=1 のまま生の
        # 画素値(緑被りを含む)がそのまま fg に通ってしまう。そのため低α画素限定ではなく
        # 全画素で G <= max(R,B) にクランプする(金プレート本体は実測で R,B >= G のため無害)。
        g_clamped = np.minimum(fg[..., 1], np.maximum(fg[..., 0], fg[..., 2]))
        fg[..., 1] = g_clamped
    if name in WHITE_RIM_PARTS:
        minc = np.minimum(np.minimum(fg[..., 0], fg[..., 1]), fg[..., 2])
        maxc_fg = np.maximum(np.maximum(fg[..., 0], fg[..., 1]), fg[..., 2])
        whiteish = (minc >= 180.0) & (maxc_fg - minc <= 50.0) & (alpha > 0.03)
        if name == "btn_skill_pressed":
            # 押下状態のみリムが暗いグレー(~145)に落ちて白判定に掛からないため、
            # 中明度の完全無彩色グレーも対象に加える。本体は紺(B優勢)で連鎖しない。
            # ※disabled はグレーアウト本体が無彩色のためこの条項を適用してはならない。
            whiteish |= (minc >= 90.0) & (maxc_fg - minc <= 20.0) & (alpha > 0.03)
        transparent = alpha <= 0.03

        def neigh(m):
            return (np.roll(m, 1, 0) | np.roll(m, -1, 0)
                    | np.roll(m, 1, 1) | np.roll(m, -1, 1))

        rim = whiteish & neigh(transparent)
        for _ in range(64):
            grown = whiteish & neigh(rim | transparent)
            if not (grown & ~rim).any():
                break
            rim |= grown
        alpha[rim] = 0.0
        print(f"  white rim peeled: {int(rim.sum())} px")
    # トリム: 行/列の被覆率がしきい値以上の範囲を外接矩形とする
    mask = alpha > 0.03
    if name in GLOW_PARTS:
        # 右下のウォーターマーク(✦)を除外してから被覆率を計算し、星の細い先端等を切り落とさないよう低しきい値にする
        wm = np.zeros_like(mask)
        wm[int(0.80 * h):, int(0.80 * w):] = True
        # 被覆率計算だけでなく実データからも消しておく(正方形化で拡張したクロップに
        # ✦の断片が低α画素として入り込まないようにする)
        alpha[wm] = 0.0
        mask &= ~wm
        mask_for_trim = mask
        cov_thresh = 0.005
    elif name in ROUND_PARTS:
        mask_for_trim = mask
        cov_thresh = 0.02
    else:
        mask_for_trim = mask
        cov_thresh = 0.15
    rowfrac = mask_for_trim.mean(axis=1)
    colfrac = mask_for_trim.mean(axis=0)
    rows = np.where(rowfrac > cov_thresh)[0]
    cols = np.where(colfrac > cov_thresh)[0]
    y0, y1, x0, x1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
    # パネル類は正方形前提: 下側に落ち影が混入するため、幅を基準に上端から正方形で切る
    if name.startswith(("panel_window", "panel_grid")):
        y1 = min(y0 + (x1 - x0), h)
    # 発光パーツ・正円ボタンは正円/正方形が前提: トリム後の外接矩形を中心維持で正方形に
    # 拡張する(画像端でクリップ)。正円ボタンは縁が切れないよう片側4%のマージンも付ける
    if name in GLOW_PARTS or name in ROUND_PARTS:
        cy = (y0 + y1) / 2.0
        cx = (x0 + x1) / 2.0
        side = max(y1 - y0, x1 - x0)
        if name in ROUND_PARTS:
            side = int(round(side * 1.08))
        ny0 = int(round(cy - side / 2.0))
        nx0 = int(round(cx - side / 2.0))
        ny1 = ny0 + side
        nx1 = nx0 + side
        if ny0 < 0:
            ny1 -= ny0
            ny0 = 0
        if ny1 > h:
            ny0 -= (ny1 - h)
            ny1 = h
            ny0 = max(ny0, 0)
        if nx0 < 0:
            nx1 -= nx0
            nx0 = 0
        if nx1 > w:
            nx0 -= (nx1 - w)
            nx1 = w
            nx0 = max(nx0, 0)
        y0, y1, x0, x1 = ny0, ny1, nx0, nx1
    # 事前乗算アルファでリサイズ(縁のフリンジ防止)
    premul = np.dstack([fg * a3[..., 0][..., None] / 1.0, alpha * 255.0]).astype(np.uint8)[y0:y1, x0:x1]
    ar_src = (x1 - x0) / (y1 - y0)
    if tw is None:
        tw = round(th * ar_src)
    resized = np.asarray(Image.fromarray(premul, "RGBA").resize((tw, th), Image.LANCZOS)).astype(np.float32)
    ra = resized[..., 3:4] / 255.0
    rgb = np.clip(resized[..., :3] / np.maximum(ra, 1e-3), 0, 255)
    out_arr = np.dstack([rgb, resized[..., 3]]).astype(np.uint8)
    if name in WHITE_RIM_PARTS:
        # 出力解像度での仕上げハロー除去: ソース段階の剥離は列ごとに停止位置が揺れ、
        # LANCZOS縮小がその取り残しを外周へ半透明の白/明灰として滲ませる。@2x表示では
        # 9-sliceコーナーがほぼ等倍で描画されるため、紺縁の外側の明るい画素は1個でも視認される。
        # 透明領域(画像外含む)に接する明るい無彩色画素を最終画素で連鎖除去する。
        o = out_arr.astype(np.float32)
        oa = o[..., 3] / 255.0
        ominc = o[..., :3].min(axis=2)
        omaxc = o[..., :3].max(axis=2)
        if name == "btn_skill_selected":
            # 選択(金)ボタンは縁自体が明るいクリーム〜金(max-minが50以上の暖色)のため、
            # 純白寄りに加え「明るい完全無彩色」(下辺に残る影混じりの白リム: 実測(199,198,188))
            # だけを対象にし、暖色の縁は残す
            bright = (((ominc >= 200.0) & (omaxc - ominc <= 45.0))
                      | ((ominc >= 150.0) & (omaxc - ominc <= 25.0)))
        else:
            bright = (ominc >= 150.0) & (omaxc - ominc <= 80.0)
        bright &= oa > 0.0

        def neigh_pad(m, fill):
            p = np.pad(m, 1, constant_values=fill)
            return p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]

        transparent_o = oa <= 0.03
        halo = bright & neigh_pad(transparent_o, True)  # 画像外は透明扱い
        for _ in range(32):
            grown = bright & neigh_pad(halo | transparent_o, True)
            if not (grown & ~halo).any():
                break
            halo |= grown
        out_arr[halo, 3] = 0
        print(f"  output halo removed: {int(halo.sum())} px")
    # アルファブリード: 透明画素(α=0)のRGBを最近傍の不透明色で埋める。
    # 事前乗算リサイズの逆算(premul/α)は α≈0 でノイズが増幅されて透明画素に白系の
    # ゴミRGBが残り、ブラウザが border-image を端末解像度へ再補間する際に
    # straight-alpha 補間だと「透明白×不透明紺」の中間=白フリンジが縁に出る。
    # 透明画素のRGBを縁の色で埋めておけば補間結果は縁色に収束する。
    # 「色が信頼できる画素」= α≥10/255。それ未満(除算増幅でRGBがノイズ化した極低α画素を含む)は
    # すべてRGBを塗り替える側に回す
    rgbf = out_arr[..., :3].astype(np.float32)
    filled = out_arr[..., 3] >= 10
    rgbf[~filled] = 0.0
    for _ in range(64):
        if filled.all():
            break
        fp = np.pad(filled, 1)
        cp = np.pad(rgbf, ((1, 1), (1, 1), (0, 0)))
        cnt = np.zeros(filled.shape, np.float32)
        acc = np.zeros(rgbf.shape, np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nf = fp[1 + dy:fp.shape[0] - 1 + dy, 1 + dx:fp.shape[1] - 1 + dx]
            nc = cp[1 + dy:cp.shape[0] - 1 + dy, 1 + dx:cp.shape[1] - 1 + dx]
            cnt += nf
            acc += nc * nf[..., None]
        grow = (~filled) & (cnt > 0)
        if not grow.any():
            break
        rgbf[grow] = acc[grow] / cnt[grow][..., None]
        filled |= grow
    out_arr[..., :3] = np.clip(rgbf, 0, 255).astype(np.uint8)
    Image.fromarray(out_arr, "RGBA").save(OUT / f"{name}.png")
    ar_tgt = tw / th
    warn = " <-- AR diff!" if abs(ar_src / ar_tgt - 1) > 0.12 else ""
    print(f"{name}: crop {x1-x0}x{y1-y0} -> {tw}x{th} (AR {ar_src:.2f} -> {ar_tgt:.2f}){warn}")

if len(sys.argv) > 1:
    targets = sys.argv[1:]
    for name in targets:
        tw, th = PARTS[name]
        process(name, tw, th)
    print("done:", len(targets), "files")
else:
    for name, (tw, th) in PARTS.items():
        process(name, tw, th)
    print("done:", len(PARTS), "files")
