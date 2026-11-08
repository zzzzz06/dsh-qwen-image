# 不装 DSH 也能先验证 API：用 dsh 自带的 node 跑 smoke.mjs（不依赖 PATH 里的 node）。
#   .\smoke.ps1
#   .\smoke.ps1 "一只戴宇航头盔的橘猫"
# Key 从 DASHSCOPE_API_KEY 环境变量、~/.dsh/.env 或 ~/.dsh/.credentials.yaml 读。
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Prompt)

$ErrorActionPreference = "Stop"

$candidates = @()
if ($env:DSH_DESKTOP_NODE_EXECUTABLE) { $candidates += $env:DSH_DESKTOP_NODE_EXECUTABLE }
if ($env:USERPROFILE) {
    $candidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
}
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $candidates += $cmd.Source }

$node = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $node) {
    throw "找不到 node：既没有 dsh 内置 node，PATH 里也没有。可以用 -Node 手动指定。"
}

$argsList = @((Join-Path $PSScriptRoot "smoke.mjs"))
if ($Prompt) { $argsList += $Prompt }

& $node @argsList