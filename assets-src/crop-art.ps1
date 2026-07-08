# ui-sheet-01.png からパーツを切り出し、角丸透過マスクを適用して保存する
Add-Type -AssemblyName System.Drawing

$src = 'E:\dev\dq10-saihou-simulator\assets-src\ui-sheet-01.png'
$outDir = 'E:\dev\dq10-saihou-simulator\public\mock\assets'
$sheet = New-Object System.Drawing.Bitmap($src)

# 内容判定: 市松(無彩色の暗グレー)以外を内容とみなす
function Test-Content($px) {
  $mx = [Math]::Max([Math]::Max($px.R, $px.G), $px.B)
  $mn = [Math]::Min([Math]::Min($px.R, $px.G), $px.B)
  return ($mx -gt 90) -or (($mx - $mn) -gt 15)
}

# 指定ゾーン内の内容バウンディングボックスを求める(2px間引き走査)
function Get-Bounds($x0, $y0, $x1, $y1) {
  $minX = $x1; $minY = $y1; $maxX = $x0; $maxY = $y0
  for ($y = $y0; $y -lt $y1; $y += 2) {
    for ($x = $x0; $x -lt $x1; $x += 2) {
      $p = $sheet.GetPixel($x, $y)
      if (Test-Content $p) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  return @($minX, $minY, $maxX, $maxY)
}

# 角丸マスク付き切り出し(radius=0 なら矩形のまま)
function Save-Crop($x, $y, $w, $h, $radius, $name) {
  $out = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $crop = $sheet.Clone((New-Object System.Drawing.Rectangle($x, $y, $w, $h)), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  if ($radius -le 0) {
    $g.DrawImage($crop, 0, 0, $w, $h)
  } else {
    $brush = New-Object System.Drawing.TextureBrush($crop)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($w - $d, 0, $d, $d, 270, 90)
    $path.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
    $path.AddArc(0, $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath($brush, $path)
    $brush.Dispose(); $path.Dispose()
  }
  $g.Dispose(); $crop.Dispose()
  $out.Save((Join-Path $outDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  "saved $name ($w x $h from $x,$y r=$radius)"
}

# ---- 目視座標による切り出し(確認しながら調整する) ----
Save-Crop 47 59 607 399 44 'art_panel_window.png'
Save-Crop 50 571 125 52 14 'art_btn_normal.png'
Save-Crop 190 571 119 52 14 'art_btn_navy_gold.png'
Save-Crop 328 571 123 52 14 'art_btn_selected.png'
Save-Crop 462 571 124 52 14 'art_btn_disabled.png'
Save-Crop 604 570 58 56 14 'art_chip.png'
Save-Crop 760 145 580 465 0 'art_bg_main.png'

$sheet.Dispose()
