# =============================================================================
# DevSphere AI — Stop Script
# =============================================================================

$ErrorActionPreference = "SilentlyContinue"

$DEVSPHERE_PORT = 8003

Write-Host "`n====================================="
Write-Host "DevSphere AI - Stopping service"
Write-Host "====================================="

function Stop-Port {
    param(
        [int]$Port,
        [string]$Label
    )

    $pids = @(
        Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique |
                Where-Object { $_ -and $_ -ne 0 }
    )

    $uvicornPids = @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -match 'uvicorn' -and $_.CommandLine -match "--port $Port" } |
                Select-Object -ExpandProperty ProcessId
    )

    $pids = @($pids + $uvicornPids | Select-Object -Unique)

    if ($pids) {
        foreach ($p in $pids) {
            $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
            if ($proc) {
                & taskkill.exe /PID $p /T /F 2>$null | Out-Null
                Stop-Process -Id $p -Force
                Write-Host "   Stopped $Label (PID $p - $($proc.ProcessName)) on port $Port"
            }
            else {
                & taskkill.exe /PID $p /T /F 2>$null | Out-Null
            }
        }
    }
    else {
        Write-Host "   $Label - nothing running on port $Port"
    }
}

Stop-Port -Port $DEVSPHERE_PORT -Label "DevSphere AI"

Write-Host "`n====================================="
Write-Host "Done."
Write-Host "====================================="
