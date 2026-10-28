# Registra relay-daemon como tarea programada de Windows: arranca al iniciar sesión y se
# reinicia si falla. Ejecútalo en PowerShell (no requiere administrador):
#
#   powershell -ExecutionPolicy Bypass -File examples\windows\install-daemon-task.ps1
#
# Detener:  Stop-ScheduledTask -TaskName agent-relay
# Quitar:   Unregister-ScheduledTask -TaskName agent-relay -Confirm:$false
# Logs:     Get-Content "$env:LOCALAPPDATA\agent-relay\daemon.log" -Wait

$ErrorActionPreference = "Stop"

$daemon = (Get-Command relay-daemon.cmd -ErrorAction SilentlyContinue).Source
if (-not $daemon) { throw "No encuentro relay-daemon. Ejecuta 'npm link' en la carpeta de agent-relay primero." }

$logDir = Join-Path $env:LOCALAPPDATA "agent-relay"
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "daemon.log"

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/d /c set NO_COLOR=1 && `"$daemon`" >> `"$log`" 2>&1"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName "agent-relay" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "agent-relay"
Write-Host "Tarea 'agent-relay' registrada e iniciada. Log: $log"
