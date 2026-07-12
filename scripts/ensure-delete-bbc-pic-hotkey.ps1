param(
    [int]$Port = 3333,
    [string]$PidFile = '',
    [string]$StatusFile = '',
    [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'

function Stop-HotkeyProcesses {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='cmd.exe'" |
        Where-Object { $_.CommandLine -like '*win-delete-bbc-pic-hotkey.ps1*' -or $_.CommandLine -like '*run-delete-bbc-pic-hotkey.bat*' } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

function Get-HotkeyProcessCount {
    return @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='cmd.exe'" |
            Where-Object {
                $_.CommandLine -like '*win-delete-bbc-pic-hotkey.ps1*' -or $_.CommandLine -like '*run-delete-bbc-pic-hotkey.bat*'
            }).Count
}

function Test-HotkeyReady {
    if ($StatusFile -eq '' -or -not (Test-Path $StatusFile)) { return $false }
    if ($PidFile -eq '' -or -not (Test-Path $PidFile)) { return $false }
    $pidText = (Get-Content -Path $PidFile -Raw -Encoding UTF8).Trim()
    if ($pidText -eq '') { return $false }
    $alive = Get-Process -Id $pidText -ErrorAction SilentlyContinue
    if (-not $alive) { return $false }
    $line = (Get-Content -Path $StatusFile -Raw -Encoding UTF8).Trim()
    return $line.StartsWith('READY ')
}

Stop-HotkeyProcesses
for ($i = 0; $i -lt 15; $i++) {
    if ((Get-HotkeyProcessCount) -eq 0) { break }
    Start-Sleep -Milliseconds 300
}

if (Test-HotkeyReady) {
    Write-Output "ALREADY_READY"
    exit 0
}

function Start-HotkeyDirect {
    $psPath = Join-Path $PSScriptRoot 'win-delete-bbc-pic-hotkey.ps1'
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile',
        '-Sta',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        $psPath,
        '-Port',
        $Port,
        '-PidFile',
        $PidFile,
        '-StatusFile',
        $StatusFile,
        '-LogFile',
        $LogFile
    ) -WindowStyle Hidden | Out-Null
}

Start-HotkeyDirect

for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 400
    if (Test-HotkeyReady) {
        $line = (Get-Content -Path $StatusFile -Raw -Encoding UTF8).Trim()
        Write-Output $line
        exit 0
    }
}

if ($LogFile -ne '' -and (Test-Path $LogFile)) {
    Get-Content -Path $LogFile -Tail 20 -Encoding UTF8 | ForEach-Object { Write-Output $_ }
}

Write-Output 'ERROR hotkey not ready after direct start'
exit 1
