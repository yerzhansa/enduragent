param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [Parameter(Mandatory = $true)][string]$OutputAssembly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0

function Get-FramedSha256 {
  param([Parameter(Mandatory = $true)][string[]]$Fields)

  $stream = New-Object System.IO.MemoryStream
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    foreach ($field in $Fields) {
      $bytes = [Text.Encoding]::UTF8.GetBytes($field)
      $lengthBytes = [BitConverter]::GetBytes([uint32]$bytes.Length)
      if ([BitConverter]::IsLittleEndian) {
        [Array]::Reverse($lengthBytes)
      }
      $stream.Write($lengthBytes, 0, $lengthBytes.Length)
      $stream.Write($bytes, 0, $bytes.Length)
    }
    return -join ($hash.ComputeHash($stream.ToArray()) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $hash.Dispose()
    $stream.Dispose()
  }
}

function Get-RuntimeInventorySha256 {
  param([Parameter(Mandatory = $true)][hashtable]$Hashes)

  [string[]]$relativeNames = @($Hashes.Keys)
  [Array]::Sort($relativeNames, [StringComparer]::Ordinal)
  [string[]]$fields = @('enduragent.windows-dotnet-runtime-inventory.v1')
  foreach ($relativeName in $relativeNames) {
    $fields += $relativeName
    $fields += [string]$Hashes[$relativeName]
  }
  return Get-FramedSha256 -Fields $fields
}

if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop') {
  throw 'Windows PowerShell 5.1 Desktop is required'
}
if (-not [Environment]::Is64BitProcess) {
  throw 'The native helper must be compiled by x64 Windows PowerShell'
}

$resolvedSourceRoot = (Resolve-Path -LiteralPath $SourceRoot).ProviderPath
$resolvedOutputParent = (Resolve-Path -LiteralPath (Split-Path -Parent $OutputAssembly)).ProviderPath
$resolvedOutput = Join-Path $resolvedOutputParent (Split-Path -Leaf $OutputAssembly)
if (Test-Path -LiteralPath $resolvedOutput) {
  throw 'The output assembly already exists'
}

