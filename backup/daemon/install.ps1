# =============================================================================
# DevAccel Local Daemon — Windows installer
# =============================================================================
# Installs the daemon binary, registers it to auto-start at logon, and starts
# it now. No admin rights required (installs under %USERPROFILE%\.devaccel).
#
# Usage (after downloading devaccel-daemon-win.exe next to this script):
#   powershell -ExecutionPolicy Bypass -File install.ps1
# =============================================================================

$ErrorActionPreference = "Stop"

$InstallDir = Join-Path $env:USERPROFILE ".devaccel"
$TargetExe  = Join-Path $InstallDir "devaccel.exe"
$SourceExe  = Join-Path $PSScriptRoot "devaccel-daemon-win.exe"

Write-Host ">> Installing DevAccel daemon to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Migrate a pre-0.3.0 install: stop anything running from the old location and
# remove it so two copies never fight over the port range.
$LegacyDir = Join-Path $env:LOCALAPPDATA "DevAccel"
$LegacyExe = Join-Path $LegacyDir "devaccel.exe"
if (Test-Path $LegacyExe) {
    Write-Host ">> Removing old install at $LegacyDir"
    Get-Process | Where-Object { $_.Path -eq $LegacyExe } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $LegacyDir
}

if (-not (Test-Path $SourceExe)) {
    throw "devaccel-daemon-win.exe not found next to this script. Download it first."
}
Copy-Item -Force $SourceExe $TargetExe

# Auto-start at logon. Preferred: a logon Scheduled Task registered through the
# Task Scheduler API cmdlets — it fires within seconds of sign-in, unlike Run-key
# items which Explorer staggers by minutes on managed machines. (schtasks.exe is
# often denied by policy while the API path is allowed; ExecutionTimeLimit zero
# disables the default 72h limit that would kill the daemon mid-session.)
# Fallback: an HKCU Run key. The exe is a GUI-subsystem binary, so neither
# mechanism shows a console window.
$TaskName = "DevAccelDaemon"
$RunKey   = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
try {
    Write-Host ">> Registering logon auto-start task '$TaskName'"
    $Action   = New-ScheduledTaskAction -Execute $TargetExe -Argument "serve"
    $Trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -RunLevel Limited -Force | Out-Null
    # The task supersedes the Run key — remove it so the daemon isn't started twice.
    Remove-ItemProperty -Path $RunKey -Name $TaskName -ErrorAction SilentlyContinue
} catch {
    Write-Host ">> Task registration blocked — falling back to Run key"
    Set-ItemProperty -Path $RunKey -Name $TaskName -Value "`"$TargetExe`" serve"
}

# Clean up auto-start entries from older installers (best-effort).
$LegacyVbs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\DevAccelDaemon.vbs"
Remove-Item -Force -ErrorAction SilentlyContinue $LegacyVbs

# Start it now (background).
Write-Host ">> Starting the daemon"
Start-Process -FilePath $TargetExe -ArgumentList "serve" -WindowStyle Hidden

Start-Sleep -Seconds 2
Write-Host ""
Write-Host "DevAccel daemon installed and started."
Write-Host "It will start automatically each time you log in."
Write-Host "Verify: open http://127.0.0.1:17872/health in your browser."
