# Runs the original OrientMe app on a selected company-network IPv4 address.
# The existing frontend and backend behavior stays unchanged; only runtime settings are supplied here.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$BindAddress
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($BindAddress, [ref]$parsedAddress) -or
    $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw 'BindAddress must be a local IPv4 address.'
}
if (-not (Get-NetIPAddress -AddressFamily IPv4 -IPAddress $BindAddress -ErrorAction SilentlyContinue)) {
    throw "The address $BindAddress is not assigned to this computer. Use an address shown by ipconfig."
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$backend = Join-Path $repoRoot 'orientme-app\backend'
$frontend = Join-Path $repoRoot 'orientme-app\frontend'
$runtime = Join-Path $PSScriptRoot '.runtime'
$pythonEnv = Join-Path $backend '.venv'
$python = Join-Path $pythonEnv 'Scripts\python.exe'
$waitress = Join-Path $pythonEnv 'Scripts\waitress-serve.exe'
$node = Get-Command node -ErrorAction SilentlyContinue

if (-not $node) { throw 'Node.js is required on the host computer.' }
$nodeVersionText = (& $node.Source --version).Trim().TrimStart('v')
if ([version]$nodeVersionText -lt [version]'20.9.0') {
    throw "Next.js requires Node.js 20.9 or newer; found $nodeVersionText."
}
if (-not (Test-Path -LiteralPath $python)) {
    $pythonLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pythonLauncher) {
        & $pythonLauncher.Source -3 -m venv $pythonEnv
    } else {
        $pythonLauncher = Get-Command python -ErrorAction SilentlyContinue
        if (-not $pythonLauncher) { throw 'Python 3 is required on the host computer.' }
        & $pythonLauncher.Source -m venv $pythonEnv
    }
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
}
$pythonVersionText = (& $python -c 'import sys; print("%s.%s.%s" % sys.version_info[:3])').Trim()
if ([version]$pythonVersionText -lt [version]'3.12.0' -or [version]$pythonVersionText -ge [version]'3.15.0') {
    throw "Django 6.1 supports Python 3.12 through 3.14; found $pythonVersionText."
}

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$pidFile = Join-Path $runtime 'processes.json'
if (Test-Path -LiteralPath $pidFile) {
    $old = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $live = @($old.BackendPid, $old.FrontendPid) | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
    if ($live.Count -gt 0) { throw 'The demo appears to be running. Stop it with deployment/stop-vpn-demo.ps1 first.' }
    Remove-Item -LiteralPath $pidFile -Force
}

$secretFile = Join-Path $runtime 'django-secret-key.txt'
if (-not (Test-Path -LiteralPath $secretFile)) {
    $bytes = New-Object byte[] 48
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [Convert]::ToBase64String($bytes) | Set-Content -LiteralPath $secretFile -NoNewline
}
$env:DJANGO_SECRET_KEY = (Get-Content -LiteralPath $secretFile -Raw).Trim()
$env:DJANGO_DEBUG = 'false'
$env:DJANGO_ALLOWED_HOSTS = "$BindAddress,localhost,127.0.0.1"
$env:DJANGO_CORS_ALLOWED_ORIGINS = "http://${BindAddress}:3001"
$env:DJANGO_CSRF_TRUSTED_ORIGINS = "http://${BindAddress}:3001"

if (-not (Test-Path -LiteralPath (Join-Path $frontend 'node_modules\next\dist\bin\next'))) {
    Push-Location $frontend
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    } finally { Pop-Location }
}

& $python -m pip install --disable-pip-version-check -r (Join-Path $backend 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Installing backend requirements failed.' }
if (-not (Test-Path -LiteralPath $waitress)) { throw 'waitress-serve was not installed.' }

Push-Location $backend
try {
    & $python manage.py check
    if ($LASTEXITCODE -ne 0) { throw 'Django configuration check failed.' }
    & $python manage.py migrate --noinput
    if ($LASTEXITCODE -ne 0) { throw 'Django database migration failed.' }
} finally { Pop-Location }

Push-Location $frontend
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'The Next.js production build failed.' }
} finally { Pop-Location }

$backendOut = Join-Path $runtime 'backend.stdout.log'
$backendErr = Join-Path $runtime 'backend.stderr.log'
$frontendOut = Join-Path $runtime 'frontend.stdout.log'
$frontendErr = Join-Path $runtime 'frontend.stderr.log'
$backendProcess = $null
$frontendProcess = $null
try {
    $backendProcess = Start-Process -FilePath $waitress `
        -ArgumentList @("--listen=${BindAddress}:8010", 'orientme.wsgi:application') `
        -WorkingDirectory $backend -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $backendOut -RedirectStandardError $backendErr
    $frontendProcess = Start-Process -FilePath $node.Source `
        -ArgumentList @('node_modules/next/dist/bin/next', 'start', '--hostname', $BindAddress, '--port', '3001') `
        -WorkingDirectory $frontend -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $frontendOut -RedirectStandardError $frontendErr
    @{ BackendPid = $backendProcess.Id; FrontendPid = $frontendProcess.Id; BindAddress = $BindAddress } |
        ConvertTo-Json | Set-Content -LiteralPath $pidFile

    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($backendProcess.HasExited -or $frontendProcess.HasExited) { throw 'A demo service exited during startup. Check deployment/.runtime logs.' }
        try {
            $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://${BindAddress}:8010/api/auth/csrf/"
            $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://${BindAddress}:3001/"
            $ready = $true
            break
        } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) { throw 'The app did not become ready. Check deployment/.runtime logs.' }
    Write-Host "OrientMe is ready at http://${BindAddress}:3001/"
    Write-Host 'The public search page needs no login. Other app pages retain their existing login requirement.'
    Write-Host 'Stop the services with deployment/stop-vpn-demo.ps1. This script does not change firewall rules.'
} catch {
    foreach ($process in @($frontendProcess, $backendProcess)) {
        if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    throw
}
