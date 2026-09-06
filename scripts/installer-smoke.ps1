$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$installerName = 'OpenCanvas Setup {0}.exe' -f $package.version
$installer = (Resolve-Path -LiteralPath (Join-Path $projectRoot ('release\' + $installerName))).Path
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$target = Join-Path $tempRoot ('opencanvas-installer-smoke-' + [guid]::NewGuid().ToString('N'))
$targetFull = [IO.Path]::GetFullPath($target)

function Assert-SafeSmokeTarget([string]$candidate) {
  $resolved = [IO.Path]::GetFullPath($candidate)
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer smoke target is outside the system temporary directory' }
  if ((Split-Path -Leaf $resolved) -notlike 'opencanvas-installer-smoke-*') { throw 'Installer smoke target does not use the required safe prefix' }
  return $resolved
}

$targetFull = Assert-SafeSmokeTarget $targetFull
$installProcess = Start-Process -FilePath $installer -ArgumentList @('/S', ('/D=' + $targetFull)) -Wait -PassThru -WindowStyle Hidden
if ($installProcess.ExitCode -ne 0) { throw "Installer exit code: $($installProcess.ExitCode)" }

$appExe = Join-Path $targetFull 'OpenCanvas.exe'
if (-not (Test-Path -LiteralPath $appExe)) { throw 'OpenCanvas.exe is missing from the temporary installation' }
$version = (Get-Item -LiteralPath $appExe).VersionInfo.ProductVersion
$uninstaller = Get-ChildItem -LiteralPath $targetFull -File | Where-Object { $_.Name -match '^(Uninstall|unins)' -and $_.Extension -eq '.exe' } | Select-Object -First 1
if (-not $uninstaller) { throw 'The temporary installation does not contain an uninstaller' }

$uninstallProcess = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstaller exit code: $($uninstallProcess.ExitCode)" }

$deadline = [DateTime]::UtcNow.AddSeconds(12)
while ((Test-Path -LiteralPath $targetFull) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
if (Test-Path -LiteralPath $targetFull) {
  $cleanupTarget = Assert-SafeSmokeTarget $targetFull
  Remove-Item -LiteralPath $cleanupTarget -Recurse -Force
}

[pscustomobject]@{
  InstallerExit = $installProcess.ExitCode
  InstalledVersion = $version
  UninstallerExit = $uninstallProcess.ExitCode
  TemporaryInstallRemoved = -not (Test-Path -LiteralPath $targetFull)
}
