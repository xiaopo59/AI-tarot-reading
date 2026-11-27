# Build the Android APK by hand -- no Gradle.
#
# Why not Gradle: the Android Gradle Plugin and its dependency tree are another
# few hundred MB to fetch, and on this machine the official sources redirect to
# GitHub, whose TLS chain fails to verify (see android-setup-download.js).
# The SDK's build-tools can produce a perfectly good APK on their own:
#
#   aapt2 compile   resources -> flat files
#   aapt2 link      flat files + manifest + assets -> unsigned APK, and R.java
#   javac           Java sources + R.java -> .class
#   d8              .class -> classes.dex
#   jar uf          put classes.dex into the APK
#   zipalign        align (must happen before signing)
#   apksigner       sign
#
# Pure ASCII on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.

# Note: 'Continue', not 'Stop'.
# javac writes deprecation warnings to stderr, and PowerShell turns any stderr
# output from a native command into a terminating NativeCommandError when the
# preference is 'Stop'. We check $LASTEXITCODE after every step instead.
$ErrorActionPreference = 'Continue'

$ROOT = $PSScriptRoot
$TC   = Join-Path $ROOT '.toolchain'
$JDK  = Join-Path $TC 'jdk'
$SDK  = Join-Path $TC 'android-sdk'

$BT   = Join-Path $SDK 'build-tools\34.0.0'
$AJAR = Join-Path $SDK 'platforms\android-34\android.jar'
$ADB  = Join-Path $SDK 'platform-tools\adb.exe'

$JAVA    = Join-Path $JDK 'bin\java.exe'
$JAVAC   = Join-Path $JDK 'bin\javac.exe'
$KEYTOOL = Join-Path $JDK 'bin\keytool.exe'

$PROJ   = Join-Path $ROOT 'android'
$APPDIR = Join-Path $PROJ 'app\src\main'
$BUILD  = Join-Path $PROJ 'build'

$env:JAVA_HOME = $JDK

function Step($msg) { Write-Host ""; Write-Host ("=== " + $msg + " ===") }
function Fail($msg) { Write-Host ("[FAIL] " + $msg); exit 1 }

# ---- sanity -------------------------------------------------------------------
Step 'checking toolchain'
foreach ($p in @($JAVA, $JAVAC, $KEYTOOL, $AJAR,
                 (Join-Path $BT 'aapt2.exe'), (Join-Path $BT 'lib\d8.jar'),
                 (Join-Path $BT 'zipalign.exe'), (Join-Path $BT 'lib\apksigner.jar'))) {
    if (-not (Test-Path $p)) { Fail "missing: $p" }
}
Write-Host "  all tools present"

# ---- clean --------------------------------------------------------------------
if (Test-Path $BUILD) { Remove-Item $BUILD -Recurse -Force }
foreach ($d in @('compiled', 'gen', 'classes', 'dex')) {
    New-Item -ItemType Directory -Path (Join-Path $BUILD $d) -Force | Out-Null
}

# ---- copy the web app into assets --------------------------------------------
# Only the files the page actually needs. .toolchain and android/ must not leak in.
Step 'copying web assets'
$assets = Join-Path $APPDIR 'assets'
if (Test-Path $assets) { Remove-Item $assets -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $assets 'js') -Force | Out-Null

Copy-Item (Join-Path $ROOT 'index.html')  (Join-Path $assets 'index.html')  -Force
Copy-Item (Join-Path $ROOT 'styles.css')  (Join-Path $assets 'styles.css')  -Force
Copy-Item (Join-Path $ROOT 'tarot-icon.png') (Join-Path $assets 'tarot-icon.png') -Force
Get-ChildItem (Join-Path $ROOT 'js') -Filter '*.js' | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $assets ('js\' + $_.Name)) -Force
}
$copied = (Get-ChildItem $assets -Recurse -File | Measure-Object).Count
Write-Host ("  " + $copied + " files")

