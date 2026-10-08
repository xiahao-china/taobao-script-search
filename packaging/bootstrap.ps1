param([string] $BundlePath, [string[]] $Arguments)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
function Get-Sha256([string] $Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Quote-Native([string] $Value) {
  '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
try {
  if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'Windows x64 required' }
  $root = $env:TAOBAO_SEARCH_CACHE_DIR
  if (-not $root) { $root = Join-Path $env:LOCALAPPDATA 'TaobaoSearch' }
  $root = [IO.Path]::GetFullPath($root)
  $destination = Join-Path $root 'bundles/__PAYLOAD_HASH__'
  $mutex = New-Object Threading.Mutex($false, 'Local\TaobaoSearch-__PAYLOAD_HASH__')
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(300000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another extraction did not finish within 5 minutes' }
    if (-not (Test-Path -LiteralPath (Join-Path $destination 'ready.json'))) {
      [Console]::Error.WriteLine('__FIRST_RUN_NOTE__')
      $parent = Join-Path $root 'bundles'
      [IO.Directory]::CreateDirectory($parent) | Out-Null
      $stage = Join-Path $parent ('.partial-' + [Guid]::NewGuid().ToString('N'))
      [IO.Directory]::CreateDirectory($stage) | Out-Null
      $zipPath = Join-Path $stage 'payload.zip'
      $reader = New-Object IO.StreamReader($BundlePath, [Text.Encoding]::ASCII)
      $zip = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew)
      try {
        $found = $false; $ended = $false
        while ($null -ne ($line = $reader.ReadLine())) {
          if ($line -eq '__TAOBAO_PAYLOAD_BEGIN__') { $found = $true; continue }
          if ($line -eq '__TAOBAO_PAYLOAD_END__') { $ended = $true; break }
          if ($found) { $bytes = [Convert]::FromBase64String($line); $zip.Write($bytes, 0, $bytes.Length) }
        }
        if (-not $found -or -not $ended) { throw 'Embedded payload is incomplete' }
      } finally { $zip.Dispose(); $reader.Dispose() }
      if ((Get-Sha256 $zipPath) -ne '__PAYLOAD_HASH__') { throw 'Embedded payload checksum mismatch' }
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
      $app = Join-Path $stage 'app'
      try {
        foreach ($entry in $archive.Entries) {
          $resolved = [IO.Path]::GetFullPath((Join-Path $app $entry.FullName))
          if (-not $resolved.StartsWith(([IO.Path]::GetFullPath($app) + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive path' }
        }
        [IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $app)
      } finally { $archive.Dispose() }
      $manifest = Get-Content -LiteralPath (Join-Path $app 'bundle-manifest.json') -Raw | ConvertFrom-Json
      foreach ($file in $manifest.files) {
        $filePath = Join-Path $app $file.path
        if ((Get-Sha256 $filePath) -ne $file.sha256) { throw ('Extracted file checksum mismatch: ' + $file.path) }
      }
      [IO.File]::WriteAllText((Join-Path $app 'ready.json'), '{"payloadHash":"__PAYLOAD_HASH__"}', [Text.Encoding]::ASCII)
      # Only a checked cache-owned extraction can be removed/replaced.
      if (Test-Path -LiteralPath $destination) {
        $checked = [IO.Path]::GetFullPath($destination)
        if (-not $checked.StartsWith(([IO.Path]::GetFullPath($parent) + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cache path' }
        Remove-Item -LiteralPath $checked -Recurse -Force
      }
      [IO.Directory]::Move($app, $destination)
      [IO.File]::Delete($zipPath)
      [IO.Directory]::Delete($stage)
    }
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
  $settings = @{
    TAOBAO_SEARCH_PROJECT_ROOT = $destination
    TAOBAO_SEARCH_DAEMON_ENTRY = (Join-Path $destination 'daemon.cjs')
    TAOBAO_SEARCH_RUNTIME_DIR = (Join-Path $root 'runtime')
    TAOBAO_SEARCH_CACHE_DIR = $root
    __BUNDLED_CHROMIUM_ENTRY__
  }
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = Join-Path $destination 'node.exe'
  $info.Arguments = ((@((Join-Path $destination 'cli.cjs')) + $Arguments) | ForEach-Object { Quote-Native $_ }) -join ' '
  $info.WorkingDirectory = (Get-Location).Path
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
  $info.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
  # Windows PowerShell 5.1 can expose ProcessStartInfo.Environment[Variables] as
  # $null. Touching either one then throws "Cannot index into a null array", and
  # assigning an empty dictionary makes the child inherit a gutted environment, so
  # node.exe aborts at startup ("Assertion failed: ncrypto::CSPRNG"). Publish our
  # settings through the parent process environment instead: an untouched
  # ProcessStartInfo inherits it intact, and every key survives.
  $previous = @{}
  foreach ($key in $settings.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, [string]$settings[$key], 'Process')
  }
  try {
    if (-not $process.Start()) { throw 'Embedded Node process did not start' }
  } finally {
    foreach ($key in $settings.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
    }
  }
  # Drain both pipes concurrently; a login wait must not hide progress or
  # deadlock when stderr fills while stdout has no final JSON yet.
  $out = $process.StandardOutput.ReadLineAsync()
  $err = $process.StandardError.ReadLineAsync()
  while ($null -ne $out -or $null -ne $err) {
    $progressed = $false
    for ($drained = 0; $drained -lt 256 -and $null -ne $out -and $out.IsCompleted; $drained++) {
      $progressed = $true
      $line = $out.GetAwaiter().GetResult()
      if ($null -eq $line) { $out = $null } else { [Console]::Out.WriteLine($line); $out = $process.StandardOutput.ReadLineAsync() }
    }
    for ($drained = 0; $drained -lt 256 -and $null -ne $err -and $err.IsCompleted; $drained++) {
      $progressed = $true
      $line = $err.GetAwaiter().GetResult()
      if ($null -eq $line) { $err = $null } else { [Console]::Error.WriteLine($line); $err = $process.StandardError.ReadLineAsync() }
    }
    if (-not $progressed -and ($null -ne $out -or $null -ne $err)) { Start-Sleep -Milliseconds 20 }
  }
  $process.WaitForExit()
  $global:LASTEXITCODE = $process.ExitCode
  $process.Dispose()
} catch {
  $result = @{ ok = $false; operation = 'bootstrap'; data = $null; error = @{ code = 'BUNDLE_START_FAILED'; message = $_.Exception.Message } } | ConvertTo-Json -Compress -Depth 5
  [Console]::Out.WriteLine($result)
  $global:LASTEXITCODE = 1
}
