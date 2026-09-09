$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://localhost:8765/')
$listener.Start()
Write-Host "Serving $root at http://localhost:8765/ (no-cache)"

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
}

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
    } catch {
        break
    }
    $req = $ctx.Request
    $res = $ctx.Response

    $rawUrl = $req.Url.AbsolutePath
    $rel = [System.Uri]::UnescapeDataString($rawUrl).TrimStart('/')
    if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }

    $path = Join-Path $root ($rel -replace '/', '\')
    $full = [System.IO.Path]::GetFullPath($path)
    $rootFull = [System.IO.Path]::GetFullPath($root)

    $res.Headers.Add('Cache-Control', 'no-cache, no-store, must-revalidate')
    $res.Headers.Add('Pragma', 'no-cache')
    $res.Headers.Add('Expires', '0')

    if (-not $full.StartsWith($rootFull) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $res.StatusCode = 404
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found: ' + $rel)
        $res.ContentType = 'text/plain; charset=utf-8'
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        $res.Close()
        Write-Host "404 $rel"
        continue
    }

    $ext = [System.IO.Path]::GetExtension($full).ToLower()
    if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = 'application/octet-stream' }

    $data = [System.IO.File]::ReadAllBytes($full)
    $res.ContentLength64 = $data.Length
    $res.StatusCode = 200
    $res.OutputStream.Write($data, 0, $data.Length)
    $res.Close()
    Write-Host "200 $rel ($($data.Length) bytes)"
}
