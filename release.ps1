[CmdletBinding()]
param(
  [string]$Repository = $env:GITHUB_REPOSITORY,
  [string]$Notes = '',
  [string]$Tag = $env:GITHUB_REF_NAME,
  [switch]$AllowTemplate
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$packagePath = Join-Path $root 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw -Encoding utf8 | ConvertFrom-Json
$version = [string]$package.version

if (-not $Repository) {
  throw '缺少仓库名。请传 -Repository owner/repo，或设置 GITHUB_REPOSITORY。'
}
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw "仓库名不合法：$Repository"
}
if ($Tag -and $Tag -ne "v$version") {
  throw "tag $Tag 和 package.json 版本 $version 不一致"
}

$dist = Join-Path $root 'dist'
$stageRoot = Join-Path $dist 'stage'
$stagePlugin = Join-Path $stageRoot 'dsh-qwen-image'
$zipName = "dsh-qwen-image-$version.zip"
$zipPath = Join-Path $dist $zipName

if (Test-Path -LiteralPath $dist) {
  Remove-Item -LiteralPath $dist -Recurse -Force
}
New-Item -ItemType Directory -Path $stagePlugin -Force | Out-Null

$payload = @('package.json') + @($package.files)
foreach ($file in $payload) {
  $source = Join-Path $root $file
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "package.json.files 里有文件不存在：$file"
  }
  $target = Join-Path $stagePlugin $file
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target
}

Compress-Archive -LiteralPath $stagePlugin -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$shaPath = "$zipPath.sha256"
Set-Content -LiteralPath $shaPath -Value "$hash  $zipName" -Encoding ascii

$manifest = [ordered]@{
  version     = $version
  url         = "https://github.com/$Repository/releases/latest/download/$zipName"
  sha256      = $hash
  publishedAt = (Get-Date).ToString('yyyy-MM-dd')
  notes       = $Notes
}
$manifestPath = Join-Path $dist 'latest.json'
$manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $manifestPath -Encoding utf8

$sourcePath = Join-Path $root 'update-source.json'
if (Test-Path -LiteralPath $sourcePath) {
  $source = Get-Content -LiteralPath $sourcePath -Raw -Encoding utf8 | ConvertFrom-Json
  if ([string]$source.manifestUrl -match '/OWNER/|/REPO/') {
    $message = "update-source.json 仍是模板地址，发布前请改成：https://github.com/$Repository/releases/latest/download/latest.json"
    if (-not $AllowTemplate) { throw $message }
    Write-Warning $message
  }
}

Write-Host "built  : $zipPath"
Write-Host "sha256 : $hash"
Write-Host "manifest: $manifestPath"
Write-Host "release : gh release create v$version --repo $Repository dist/$zipName dist/$zipName.sha256 dist/latest.json"