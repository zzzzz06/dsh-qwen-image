# dsh-qwen-image 安装脚本（Windows PowerShell 5.1 / PowerShell 7 均可）
#
# 做三件事：
#   1. 把插件复制到一个固定位置（%USERPROFILE%\.dsh\plugins\dsh-qwen-image），
#      避免你从“下载”目录安装后一清理就失效；
#   2. 用 dsh 自带的 pnpm 把插件装进 profile，并把它写进 profile 的
#      dsh.profile.bundles（少了这一步插件装上了也不会加载）；
#   3. 可选：把你的百炼 API Key 写进 %USERPROFILE%\.dsh\.env。
#
# 每位使用者用自己的 Key —— 这个脚本不包含、也不会去读别人的 Key。
#
# 用法：
#   .\install.ps1                       # 自动找 dsh 和 profile，交互式问 Key
#   .\install.ps1 -ApiKey "sk-xxxx"     # 直接给 Key
#   .\install.ps1 -SkipKey              # 先不配 Key，之后手动配
#   .\install.ps1 -Profile desktop      # 只装到指定 profile
#   .\install.ps1 -DryRun               # 只打印要做什么，不改任何文件
#   .\install.ps1 -Spec dsh-qwen-image  # 从 npm 安装（发布到 npm 之后）

[CmdletBinding()]
param(
    [string]$Profile = '',
    [string]$Spec = '',
    [string]$DshPath = '',
    [string]$ApiKey = '',
    [switch]$SkipKey,
    [switch]$SkipInstall,
    [string]$HomeDir = '',
    [string]$ProfileRoot = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$PackageName = 'dsh-qwen-image'
$KeyEnvName = 'DASHSCOPE_API_KEY'

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host "    $Text" }
function Write-Warn2([string]$Text) { Write-Host "    ! $Text" -ForegroundColor Yellow }

function Resolve-DshCli {
    if ($DshPath) {
        if (Test-Path -LiteralPath $DshPath) { return (Resolve-Path -LiteralPath $DshPath).Path }
        throw "指定的 -DshPath 不存在：$DshPath"
    }
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }

    $roots = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
        (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
        (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness'),
        'C:\ai\dsh'
    )
    foreach ($root in $roots) {
        if (-not $root) { continue }
        $candidate = Join-Path $root 'resources\runtime\cli\bin\dsh.cmd'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "找不到 dsh 命令行。请用 -DshPath 指定，例如：`n  .\install.ps1 -DshPath ""C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"""
}

function Get-TargetProfiles {
    if ($Profile) { return @($Profile) }
    $found = @()
    if (Test-Path -LiteralPath $profilesRoot) {
        foreach ($dir in Get-ChildItem -LiteralPath $profilesRoot -Directory) {
            if (Test-Path -LiteralPath (Join-Path $dir.FullName 'package.json')) { $found += $dir.Name }
        }
    }
    if ($found.Count -eq 0) { $found = @('desktop') }
    return $found
}

function Copy-PluginFiles {
    $src = $sourceDir
    $dst = $pluginHome
    if ([IO.Path]::GetFullPath($src).TrimEnd('\') -ieq [IO.Path]::GetFullPath($dst).TrimEnd('\')) {
        Write-Info "插件已经在这个位置，跳过复制：$dst"
        return
    }
    if ($DryRun) {
        Write-Info "会复制插件到：$dst"
        return
    }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    # 从 package.json 的 files 读取，避免以后新增模块忘记同步复制列表。
    $manifestPath = Join-Path $src 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "找不到插件清单：$manifestPath" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $files = @('package.json') + @($manifest.files)
    foreach ($name in ($files | Select-Object -Unique)) {
        $from = Join-Path $src $name
        if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $dst $name) -Force }
    }
    Write-Info "插件已复制到：$dst"
}

function Get-Manifest([string]$profileName) {
    $path = Join-Path (Join-Path $profilesRoot $profileName) 'package.json'
    if (-not (Test-Path -LiteralPath $path)) {
        throw "找不到 profile 清单：$path`n（先用 dsh 跑一次该 profile，或检查 -Profile 名字）"
    }
    return [pscustomobject]@{ Path = $path; Data = (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json) }
}

function Test-Prop($obj, [string]$name) {
    return ($null -ne $obj) -and ($obj.PSObject.Properties.Name -contains $name)
}

function Ensure-Prop($obj, [string]$name, $value) {
    if (-not (Test-Prop $obj $name)) {
        $obj | Add-Member -MemberType NoteProperty -Name $name -Value $value
    }
}

function Install-Dependency([string]$profileName) {
    # profile 还没初始化时清单不存在：dsh plugin add 会顺手初始化它，所以这里不拦。
    $current = $null
    $profilePath = Join-Path (Join-Path $profilesRoot $profileName) 'package.json'
    if (Test-Path -LiteralPath $profilePath) {
        $data = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
        if (Test-Prop $data 'dependencies') { $current = $data.dependencies.$PackageName }
    }

    $wanted = $Spec
    if (-not $wanted) { $wanted = 'file:' + ($pluginHome -replace '\\', '/') }

    if ($current -and -not $Spec) {
        $normalized = ([string]$current) -replace '^link:', 'file:'
        if ($normalized -ieq $wanted) {
            Write-Info "profile [$profileName] 已指向 $pluginHome，跳过 pnpm 安装"
            return
        }
    }

    if ($DryRun) {
        Write-Info "会执行：dsh plugin --profile $profileName add $wanted"
        return
    }
    Write-Info "安装依赖：$wanted"
    & $dshCli plugin --profile $profileName add $wanted
    if ($LASTEXITCODE -ne 0) {
        throw "安装失败（exit $LASTEXITCODE）。可以先单独跑一次看 pnpm 的输出：`n  & ""$dshCli"" plugin --profile $profileName add ""$wanted"""
    }
}

