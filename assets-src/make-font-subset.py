# GenEi LateMin P v2 Medium を mock 使用文字でサブセット化して woff2 出力(再利用時は再実行)
import io, re, sys
from pathlib import Path
from fontTools.ttLib import TTCollection
from fontTools import subset

SRC = Path(r"C:\Users\skybl\AppData\Local\Microsoft\Windows\Fonts\GenEiLateMin_v2.ttc")
MOCK_DIR = Path(r"E:\dev\dq10-saihou-simulator\public\mock")
OUT = MOCK_DIR / "assets" / "fonts" / "GenEiLateMinP_v2_subset.woff2"

# モックHTMLからテキスト文字を収集(タグ・スクリプトも含め全文字を拾って安全側に倒す)
chars = set()
for name in ("index.html", "recipe-select.html"):
    text = (MOCK_DIR / name).read_text(encoding="utf-8")
    chars.update(text)

# 予備: ASCII全域 + よく使う記号・全角
extra = (
    "".join(chr(c) for c in range(0x20, 0x7F))
    + "×２？！ー〜、。・「」()（）:：%％+－±→←↑↓▼▲▾▸★☆◎○△×"
    + "0123456789０１２３４５６７８９"
)
chars.update(extra)
chars.discard("\n"); chars.discard("\r"); chars.discard("\t")

col = TTCollection(str(SRC))
font = col.fonts[1]  # GenEi LateMin P v2 Medium

opts = subset.Options()
opts.flavor = "woff2"
opts.layout_features = ["*"]
opts.name_IDs = [0, 1, 2, 3, 4, 6, 13, 14]  # 著作権・ライセンス関係のnameは保持
opts.drop_tables += ["vhea", "vmtx"]

ss = subset.Subsetter(options=opts)
ss.populate(text="".join(sorted(chars)))
ss.subset(font)

OUT.parent.mkdir(parents=True, exist_ok=True)
font.flavor = "woff2"
font.save(str(OUT))
print("chars:", len(chars))
print("out:", OUT, OUT.stat().st_size, "bytes")