# ------------------------------------------------------------------------------
# aapt2 compile
# ------------------------------------------------------------------------------
Step 'aapt2 compile'
$compiledZip = Join-Path $BUILD 'compiled\res.zip'
& (Join-Path $BT 'aapt2.exe') compile --dir (Join-Path $APPDIR 'res') -o $compiledZip
if ($LASTEXITCODE -ne 0) { Fail "aapt2 compile exited $LASTEXITCODE" }

# ------------------------------------------------------------------------------
# aapt2 link
# ------------------------------------------------------------------------------
Step 'aapt2 link'
$unsigned = Join-Path $BUILD 'app-unsigned.apk'
$genDir   = Join-Path $BUILD 'gen'

& (Join-Path $BT 'aapt2.exe') link `
    -o $unsigned `
    -I $AJAR `
    --manifest (Join-Path $APPDIR 'AndroidManifest.xml') `
    -R $compiledZip `
    -A $assets `
    --java $genDir `
    --min-sdk-version 24 `
    --target-sdk-version 34 `
    --version-code 17 `
    --version-name '3.4' `
    --auto-add-overlay
if ($LASTEXITCODE -ne 0) { Fail "aapt2 link exited $LASTEXITCODE" }

$rJava = Join-Path $genDir 'com\tarot\app\R.java'
if (-not (Test-Path $rJava)) { Fail "R.java not generated at $rJava" }
Write-Host "  R.java generated"

# ------------------------------------------------------------------------------
# javac
# ------------------------------------------------------------------------------
Step 'javac'
$classes = Join-Path $BUILD 'classes'
$sources = @(
    $rJava,
    (Join-Path $APPDIR 'java\com\tarot\app\MainActivity.java')
)

# -source/-target 8: d8 only accepts Java 8 bytecode. Latest JDK still allows it
# with a deprecation warning, which is fine. Warning text goes to stderr and is
# left alone -- we only care about the exit code.
#
# No "2>&1 | Out-Null" here on purpose: some sandboxes refuse to spawn a native
# process whose stdio is redirected, reporting it as "access denied" even though
# the same command runs fine unredirected. The warning is harmless, let it print.
& $JAVAC -source 8 -target 8 -nowarn `
    -bootclasspath $AJAR `
    -encoding UTF-8 `
    -d $classes `
    $sources
if ($LASTEXITCODE -ne 0) { Fail "javac exited $LASTEXITCODE" }

$classFiles = Get-ChildItem $classes -Recurse -Filter '*.class'
if ($classFiles.Count -eq 0) { Fail "javac produced no .class files" }
Write-Host ("  " + $classFiles.Count + " class files")

# ------------------------------------------------------------------------------
# d8
# ------------------------------------------------------------------------------
Step 'd8'
$dexDir = Join-Path $BUILD 'dex'
$classArgs = $classFiles | ForEach-Object { $_.FullName }

# Call the jars through java directly instead of d8.bat / apksigner.bat.
# A .bat needs cmd.exe, and on some locked-down machines spawning cmd fails with
# a 0xc0000142 "application failed to start" dialog -- which pops up on the
# user's desktop even though the build itself would otherwise work.
& $JAVA -cp (Join-Path $BT 'lib\d8.jar') com.android.tools.r8.D8 `
    --lib $AJAR `
    --min-api 24 `
    --output $dexDir `
    $classArgs
if ($LASTEXITCODE -ne 0) { Fail "d8 exited $LASTEXITCODE" }

$dex = Join-Path $dexDir 'classes.dex'
if (-not (Test-Path $dex)) { Fail "classes.dex not produced" }
Write-Host ("  classes.dex " + [math]::Round((Get-Item $dex).Length/1KB,1) + " KB")

# ------------------------------------------------------------------------------
# Fix backslashes in asset entry names.
#
# Windows aapt2 does NOT convert the path separator when it packs -A <dir>: a
# file at assets/js/app.js lands in the APK as the entry "assets/js\app.js".
# WebView asks for "assets/js/app.js" (forward slash, always), finds nothing,
# and the app shows a blank page with no obvious clue why.
#
# Must happen BEFORE zipalign and signing -- rewriting the archive afterwards
# would invalidate both.
# ------------------------------------------------------------------------------
Step 'fixing asset entry names'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($unsigned, 'Update')
$bad = @($zip.Entries | Where-Object { $_.FullName.Contains('\') })
if ($bad.Count -gt 0) {
    Write-Host ("  rewriting " + $bad.Count + " entries")
    $scratch = Join-Path $BUILD 'entry.tmp'
    foreach ($e in $bad) {
        $goodName = $e.FullName.Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $scratch, $true)
        $e.Delete()
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $scratch, $goodName)
        Remove-Item $scratch -Force
    }
} else {
    Write-Host "  none needed"
}
$zip.Dispose()

# ------------------------------------------------------------------------------
# put classes.dex into the APK
# ------------------------------------------------------------------------------
Step 'packaging dex'
Push-Location $dexDir
& (Join-Path $JDK 'bin\jar.exe') uf $unsigned 'classes.dex'
$jarExit = $LASTEXITCODE
Pop-Location
if ($jarExit -ne 0) { Fail "jar exited $jarExit" }

# ------------------------------------------------------------------------------
# zipalign  (must be before signing -- signing would invalidate the alignment)
# ------------------------------------------------------------------------------
Step 'zipalign'
$aligned = Join-Path $BUILD 'app-aligned.apk'
& (Join-Path $BT 'zipalign.exe') -f 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { Fail "zipalign exited $LASTEXITCODE" }

# ------------------------------------------------------------------------------
# keystore + sign
# ------------------------------------------------------------------------------
Step 'signing'
$ks = Join-Path $TC 'debug.keystore'
if (-not (Test-Path $ks)) {
    Write-Host "  generating a debug keystore"
    # Self-signed, for sideloading. Not suitable for publishing.
    & $KEYTOOL -genkeypair `
        -keystore $ks `
        -alias androiddebugkey `
        -storepass android `
        -keypass android `
        -keyalg RSA `
        -keysize 2048 `
        -validity 10000 `
        -dname "CN=Android Debug,O=Android,C=US" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "keytool exited $LASTEXITCODE" }
}

$outApk = Join-Path $ROOT 'tarot.apk'
if (Test-Path $outApk) { Remove-Item $outApk -Force }

& $JAVA -jar (Join-Path $BT 'lib\apksigner.jar') sign `
    --ks $ks `
    --ks-pass pass:android `
    --key-pass pass:android `
    --v1-signing-enabled true `
    --v2-signing-enabled true `
    --out $outApk `
    $aligned
