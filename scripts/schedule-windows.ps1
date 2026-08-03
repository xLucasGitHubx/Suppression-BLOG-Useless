# Enregistre les tâches planifiées Windows pour Lovebox Blog Ops.
# À lancer UNE FOIS en PowerShell (clic droit > Exécuter avec PowerShell, ou depuis un terminal admin).
#
#  - Weekly report : tous les lundis à 07:00 (suppression auto incluse, en réel si DRY_RUN=false)
#  - Purge :         tous les jeudis à 07:30 (rattrapage : plafond suppressions/run)
#
# Pour supprimer : Unregister-ScheduledTask -TaskName "Lovebox*"

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source

function Register-LoveboxTask {
    param([string]$Name, [string]$Arguments, [string]$Day, [string]$Time)
    $action = New-ScheduledTaskAction -Execute $node -Argument $Arguments -WorkingDirectory $projectDir
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $Time
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "OK  $Name  ($Day $Time)"
}

Register-LoveboxTask -Name "Lovebox Weekly Report" -Arguments "src\index.js weekly-report --confirm" -Day "Monday" -Time "07:00"
Register-LoveboxTask -Name "Lovebox Purge" -Arguments "src\index.js purge --confirm" -Day "Thursday" -Time "07:30"

Write-Host ""
Write-Host "Tâches enregistrées. Rappel : tant que DRY_RUN=true dans .env, tout reste en simulation."
