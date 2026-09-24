# Stops only the recorded OrientMe processes started by start-vpn-demo.ps1.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot '.runtime\processes.json'
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'OrientMe is not running (no process record found).'
    return
}

$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$expected = @(
    @{ Id = [int]$record.BackendPid; Command = 'orientme.wsgi:application' }
    @{ Id = [int]$record.FrontendPid; Command = 'next start' }
)
foreach ($item in $expected) {
    # Preserve the record if Windows cannot inspect or stop a process; callers
    # can then retry with the permissions of the account that launched it.
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.Id)" -ErrorAction Stop
    if (-not $process) { continue }
    if ($process.CommandLine -notlike "*$($item.Command)*") {
        throw "PID $($item.Id) no longer matches the OrientMe service record; no process was stopped."
    }
    Stop-Process -Id $item.Id -Force -ErrorAction Stop
}
Remove-Item -LiteralPath $pidFile -Force
Write-Host 'Stopped the recorded OrientMe services.'
