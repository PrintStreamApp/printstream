/**
 * Native admission for durable installation-operation claims. Claims live outside
 * both installed files and DATA, and are never stolen after a timeout or crash.
 * OWNER RIGHTS suppresses NetworkService's implicit owner WRITE_DAC: only the
 * exact service SID, SYSTEM and administrators may mutate this installation.
 */
export const WINDOWS_INSTALL_OPERATION_FUNCTIONS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SeaInstallPath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
  public static string Canonical(string path) {
    using (var file = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (file.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      var buffer = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandle(file, buffer, (uint)buffer.Capacity, 0);
      if (length == 0 || length >= buffer.Capacity) throw new InvalidOperationException("Installation path identity unavailable");
      string result = buffer.ToString();
      if (!result.StartsWith(@"\\?\") || result.StartsWith(@"\\?\UNC\")) throw new InvalidOperationException("Local installation path required");
      return result.Substring(4);
    }
  }
}
'@
function AssertPlainInstallPath([string] $path) {
  $cursor = [IO.Path]::GetFullPath($path)
  while ($cursor) {
    if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
      if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Installation operation refuses reparse paths' }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
function ResolveInstallPath([string] $path) {
  if ($path -notmatch '^[A-Za-z]:\\' -or $path -match '[\x00-\x1f]' -or $path -match '[ .](\\|$)') { throw 'Installation operation requires a plain absolute local path' }
  $full = [IO.Path]::GetFullPath($path).TrimEnd('\')
  if ($full.Length -le 3) { throw 'Installation operation refuses a drive root' }
  AssertPlainInstallPath $full
  $cursor = $full
  $suffix = New-Object 'Collections.Generic.List[string]'
  while (-not [IO.Directory]::Exists($cursor)) {
    if ([IO.File]::Exists($cursor)) { throw 'Installation directory is a file' }
    $suffix.Insert(0, [IO.Path]::GetFileName($cursor))
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  $canonical = [SeaInstallPath]::Canonical($cursor)
  foreach ($part in $suffix) { $canonical = [IO.Path]::Combine($canonical, $part) }
  return $canonical.TrimEnd('\')
}
function AssertInstallControlParent([string] $path) {
  AssertPlainInstallPath $path
  $cursor = $path
  $trustedInstaller = (New-Object Security.Principal.NTAccount('NT SERVICE', 'TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value
  while ($cursor) {
    $acl = Get-Acl -LiteralPath $cursor
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'Unrestricted installation control parent refused' }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544', $trustedInstaller)) { throw 'Untrusted installation control parent owner' }
    $dangerous = [Security.AccessControl.FileSystemRights]'DeleteSubdirectoriesAndFiles, Delete, ChangePermissions, TakeOwnership, WriteAttributes'
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
      if ($rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544', $trustedInstaller) -and ($rule.FileSystemRights -band $dangerous) -ne 0) { throw 'Replaceable installation control parent refused' }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
function NewInstallControlAcl([string] $serviceSid, [string] $owner) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($owner)))
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', $serviceSid, 'S-1-3-4')) {
    $rights = [Security.AccessControl.FileSystemRights]::FullControl
    if ($sid -eq $serviceSid) { $rights = [Security.AccessControl.FileSystemRights]::Modify }
    if ($sid -eq 'S-1-3-4') { $rights = [Security.AccessControl.FileSystemRights]::ReadPermissions }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), $rights, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  return $acl
}
function AssertInstallControlAcl([string] $path, [string] $serviceSid) {
  AssertPlainInstallPath $path
  $acl = Get-Acl -LiteralPath $path
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin @('S-1-5-18', 'S-1-5-32-544', $serviceSid)) { throw 'Untrusted installation control owner' }
  $expected = NewInstallControlAcl $serviceSid $owner
  $sections = [Security.AccessControl.AccessControlSections]::Access
  if ($acl.GetSecurityDescriptorSddlForm($sections) -ne $expected.GetSecurityDescriptorSddlForm($sections)) { throw 'Unexpected installation control ACL' }
}
function GetInstallControl([string] $installDir, [string] $serviceId, [string] $dataDir) {
  if ($serviceId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Invalid installation service identity' }
  $canonical = ResolveInstallPath $installDir
  $parent = [IO.Path]::GetPathRoot([Environment]::SystemDirectory)
  AssertInstallControlParent $parent
  $parent = [SeaInstallPath]::Canonical($parent)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical.ToUpperInvariant()))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  $directory = [IO.Path]::Combine($parent, '.sea-install-operation-' + $hash)
  foreach ($tree in @($canonical, $dataDir)) {
    if (-not $tree) { continue }
    $resolved = ResolveInstallPath $tree
    if ($directory.Equals($resolved, [StringComparison]::OrdinalIgnoreCase) -or $directory.StartsWith($resolved + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Installation control must be outside installed files and DATA' }
  }
  $sha1 = [Security.Cryptography.SHA1]::Create()
  try { $sidHash = $sha1.ComputeHash([Text.Encoding]::Unicode.GetBytes($serviceId.ToUpperInvariant())) } finally { $sha1.Dispose() }
  $parts = @(0,4,8,12,16 | ForEach-Object { [BitConverter]::ToUInt32($sidHash, $_) })
  $serviceSid = 'S-1-5-80-' + ($parts -join '-')
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin -and $identity.User.Value -ne 'S-1-5-18' -and -not ($identity.User.Value -eq 'S-1-5-20' -and $principal.IsInRole((New-Object Security.Principal.SecurityIdentifier($serviceSid))))) { throw 'Installation operation requires administrator or the exact service identity' }
  if (-not [IO.Directory]::Exists($directory)) {
    $owner = $identity.User.Value
    if ($owner -eq 'S-1-5-20') { $owner = $serviceSid }
    if ($admin) { $owner = 'S-1-5-32-544' }
    [IO.Directory]::CreateDirectory($directory, (NewInstallControlAcl $serviceSid $owner)) | Out-Null
  }
  AssertInstallControlAcl $directory $serviceSid
  return @{ directory=$directory; installDir=$canonical; claim=[IO.Path]::Combine($directory, 'active.json') }
}
# The start time of a running process as a UTC file time, or $null when it is gone or unreadable.
# Recorded with the owner's id, so clear-lock can tell the owner from a later process given the
# same id (Windows reuses process ids).
function ProcessStartedAt([int] $processId) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  try { return $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() } catch { return $null }
}
function AssertInstallClaim($control, [string] $token) {
  AssertPlainInstallPath $control.claim
  $record = [IO.File]::ReadAllText($control.claim) | ConvertFrom-Json
  if ($record.token -cne $token) { throw 'Installation operation claim ownership lost' }
}
`

/** JSON action protocol is internal; the random token never appears in diagnostics. */
export const WINDOWS_INSTALL_OPERATION_SCRIPT = WINDOWS_INSTALL_OPERATION_FUNCTIONS + String.raw`
$record = [Console]::In.ReadToEnd() | ConvertFrom-Json
$control = GetInstallControl $record.installDir $record.serviceId $record.dataDir
if ($record.action -eq 'acquire') {
  # WinSW announces Running independently of app readiness. Briefly wait for an
  # installer to finish rather than failing a child boot during that handoff.
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ($true) {
    try {
      $stream = New-Object IO.FileStream($control.claim, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      break
    } catch {
      if (-not [IO.File]::Exists($control.claim) -or [DateTime]::UtcNow -ge $deadline) { throw }
      Start-Sleep -Milliseconds 100
    }
  }
  $record | Add-Member -NotePropertyName cutoff -NotePropertyValue ([DateTime]::UtcNow.ToFileTimeUtc().ToString())
  $record | Add-Member -NotePropertyName ownerStartedAt -NotePropertyValue (ProcessStartedAt ([int]$record.pid))
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress))
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
} elseif ($record.action -eq 'release') {
  AssertInstallClaim $control $record.token
  [IO.File]::Delete($control.claim)
} elseif ($record.action -eq 'clear') {
  # Administrator recovery only. The owner is gone when no process has the recorded id, or the
  # process that has it started after the claim was taken (Windows reuses ids). Anything else,
  # including a start time that cannot be read, keeps the claim.
  AssertPlainInstallPath $control.claim
  if (-not [IO.File]::Exists($control.claim)) {
    @{ directory=$control.directory; installDir=$control.installDir; claim=$control.claim; outcome='none' } | ConvertTo-Json -Compress
    exit 0
  }
  $claimRecord = [IO.File]::ReadAllText($control.claim) | ConvertFrom-Json
  $ownerPid = [int]$claimRecord.pid
  $claimedAt = $null
  if ($claimRecord.cutoff) { $claimedAt = [DateTime]::FromFileTimeUtc([long]$claimRecord.cutoff) }
  $owner = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if ($owner) {
    $started = $null
    try { $started = $owner.StartTime.ToUniversalTime() } catch { $started = $null }
    # The owner is the process with the recorded id AND start time (claims from 1.3.24 and later,
    # and re-stamped by a cleanup that takes the claim over). Older claims have only the time the
    # claim was taken: a process that started before it may be the owner.
    $sameOwner = $true
    if ($null -ne $started -and $claimRecord.ownerStartedAt) {
      $sameOwner = [Math]::Abs($started.ToFileTimeUtc() - [long]$claimRecord.ownerStartedAt) -lt 10000000
    } elseif ($null -ne $started -and $null -ne $claimedAt) {
      $sameOwner = $started -le $claimedAt
    }
    if ($sameOwner) {
      @{ directory=$control.directory; installDir=$control.installDir; claim=$control.claim; outcome='still-running'; ownerPid=$ownerPid } | ConvertTo-Json -Compress
      exit 0
    }
  }
  [IO.File]::Delete($control.claim)
  $claimedText = $null
  if ($claimedAt) { $claimedText = $claimedAt.ToString('o') }
  @{ directory=$control.directory; installDir=$control.installDir; claim=$control.claim; outcome='cleared'; ownerPid=$ownerPid; claimedAt=$claimedText } | ConvertTo-Json -Compress
  exit 0
} else { throw 'Unknown installation operation action' }
@{ directory=$control.directory; installDir=$control.installDir; claim=$control.claim; cutoff=$record.cutoff } | ConvertTo-Json -Compress
`
