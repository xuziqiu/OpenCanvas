Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$buildDirectory = Join-Path $projectRoot 'build'
$targetPath = Join-Path $buildDirectory 'icon.png'
New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null

$bitmap = New-Object System.Drawing.Bitmap 512, 512, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

function New-RoundedRectanglePath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

$surface = New-RoundedRectanglePath 28 28 456 456 108
$surfaceBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
  (New-Object System.Drawing.Point 70, 54),
  (New-Object System.Drawing.Point 450, 470),
  ([System.Drawing.Color]::FromArgb(255, 57, 205, 192)),
  ([System.Drawing.Color]::FromArgb(255, 20, 151, 173))
)
$graphics.FillPath($surfaceBrush, $surface)

$glyphPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(248, 255, 255, 255)), 30
$glyphPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$glyphPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$glyphPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

$left = New-Object System.Drawing.Drawing2D.GraphicsPath
$left.StartFigure()
$left.AddBezier(116, 154, 158, 136, 204, 145, 256, 184)
$left.AddLine(256, 184, 256, 360)
$left.AddBezier(256, 360, 207, 326, 160, 320, 116, 340)
$right = New-Object System.Drawing.Drawing2D.GraphicsPath
$right.StartFigure()
$right.AddBezier(396, 154, 354, 136, 308, 145, 256, 184)
$right.AddLine(256, 184, 256, 360)
$right.AddBezier(256, 360, 305, 326, 352, 320, 396, 340)
$graphics.DrawPath($glyphPen, $left)
$graphics.DrawPath($glyphPen, $right)

$centerPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(205, 255, 255, 255)), 16
$centerPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$centerPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($centerPen, 256, 184, 256, 360)

$bitmap.Save($targetPath, [System.Drawing.Imaging.ImageFormat]::Png)

$centerPen.Dispose()
$glyphPen.Dispose()
$left.Dispose()
$right.Dispose()
$surfaceBrush.Dispose()
$surface.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output $targetPath
