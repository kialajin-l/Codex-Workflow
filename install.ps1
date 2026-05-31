$ErrorActionPreference = "Stop"

$repoZipUrl = "https://github.com/kialajin-l/Codex-Workflow/archive/refs/heads/main.zip"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-workflow-install-" + [guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $tempRoot "codex-workflow.zip"

function Require-Command([string]$name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $name"
  }
}

try {
  Require-Command "node"
  Require-Command "npm"

  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  Write-Host "Downloading Codex Workflow from GitHub..."
  Invoke-WebRequest -Uri $repoZipUrl -OutFile $archivePath

  Write-Host "Extracting archive..."
  Expand-Archive -Path $archivePath -DestinationPath $tempRoot -Force
  $repoDir = Get-ChildItem -Path $tempRoot -Directory | Where-Object { $_.Name -like "Codex-Workflow-*" } | Select-Object -First 1
  if (-not $repoDir) {
    throw "Failed to locate extracted repository directory."
  }

  Push-Location $repoDir.FullName
  try {
    Write-Host "Installing npm dependencies..."
    npm install
    Write-Host "Building runtime..."
    npm run build
    Write-Host "Pruning dev dependencies..."
    npm prune --omit=dev
    Write-Host "Installing Codex Workflow into ~/.codex ..."
    node install.js
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Host "Install complete."
  Write-Host "Runtime: $HOME\.codex\codex-workflow\runtime"
  Write-Host "Wrappers: $HOME\.codex\codex-workflow\bin"
  Write-Host "Use PowerShell wrapper: $HOME\.codex\codex-workflow\bin\cwf.ps1 init"
  Write-Host "Use CMD wrapper: $HOME\.codex\codex-workflow\bin\cwf.cmd init"
} finally {
  if (Test-Path $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