$sourceNames = @('Program.cs', 'Protocol.cs', 'FileSystem.cs', 'NamedPipe.cs', 'JobObject.cs', 'BrokerContext.cs')
$sourcePaths = @()
$sourceHashesBefore = @()
foreach ($name in $sourceNames) {
  $path = Join-Path $resolvedSourceRoot $name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw 'An allowlisted native source file is missing'
  }
  $sourcePaths += $path
  $sourceHashesBefore += [ordered]@{
    name = $name
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

$compilerOptions = '/target:exe /platform:x64 /checked+ /optimize+ /warn:4 /nologo'
$references = @('System.dll', 'System.Core.dll', 'System.Security.dll', 'System.Web.Extensions.dll')
[string[]]$runtimeRelativeInventory = @('csc.exe') + $references
[Array]::Sort($runtimeRelativeInventory, [StringComparer]::Ordinal)
$runtimeDirectory = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
$cscPath = Join-Path $runtimeDirectory 'csc.exe'
if (-not (Test-Path -LiteralPath $cscPath -PathType Leaf)) {
  throw 'The .NET Framework C# compiler identity is unavailable'
}
$powerShellExecutable = (Get-Process -Id $PID).Path
if (-not (Test-Path -LiteralPath $powerShellExecutable -PathType Leaf)) {
  throw 'The Windows PowerShell executable identity is unavailable'
}
$referencePaths = @()
foreach ($reference in $references) {
  $referencePath = Join-Path $runtimeDirectory $reference
  if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) {
    throw 'An allowlisted framework reference is unavailable'
  }
  $referencePaths += $referencePath
}
$cscSha256Before = (Get-FileHash -LiteralPath $cscPath -Algorithm SHA256).Hash.ToLowerInvariant()
$powerShellSha256Before = (Get-FileHash -LiteralPath $powerShellExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
$referenceHashesBefore = @()
$runtimeHashesBefore = @{ 'csc.exe' = $cscSha256Before }
for ($index = 0; $index -lt $references.Count; $index += 1) {
  $referenceSha256 = (Get-FileHash -LiteralPath $referencePaths[$index] -Algorithm SHA256).Hash.ToLowerInvariant()
  $referenceHashesBefore += [ordered]@{
    name = $references[$index]
    sha256 = $referenceSha256
  }
  $runtimeHashesBefore[$references[$index]] = $referenceSha256
}
$runtimeDirectorySha256Before = Get-RuntimeInventorySha256 -Hashes $runtimeHashesBefore
$compilerParameters = New-Object System.CodeDom.Compiler.CompilerParameters
$compilerParameters.GenerateExecutable = $true
$compilerParameters.GenerateInMemory = $false
$compilerParameters.IncludeDebugInformation = $false
$compilerParameters.OutputAssembly = $resolvedOutput
$compilerParameters.CompilerOptions = $compilerOptions
$compilerParameters.WarningLevel = 4
$compilerParameters.TreatWarningsAsErrors = $true
foreach ($referencePath in $referencePaths) {
  [void]$compilerParameters.ReferencedAssemblies.Add($referencePath)
}
$null = Add-Type -Path $sourcePaths -CompilerParameters $compilerParameters -ErrorAction Stop -WarningAction Stop

if (-not (Test-Path -LiteralPath $resolvedOutput -PathType Leaf)) {
  throw 'Add-Type did not produce the expected assembly'
}

$sourceHashesAfter = @()
foreach ($name in $sourceNames) {
  $path = Join-Path $resolvedSourceRoot $name
  $sourceHashesAfter += [ordered]@{
    name = $name
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
for ($index = 0; $index -lt $sourceNames.Count; $index += 1) {
  if ($sourceHashesBefore[$index].sha256 -ne $sourceHashesAfter[$index].sha256) {
    throw 'An allowlisted native source changed during compilation'
  }
}

$cscSha256After = (Get-FileHash -LiteralPath $cscPath -Algorithm SHA256).Hash.ToLowerInvariant()
$powerShellSha256After = (Get-FileHash -LiteralPath $powerShellExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
$referenceHashesAfter = @()
$runtimeHashesAfter = @{ 'csc.exe' = $cscSha256After }
for ($index = 0; $index -lt $references.Count; $index += 1) {
  $referenceSha256 = (Get-FileHash -LiteralPath $referencePaths[$index] -Algorithm SHA256).Hash.ToLowerInvariant()
  $referenceHashesAfter += [ordered]@{
    name = $references[$index]
    sha256 = $referenceSha256
  }
  $runtimeHashesAfter[$references[$index]] = $referenceSha256
  if ($referenceHashesBefore[$index].sha256 -ne $referenceHashesAfter[$index].sha256) {
    throw 'An allowlisted framework reference changed during compilation'
  }
}
$runtimeDirectorySha256After = Get-RuntimeInventorySha256 -Hashes $runtimeHashesAfter
if ($cscSha256Before -ne $cscSha256After -or $powerShellSha256Before -ne $powerShellSha256After) {
  throw 'The compiler or PowerShell executable changed during compilation'
}
if ($runtimeDirectorySha256Before -ne $runtimeDirectorySha256After) {
  throw 'The canonical runtime content inventory changed during compilation'
}
$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
try {
  $providerType = $provider.GetType().FullName
  $providerAssemblyVersion = $provider.GetType().Assembly.GetName().Version.ToString()
} finally {
  $provider.Dispose()
}
$metadata = [ordered]@{
  schemaVersion = 1
  powerShellVersion = $PSVersionTable.PSVersion.ToString()
  powerShellEdition = [string]$PSVersionTable.PSEdition
  clrVersion = [Environment]::Version.ToString()
  codeDomProvider = $providerType
  codeDomProviderAssemblyVersion = $providerAssemblyVersion
  cscFileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($cscPath).FileVersion
  cscSha256Before = $cscSha256Before
  cscSha256After = $cscSha256After
  powerShellExecutableSha256Before = $powerShellSha256Before
  powerShellExecutableSha256After = $powerShellSha256After
  runtimeDirectorySha256Before = $runtimeDirectorySha256Before
  runtimeDirectorySha256After = $runtimeDirectorySha256After
  runtimeRelativeInventory = $runtimeRelativeInventory
  outputType = 'ConsoleApplication'
  platform = 'x64'
  compilerOptions = $compilerOptions
  referencedAssemblies = $references
  referenceSha256Before = $referenceHashesBefore
  referenceSha256After = $referenceHashesAfter
  addTypeInvocation = 'Add-Type -Path Program.cs,Protocol.cs,FileSystem.cs,NamedPipe.cs,JobObject.cs,BrokerContext.cs -CompilerParameters <GenerateExecutable=true;GenerateInMemory=false;TreatWarningsAsErrors=true;OutputAssembly=<owned-build-root>;CompilerOptions="/target:exe /platform:x64 /checked+ /optimize+ /warn:4 /nologo";References=allowlisted-framework-paths> -ErrorAction Stop -WarningAction Stop'
  sourceSha256Before = $sourceHashesBefore
  sourceSha256After = $sourceHashesAfter
  assemblySha256 = (Get-FileHash -LiteralPath $resolvedOutput -Algorithm SHA256).Hash.ToLowerInvariant()
}
$metadataJson = ConvertTo-Json -InputObject $metadata -Compress -Depth 5
[Console]::Out.WriteLine([string]$metadataJson)
