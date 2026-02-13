# Koda CLI installer for Windows.
# Usage: irm https://raw.githubusercontent.com/ImTheMars/koda/master/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"

$Repo = "ImTheMars/koda"
$Asset = "koda-windows-x64.exe"
$InstallDir = "$env:USERPROFILE\.koda\bin"

Write-Host "koda installer"
Write-Host "  platform: windows-x64"

# Check execution policy
$policy = Get-ExecutionPolicy -Scope CurrentUser
if ($policy -eq "Restricted") {
    Write-Host "  warning: execution policy is Restricted" -ForegroundColor Yellow
    Write-Host "  you may need: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"
}

# Get latest release
$Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
$DownloadUrl = ($Release.assets | Where-Object { $_.name -eq $Asset }).browser_download_url

if (-not $DownloadUrl) {
    Write-Host "error: no binary found for windows-x64" -ForegroundColor Red
    exit 1
}

# Check for existing install
$OutPath = Join-Path $InstallDir "koda.exe"
if (Test-Path $OutPath) {
    $overwrite = Read-Host "  koda.exe already exists. overwrite? (y/N)"
    if ($overwrite -ne "y" -and $overwrite -ne "Y") {
        Write-Host "  cancelled"
        exit 0
    }
}

Write-Host "  downloading: $Asset"

# Download
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -Uri $DownloadUrl -OutFile $OutPath

# Validate download size (compiled Bun binaries are > 1MB)
$fileSize = (Get-Item $OutPath).Length
if ($fileSize -lt 1MB) {
    Write-Host "error: downloaded file is too small ($fileSize bytes) — may be corrupt" -ForegroundColor Red
    Remove-Item $OutPath
    exit 1
}

Write-Host "  installed: $OutPath"

# Add to user PATH if not already there
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host "  added $InstallDir to PATH (restart terminal to take effect)"
}

Write-Host ""
Write-Host "  run 'koda setup' to configure."
Write-Host ""
