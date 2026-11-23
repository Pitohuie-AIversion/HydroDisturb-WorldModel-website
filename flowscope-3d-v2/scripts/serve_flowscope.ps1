param([int]$Port = 8765)
$projectRoot = Split-Path -Parent $PSScriptRoot
python (Join-Path $projectRoot 'server.py') --port $Port --open
