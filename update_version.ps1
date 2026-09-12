<#
.SYNOPSIS
    自动更新 sw.js 中的 Service Worker 缓存版本号（CACHE_NAME 与 self.APP_VERSION）。

.DESCRIPTION
    1. 以脚本执行时的系统时间生成版本号，格式严格为 yyyy-MM-dd-HHmm（如 2026-09-12-1124）；
    2. 通过精确正则匹配并替换 sw.js 中的两处版本声明：
         var CACHE_NAME = 'dormitory-cache-{版本号}';
         self.APP_VERSION = '{版本号}';
    3. 每处声明必须且只能命中 1 次，否则中止写入并报错，绝不破坏文件其他内容；
    4. 文件以 UTF-8（无 BOM）写回，保留原有换行格式与全部其他内容。

    使用场景：每次修改任何 .js / .html 文件后运行本脚本（Service Worker 对同源
    JS 采用 cache-first，不升版本号则已打开过应用的设备会持续加载旧缓存）。

.NOTES
    适用于 Windows PowerShell 5.1 与 PowerShell 7+。
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ---------- 1. 基于脚本执行时的系统时间生成版本号（严格 yyyy-MM-dd-HHmm） ----------
$version = Get-Date -Format 'yyyy-MM-dd-HHmm'

# ---------- 2. 定位与本脚本同目录的 sw.js ----------
$swPath = Join-Path $PSScriptRoot 'sw.js'
if (-not (Test-Path -LiteralPath $swPath)) {
    throw "未找到 sw.js（期望路径：$swPath）。请将 update_version.ps1 放在项目根目录后重试。"
}

# ---------- 3. 以 UTF-8 读取原文（sw.js 含中文注释，不能按默认 ANSI 编码读取） ----------
$content = [System.IO.File]::ReadAllText($swPath, [System.Text.Encoding]::UTF8)

# ---------- 4. 精确正则：仅匹配单行变量声明，引号内旧版本号为 [^'"\r\n]* ----------
# CACHE_NAME 行：锁定 "var CACHE_NAME = 'dormitory-cache-…';"
$cachePattern = '(?m)(?<pre>^[ \t]*var[ \t]+CACHE_NAME[ \t]*=[ \t]*[''"])dormitory-cache-[^''"\r\n]*(?<post>[''"][ \t]*;)'
# APP_VERSION 行：锁定 "self.APP_VERSION = '…';"
$appPattern   = '(?m)(?<pre>^[ \t]*self\.APP_VERSION[ \t]*=[ \t]*[''"])[^''"\r\n]*(?<post>[''"][ \t]*;)'

$cacheMatches = [regex]::Matches($content, $cachePattern)
$appMatches   = [regex]::Matches($content, $appPattern)

# 安全校验：两处声明各必须且只能命中 1 次，否则不做任何写入
if ($cacheMatches.Count -ne 1 -or $appMatches.Count -ne 1) {
    throw "sw.js 版本声明匹配异常（CACHE_NAME 命中 $($cacheMatches.Count) 处，APP_VERSION 命中 $($appMatches.Count) 处；预期各 1 处）。已取消写入，请检查 sw.js 顶部声明是否被改动。"
}

$oldCacheLine = $cacheMatches[0].Value.Trim()
$oldAppLine   = $appMatches[0].Value.Trim()

# ---------- 5. 替换为新版本号（版本号仅含数字与连字符，不会污染正则替换语法） ----------
$content = [regex]::Replace($content, $cachePattern, '${pre}dormitory-cache-' + $version + '${post}')
$content = [regex]::Replace($content, $appPattern,   '${pre}' + $version + '${post}')

# ---------- 6. UTF-8 无 BOM 写回（PS 5.1 的 Set-Content -Encoding UTF8 会带 BOM，故用 .NET API） ----------
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($swPath, $content, $utf8NoBom)

# ---------- 7. 结果输出 ----------
Write-Host ''
Write-Host ("sw.js 版本号已同步更新：{0}" -f $version) -ForegroundColor Green
Write-Host ("  CACHE_NAME : {0}" -f $oldCacheLine) -ForegroundColor DarkGray
Write-Host ("             -> var CACHE_NAME = 'dormitory-cache-{0}';" -f $version)
Write-Host ("  APP_VERSION: {0}" -f $oldAppLine) -ForegroundColor DarkGray
Write-Host ("             -> self.APP_VERSION = '{0}';" -f $version)
if ($oldAppLine -like ('*' + $version + '*')) {
    Write-Host '提示：文件中版本号与新时间戳相同（可能在同一分钟内重复执行），内容未发生变化。' -ForegroundColor Yellow
}
Write-Host ''
