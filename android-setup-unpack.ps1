# Lay out the Android SDK components we downloaded as raw zips.
#
# sdkmanager could not fetch the repository (Java's networking is blocked in this
# sandbox), so android-setup-sdkdl.js pulled the three zips directly with Node.
# This script unpacks them into the directory structure the SDK expects:
#
#   <sdk>/platform-tools/          <- platform-tools.zip
#   <sdk>/platforms/android-34/    <- platform-34.zip        (zip root is android-14)
#   <sdk>/build-tools/34.0.0/      <- build-tools-34.zip     (zip root is android-14)
#
# Pure ASCII on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.

$ErrorActionPreference = 'Continue'

$TC  = Join-Path $PSScriptRoot '.toolchain'
$SDK = Join-Path $TC 'android-sdk'
$DL  = Join-Path $TC 'downloads'

function Unpack($zipName, $destDir, $label) {
    $zip = Join-Path $DL $zipName
    Write-Host "=== $label ==="
    if (-not (Test-Path $zip)) {
        Write-Host "  [MISS] $zip"
        return $false
    }

    # Show the zip root so a structure change is obvious rather than silent
    $roots = & tar -tf $zip 2>$null | ForEach-Object {
        ($_ -split '/')[0]
    } | Where-Object { $_ -ne '' } | Sort-Object -Unique
    Write-Host ("  zip root(s): " + ($roots -join ', '))

    if (Test-Path $destDir) {
        Write-Host "  already unpacked, skipping"
        return $true
    }

    $tmp = "$destDir.tmp"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null

    & tar -xf $zip -C $tmp
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [FAIL] tar exited $LASTEXITCODE"
        return $false
    }

    # If the zip wrapped everything in a single directory, strip that level
    $entries = Get-ChildItem $tmp
    if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) {
        Move-Item $entries[0].FullName $destDir -Force
    } else {
        Move-Item $tmp $destDir -Force
        $tmp = $null
    }
    if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Recurse -Force }

    Write-Host "  -> $destDir"
    return $true
}

New-Item -ItemType Directory -Path (Join-Path $SDK 'platforms')   -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $SDK 'build-tools') -Force | Out-Null

Unpack 'platform-tools.zip'   (Join-Path $SDK 'platform-tools')        'platform-tools (adb)' | Out-Null
Unpack 'platform-34.zip'      (Join-Path $SDK 'platforms\android-34')  'platforms;android-34' | Out-Null
Unpack 'build-tools-34.zip'   (Join-Path $SDK 'build-tools\34.0.0')    'build-tools;34.0.0'   | Out-Null

# The build-tools archive may unpack to 34.0.0-rc4 or similar; normalise the name
$btDir = Join-Path $SDK 'build-tools'
$btChildren = Get-ChildItem $btDir -Directory -ErrorAction SilentlyContinue
if ($btChildren.Count -eq 1 -and $btChildren[0].Name -ne '34.0.0') {
    Write-Host ""
    Write-Host ("renaming build-tools/" + $btChildren[0].Name + " -> build-tools/34.0.0")
    Move-Item $btChildren[0].FullName (Join-Path $btDir '34.0.0') -Force
}

Write-Host ""
Write-Host "=== verify ==="
$checks = @(
    @{ path = 'platform-tools\adb.exe';                 name = 'platform-tools (adb)' },
    @{ path = 'platforms\android-34\android.jar';       name = 'platforms;android-34' },
    @{ path = 'build-tools\34.0.0\aapt2.exe';           name = 'aapt2' },
    @{ path = 'build-tools\34.0.0\d8.bat';              name = 'd8' },
    @{ path = 'build-tools\34.0.0\apksigner.bat';       name = 'apksigner' },
    @{ path = 'build-tools\34.0.0\zipalign.exe';        name = 'zipalign' }
)
$missing = 0
foreach ($c in $checks) {
    $full = Join-Path $SDK $c.path
    if (Test-Path $full) {
        $size = (Get-Item $full).Length
        Write-Host ("  [ok]   " + $c.name)
    } else {
        Write-Host ("  [MISS] " + $c.name + "  -> " + $full)
        $missing++
    }
}

Write-Host ""
if ($missing -eq 0) {
    Write-Host "Android SDK ready"
    exit 0
} else {
    Write-Host ("$missing component(s) missing")
    Write-Host "Contents of build-tools:"
    Get-ChildItem (Join-Path $SDK 'build-tools') -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("  " + $_.Name) }
    Write-Host "Contents of platforms:"
    Get-ChildItem (Join-Path $SDK 'platforms') -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("  " + $_.Name) }
    exit 1
}