function Add-BundleEntry([string]$profileName) {
    $manifest = Get-Manifest $profileName
    Ensure-Prop $manifest.Data 'dsh' ([pscustomobject]@{})
    Ensure-Prop $manifest.Data.dsh 'profile' ([pscustomobject]@{})
    Ensure-Prop $manifest.Data.dsh.profile 'bundles' @()

    $bundles = @($manifest.Data.dsh.profile.bundles)
    if ($bundles -contains $PackageName) {
        Write-Info "profile [$profileName] 的 bundles 已包含 $PackageName"
        return
    }
    if ($DryRun) {
        Write-Info "会把 $PackageName 追加到 profile [$profileName] 的 dsh.profile.bundles"
        return
    }
    $manifest.Data.dsh.profile.bundles = @($bundles + $PackageName)
    $json = $manifest.Data | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($manifest.Path, $json + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Info "已把 $PackageName 加入 profile [$profileName] 的 dsh.profile.bundles"
}

function Set-HomeEnvKey([string]$key) {
    $envPath = Join-Path $homeRoot '.env'
    $lines = @()
    if (Test-Path -LiteralPath $envPath) { $lines = @(Get-Content -LiteralPath $envPath) }

    $replaced = $false
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        if ($line -match '^\s*(?:export\s+)?DASHSCOPE_API_KEY\s*=') {
            $out.Add("$KeyEnvName=$key")
            $replaced = $true
        } else {
            $out.Add($line)
        }
    }
    if (-not $replaced) {
        if ($out.Count -gt 0 -and $out[$out.Count - 1].Trim() -ne '') { $out.Add('') }
        $out.Add('# 百炼（DashScope）API Key，qwen-image 插件会读这一行')
        $out.Add("$KeyEnvName=$key")
    }

    if ($DryRun) {
        Write-Info "会把 $KeyEnvName 写入：$envPath"
        return
    }
    [IO.File]::WriteAllText($envPath, (($out -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    $env:DASHSCOPE_API_KEY = $key
    Write-Info "已写入：$envPath"
}

# ---------------------------------------------------------------- main

$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $HomeDir) {
    $homeRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
} else {
    $homeRoot = $HomeDir
}
$profilesRoot = if ($ProfileRoot) { $ProfileRoot } else { Join-Path $homeRoot 'profiles' }
$pluginHome = Join-Path $homeRoot 'plugins\dsh-qwen-image'

try {
    Write-Host ''
    Write-Host '  dsh-qwen-image 安装' -ForegroundColor White
    Write-Host '  --------------------------------' -ForegroundColor DarkGray

    $dshCli = Resolve-DshCli
    Write-Info "dsh     : $dshCli"

    $targets = Get-TargetProfiles
    Write-Info "profile : $($targets -join ', ')"
    Write-Info "安装到  : $pluginHome"
    if ($DryRun) { Write-Warn2 'DryRun：只打印，不修改任何文件、不执行 pnpm' }
    Write-Host ''

    Write-Step '复制插件'
    Copy-PluginFiles

    foreach ($name in $targets) {
        Write-Step "安装到 profile [$name]"
        if ($SkipInstall) {
            Write-Info '按 -SkipInstall 跳过 pnpm 安装'
        } else {
            Install-Dependency $name
        }
        Add-BundleEntry $name
    }

    if (-not $SkipKey) {
        Write-Step '配置 API Key'
        $key = $ApiKey
        if (-not $key) {
            if ($DryRun) {
                Write-Info '（DryRun 不提问）'
            } else {
                Write-Host '    每位使用者填自己的百炼 API Key（控制台 - 百炼 - API-KEY 里创建）。' -ForegroundColor DarkGray
                $key = Read-Host '    粘贴 API Key（直接回车跳过）'
            }
        }
        $key = ("$key").Trim()
        if ($key) {
            if (-not $key.StartsWith('sk-')) { Write-Warn2 '这个 Key 不像百炼的格式（通常以 sk- 开头），仍然写入，稍后可用 smoke.ps1 验证。' }
            Set-HomeEnvKey $key
        } else {
            Write-Info '已跳过。之后可重跑本脚本，或自己把 DASHSCOPE_API_KEY=sk-... 写进 .env。'
        }
    }

    Write-Host ''
    Write-Step '完成'
    Write-Host '    1) 完全退出并重新启动 DeepSeek Harness（host 插件在启动时加载，刷新页面不够）'
    Write-Host '    2) 到 Plugins 页确认能看到 dsh-qwen-image'
    Write-Host '    3) 在对话里说：「画一只戴宇航头盔的橘猫，扁平插画风」'
    if (-not $key -and -not $SkipKey) {
        Write-Host '    Key 还没配？重跑 install.ps1，或手动编辑 %USERPROFILE%\.dsh\.env' -ForegroundColor Yellow
    }
    Write-Host ''
} catch {
    Write-Host ''
    Write-Host "安装失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}