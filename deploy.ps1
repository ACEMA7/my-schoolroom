# ============================================================
# deploy.ps1 —— 宿舍系统自动提交并推送到 GitHub
# 用法：
#   .\deploy.ps1                    # 自动生成 commit message（时间戳）
#   .\deploy.ps1 "修复同步日志问题"  # 自定义 commit message
#   .\deploy.ps1 -SkipSWCheck       # 跳过 SW 版本检查
# ============================================================
param(
    [Parameter(Position = 0)]
    [string]$CommitMsg = "",
    [switch]$SkipSWCheck
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

function Write-Step($msg)  { Write-Host "`n▶ $msg" -ForegroundColor Cyan }
function Write-OK($msg)    { Write-Host "  ✅ $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  ⚠️  $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "  ❌ $msg" -ForegroundColor Red }

# ── 1. 检查 git 仓库 ──
Write-Step "检查 Git 环境"
$null = git --no-pager rev-parse --is-inside-work-tree 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Err "当前目录不是 Git 仓库，终止。"
    exit 1
}
$branch = git --no-pager branch --show-current
$remote = git --no-pager remote -v | Select-String "push" | ForEach-Object { ($_ -split "\s+")[1] }
Write-OK "分支: $branch"
Write-OK "远程: $remote"

# ── 2. 检查是否有改动 ──
Write-Step "检查待提交文件"
$changes = git --no-pager status --porcelain
if (-not $changes) {
    Write-Warn2 "没有检测到文件改动，无需提交。"
    exit 0
}
Write-Host "  以下文件将被提交：" -ForegroundColor Gray
$changes | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }

# ── 3. 可选：检查 SW 版本是否已更新 ──
if (-not $SkipSWCheck) {
    Write-Step "检查 Service Worker 版本"
    $swContent = Get-Content "sw.js" -Raw -ErrorAction SilentlyContinue
    if ($swContent -and $swContent -match "APP_VERSION\s*=\s*'([^']+)'") {
        Write-OK "当前 SW 版本: $($Matches[1])"
    } else {
        Write-Warn2 "未检测到 sw.js 版本号，确认改动后手动运行 update_version.ps1"
    }
}

# ── 4. 生成或使用 commit message ──
if (-not $CommitMsg) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $fileCount = ($changes | Measure-Object).Count
    $CommitMsg = "deploy: $fileCount 个文件改动 ($timestamp)"
}
Write-Step "提交信息"
Write-Host "  $CommitMsg" -ForegroundColor White

# ── 5. 确认提交 ──
Write-Host "`n  按回车确认提交并推送，按 Ctrl+C 取消..." -ForegroundColor Yellow
$null = Read-Host

# ── 6. git add + commit + push ──
Write-Step "执行 git add"
git add -A
if ($LASTEXITCODE -ne 0) { Write-Err "git add 失败"; exit 1 }
Write-OK "已暂存所有改动"

Write-Step "执行 git commit"
git commit -m $CommitMsg
if ($LASTEXITCODE -ne 0) {
    Write-Err "git commit 失败（可能没有实际改动）"
    exit 1
}
$commitHash = git --no-pager rev-parse --short HEAD
Write-OK "已提交: $commitHash"

Write-Step "执行 git push"
git push origin $branch
if ($LASTEXITCODE -ne 0) {
    Write-Err "git push 失败，请检查网络或权限"
    Write-Host "  提示：如果是首次推送或鉴权问题，尝试 git push -u origin $branch" -ForegroundColor Gray
    exit 1
}
Write-OK "已推送到 origin/$branch"

# ── 7. 完成 ──
Write-Host "`n🎉 部署完成！" -ForegroundColor Green
Write-Host "  GitHub Actions 将自动构建并部署到 GitHub Pages。" -ForegroundColor Gray
Write-Host "  约 1~2 分钟后访问线上页面，清除 SW 缓存即可加载新版本。" -ForegroundColor Gray
