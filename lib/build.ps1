# lib/build.ps1 — Windows build for libduckdb-shim.dll
#
# Builds the C shim with MSVC (cl.exe). Mirrors the Makefile contract:
#
#   .\build.ps1 -DuckDbDir C:\path\to\duckdb    # builds libduckdb-shim.dll
#   .\build.ps1 -DuckDbDir C:\path\to\duckdb -Tagged
#                                               # builds libduckdb-shim-win32-x64.dll
#
# -DuckDbDir must contain `duckdb.h` and `duckdb.lib` (import library) from
# DuckDB's libduckdb-windows-{amd64,arm64}.zip release artifact. The path
# can be relative or absolute.
#
# Requirements:
#   - MSVC's cl.exe in PATH (use `ilammy/msvc-dev-cmd@v1` in CI, or run
#     this from a "Developer PowerShell for VS" window locally).
#   - PowerShell 5.1+ (ships with Windows 10/11) or PowerShell 7+.
#
# Output: libduckdb-shim[-win32-<arch>].dll in the current directory,
# alongside the .obj/.exp/.lib artifacts that cl.exe produces.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DuckDbDir,

    [switch]$Tagged,

    [ValidateSet('x64', 'arm64')]
    [string]$Arch = 'x64',

    [string]$OutDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

# Use Push-Location instead of Set-Location so we don't side-effect the
# caller's current working directory. PowerShell's `Set-Location` from
# within a .ps1 affects the parent scope by default (no per-script cwd
# isolation), which breaks any post-build steps that use relative paths.
Push-Location $PSScriptRoot
try {

# Resolve to an absolute path so cl.exe doesn't get confused by relative
# paths once we link.
$DuckDbDir = (Resolve-Path -Path $DuckDbDir).Path

if (-not (Test-Path "$DuckDbDir\duckdb.h")) {
    throw "duckdb.h not found in $DuckDbDir. Pass -DuckDbDir pointing at the extracted libduckdb-windows-{amd64,arm64}.zip."
}
if (-not (Test-Path "$DuckDbDir\duckdb.lib")) {
    throw "duckdb.lib not found in $DuckDbDir. Pass -DuckDbDir pointing at the extracted libduckdb-windows-{amd64,arm64}.zip."
}

# Sanity-check that we're in a developer command environment. If cl.exe
# isn't on PATH the user probably forgot to run vcvars / msvc-dev-cmd.
$cl = Get-Command cl.exe -ErrorAction SilentlyContinue
if (-not $cl) {
    throw "cl.exe not found in PATH. Run from a Developer PowerShell for VS, or use ilammy/msvc-dev-cmd@v1 in CI."
}

$shimName = if ($Tagged) {
    "libduckdb-shim-win32-$Arch.dll"
} else {
    'libduckdb-shim.dll'
}

$shimPath = Join-Path $OutDir $shimName

Write-Host "→ building $shimName"
Write-Host "  CC:        $($cl.Source)"
Write-Host "  DuckDbDir: $DuckDbDir"
Write-Host "  Arch:      $Arch"
Write-Host ""

# /nologo  — silence the MSVC banner
# /O2      — optimize for speed
# /LD      — build a DLL (not an EXE)
# /MT      — static link the CRT (so users don't need MSVC runtime installed)
# /TC      — force C compilation (no C++ name mangling — needed for dlopen)
# /W3      — reasonable warning level
# /I       — include directory for duckdb.h
# /Fe:     — output executable (the DLL) name
# /Fo:     — output object file path (keep alongside, easy to clean)
# /link    — pass everything after to the linker
# /OUT:    — final DLL output path
# /DLL     — implied by /LD, but explicit doesn't hurt
& cl.exe `
    /nologo `
    /O2 `
    /LD `
    /MT `
    /TC `
    /W3 `
    /I "$DuckDbDir" `
    /Fe:"$shimPath" `
    /Fo:"$(Join-Path $OutDir 'duckdb-shim.obj')" `
    duckdb-shim.c `
    /link `
    /OUT:"$shimPath" `
    "$DuckDbDir\duckdb.lib"

if ($LASTEXITCODE -ne 0) {
    throw "cl.exe failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "→ built $shimPath"

# Verify the shim actually exports our symbols. On Windows, missing
# __declspec(dllexport) silently produces a DLL with no callable
# entry points — which would make Bun's dlopen() return null
# symbols. This check catches that at build time instead of at
# runtime in a confusing way.
$dumpbin = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
if ($dumpbin) {
    Write-Host ""
    Write-Host "→ verifying exports via dumpbin"
    $exports = & dumpbin.exe /exports $shimPath 2>&1 | Out-String
    $required = @('shim_fetch_chunk', 'shim_result_get_chunk', 'shim_result_chunk_count')
    $missing = @()
    foreach ($sym in $required) {
        if ($exports -notmatch [regex]::Escape($sym)) {
            $missing += $sym
        }
    }
    if ($missing.Count -gt 0) {
        Write-Host $exports
        throw "Missing required exports: $($missing -join ', '). Check __declspec(dllexport) in duckdb-shim.c."
    }
    Write-Host "  all required symbols present: $($required -join ', ')"
}

} finally {
    Pop-Location
}