if ($LASTEXITCODE -ne 0) { Fail "apksigner exited $LASTEXITCODE" }

# ------------------------------------------------------------------------------
# verify
# ------------------------------------------------------------------------------
Step 'verify'
# No stdio redirection: see the note above the javac step -- some sandboxes
# refuse to spawn a redirected native process. Capture in PowerShell instead.
$verifyLines = & $JAVA -jar (Join-Path $BT 'lib\apksigner.jar') verify --verbose $outApk
$verifyLines | Select-Object -First 6

# Cross-check the packaged entry names -- a backslash here means a blank app.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$check = [System.IO.Compression.ZipFile]::OpenRead($outApk)
$entries = $check.Entries | ForEach-Object { $_.FullName }
$check.Dispose()

$backslashed = @($entries | Where-Object { $_.Contains('\') })
if ($backslashed.Count -gt 0) {
    Fail ("APK contains " + $backslashed.Count + " entry name(s) with a backslash: " +
          ($backslashed -join ', '))
}
Write-Host "  no backslashed entry names"

foreach ($needed in @('AndroidManifest.xml', 'classes.dex', 'resources.arsc',
                      'assets/index.html', 'assets/styles.css',
                      'assets/js/app.js', 'assets/js/render.js')) {
    if ($entries -notcontains $needed) { Fail "APK is missing $needed" }
}
Write-Host "  all expected files present"

$size = [math]::Round((Get-Item $outApk).Length / 1MB, 2)
Write-Host ""
Write-Host ("APK: " + $outApk)
Write-Host ("size: " + $size + " MB")
exit 0
