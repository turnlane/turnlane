#!/usr/bin/env bash
# Build all spike binaries into ./out
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
B="bun build --compile"
$B src/hook-main.ts --outfile out/hook-min
$B --minify --bytecode --format=esm src/hook-main.ts --outfile out/hook-min-bc
$B src/dl.ts --outfile out/dl
$B --minify --bytecode --format=esm src/dl.ts --outfile out/dl-bc
$B src/dl-static.ts --outfile out/dl-static
$B --minify --bytecode --format=esm src/dl-static.ts --outfile out/dl-static-bc
$B --minify --bytecode --format=esm src/mcp-main.ts --outfile out/mcp-only-bc
ls -l out
