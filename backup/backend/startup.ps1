# =============================================================================
# DevSphere AI — Startup Script
# =============================================================================

[CmdletBinding()]
param(
    [switch]$Reload
)

$ErrorActionPreference = "Stop"

$APP_DIR      = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$VENV_DIR     = Join-Path $APP_DIR ".venv"
$REQ_FILE     = Join-Path $APP_DIR "requirements.txt"
$DEVSPHERE_PORT = 8003

Write-Host "`n====================================="
Write-Host "DevSphere AI Startup"
Write-Host "====================================="

# ── Check runtimes ────────────────────────────────────

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "Python not installed."
}

Write-Host "Python: $(python --version)"

# ── Create venv (first run only) ──────────────────────

if (-not (Test-Path $VENV_DIR)) {
    Write-Host "`nCreating virtual environment..."
    python -m venv $VENV_DIR

    $PYTHON = Join-Path $VENV_DIR "Scripts\python.exe"
    Write-Host "Installing Python dependencies..."
    & $PYTHON -m pip install --upgrade pip
    & $PYTHON -m pip install -r "$REQ_FILE"
}
else {
    Write-Host "`nUsing existing virtual environment."
}

$PYTHON = Join-Path $VENV_DIR "Scripts\python.exe"

# ── Kill port 8003 if in use ──────────────────────────

$pids = @(
    Get-NetTCPConnection -LocalPort $DEVSPHERE_PORT -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            Where-Object { $_ -and $_ -ne 0 }
)

$uvicornPids = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'uvicorn' -and $_.CommandLine -match "--port $DEVSPHERE_PORT" } |
            Select-Object -ExpandProperty ProcessId
)

$pids = @($pids + $uvicornPids | Select-Object -Unique)

foreach ($procId in $pids) {
    Write-Host "Stopping PID $procId on port $DEVSPHERE_PORT"
    & taskkill.exe /PID $procId /T /F 2>$null | Out-Null
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}

# ── Start DevSphere AI ────────────────────────────────

$reloadFlag = if ($Reload) { " --reload" } else { "" }

Write-Host "`nStarting DevSphere AI on port $DEVSPHERE_PORT..."

Start-Process `
    -FilePath $PYTHON `
    -ArgumentList "-m uvicorn devsphere_ai.router.apis:app --host 0.0.0.0 --port $DEVSPHERE_PORT$reloadFlag" `
    -WorkingDirectory $APP_DIR `
    -WindowStyle Hidden

# ── Verify ───────────────────────────────────────────

Start-Sleep -Seconds 5

for ($i = 1; $i -le 3; $i++) {
    $running = Get-NetTCPConnection -LocalPort $DEVSPHERE_PORT -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "  DevSphere AI running on port $DEVSPHERE_PORT" -ForegroundColor Green
        break
    }
    if ($i -lt 3) { Start-Sleep -Seconds 3 }
    else { Write-Host "  DevSphere AI not yet on port $DEVSPHERE_PORT (may still be starting)" -ForegroundColor Yellow }
}

# ── Final output ──────────────────────────────────────

Write-Host "`n====================================="
Write-Host "DevSphere AI  http://localhost:$DEVSPHERE_PORT"
Write-Host "====================================="
