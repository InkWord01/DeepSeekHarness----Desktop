# fix-wincodesign.ps1 — 解压所有未解压的 winCodeSign 缓存（排除 darwin 符号链接）
$ErrorActionPreference = "Stop"
$cache = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"
$za = "D:\dsHarness\dsh-desktop\node_modules\7zip-bin\win\x64\7za.exe"
if (-not (Test-Path $cache)) { Write-Host "no cache dir"; exit 0 }
$fixed = $false
Get-ChildItem $cache -Filter "*.7z" -File | ForEach-Object {
  $id = $_.BaseName
  $out = Join-Path $cache $id
  $marker = Join-Path $out "windows-10\x64\signtool.exe"
  if (-not (Test-Path $marker)) {
    Write-Host "Fixing $id ..."
    if (Test-Path $out) { Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue }
    & $za x $_.FullName "-o$out" -y -xr!darwin 2>&1 | Out-Null
    $fixed = $true
  }
}
if (-not $fixed) { Write-Host "all winCodeSign caches already fixed" }