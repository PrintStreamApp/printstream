/**
 * Owns an administrator-only, fresh uninstall handoff outside the installation
 * being removed. ACL admission precedes executable bytes, using the same atomic
 * DirectorySecurity creation convention as the app's private stop credential.
 * This public helper has a fixed SYSTEM/Administrators policy, not service secrets
 * or app identity. Existing paths and untrusted parents are refused, never repaired.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { windowsPowerShellPath, windowsVbsCommandLiteral } from './windows-hidden-launch.js'

/** Fixed native ACL policy; JSON input carries only the fresh path and launcher contents. */
export const WINDOWS_CLEANUP_BOOTSTRAP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$inputRecord = [Console]::In.ReadToEnd() | ConvertFrom-Json
$admins = 'S-1-5-32-544'
$system = 'S-1-5-18'
$trustedInstaller = (New-Object Security.Principal.NTAccount('NT SERVICE', 'TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value
function AssertPlainPath([string] $path) {
  $cursor = [IO.Path]::GetFullPath($path)
  while ($cursor) {
    if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
      if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Cleanup bootstrap reparse path refused' }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
function AssertTrustedParent([string] $path) {
  AssertPlainPath $path
  if (-not [IO.Directory]::Exists($path)) { throw 'Cleanup bootstrap parent missing' }
  $cursor = [IO.Path]::GetFullPath($path)
  $leaf = $true
  while ($cursor) {
    $acl = Get-Acl -LiteralPath $cursor
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'Unrestricted cleanup bootstrap parent ACL refused' }
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin @($admins, $system, $trustedInstaller)) { throw 'Untrusted cleanup bootstrap parent owner' }
    # At ancestors, creating a foreign sibling is harmless; replacing this
    # trusted path through deletion, ACL changes or reparse attributes is not.
    $dangerous = [Security.AccessControl.FileSystemRights]'DeleteSubdirectoriesAndFiles, Delete, ChangePermissions, TakeOwnership, WriteAttributes'
    if ($leaf) { $dangerous = $dangerous -bor [Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
      if ($rule.IdentityReference.Value -notin @($admins, $system, $trustedInstaller) -and ($rule.FileSystemRights -band $dangerous) -ne 0) { throw 'Writable cleanup bootstrap parent refused' }
    }
    $leaf = $false
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
function NewPrivateAcl([bool] $directory) {
  if ($directory) { $acl = New-Object Security.AccessControl.DirectorySecurity }
  else { $acl = New-Object Security.AccessControl.FileSecurity }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($admins)))
  foreach ($sid in @($system, $admins)) {
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
    if ($directory) { $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  return $acl
}
function AssertPrivateAcl([string] $path, [bool] $directory) {
  AssertPlainPath $path
  $acl = Get-Acl -LiteralPath $path
  if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $admins) { throw 'Untrusted cleanup bootstrap ACL owner or inheritance' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 2) { throw 'Unexpected cleanup bootstrap ACL entries' }
  foreach ($sid in @($system, $admins)) {
    $matching = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid })
    if ($matching.Count -ne 1) { throw 'Missing cleanup bootstrap ACL entry' }
    $rule = $matching[0]
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
    if ($directory) { $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or [int]$rule.FileSystemRights -ne [int][Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne 'None') { throw 'Untrusted cleanup bootstrap ACL rights' }
  }
}
$directory = [IO.Path]::GetFullPath($inputRecord.directory)
$parent = [IO.Path]::GetDirectoryName($directory)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevated cleanup bootstrap required' }
AssertTrustedParent $parent
if ([IO.File]::Exists($directory) -or [IO.Directory]::Exists($directory)) { throw 'Fresh cleanup bootstrap required' }
[IO.Directory]::CreateDirectory($directory, (NewPrivateAcl $true)) | Out-Null
AssertPrivateAcl $directory $true
$launcher = [IO.Path]::Combine($directory, 'cleanup.vbs')
$stream = New-Object IO.FileStream($launcher, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$stream.Dispose()
[IO.File]::SetAccessControl($launcher, (NewPrivateAcl $false))
AssertPrivateAcl $launcher $false
$payload = [IO.Path]::Combine($directory, 'cleanup.ps1')
$payloadStream = New-Object IO.FileStream($payload, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$payloadStream.Dispose()
[IO.File]::SetAccessControl($payload, (NewPrivateAcl $false))
AssertPrivateAcl $payload $false
[IO.File]::WriteAllText($payload, $inputRecord.payload, [Text.Encoding]::Unicode)
AssertPrivateAcl $payload $false
# WScript recognizes a UTF-16 BOM; UTF-8 without a BOM would reinterpret a
# localized ProgramFiles path using the caller's ANSI code page.
[IO.File]::WriteAllText($launcher, $inputRecord.contents, [Text.Encoding]::Unicode)
AssertPrivateAcl $directory $true
AssertPrivateAcl $launcher $false
@{directory=$directory;launcher=$launcher} | ConvertTo-Json -Compress
`

/**
 * Emit the qualified hidden, waiting WScript handoff. EncodedCommand preserves
 * the reviewed PowerShell payload exactly without changing host execution policy.
 * Only this fresh bootstrap is deleted after PowerShell exits; DATA is never a target.
 */
export function buildWindowsCleanupLauncher(script: string, directory: string): string {
  if (/[\0\r\n]/.test(directory)) throw new Error('Cleanup bootstrap refuses control characters')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const command = windowsVbsCommandLiteral(windowsPowerShellPath(), [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded
  ])
  const literal = `"${directory.replaceAll('"', '""')}"`
  return `exitCode = CreateObject("WScript.Shell").Run(${command}, 0, True)\r\n`
    + `CreateObject("Scripting.FileSystemObject").DeleteFolder ${literal}, True\r\n`
    + 'WScript.Quit exitCode\r\n'
}

/**
 * Synchronously admit and write a fresh privileged launcher. The caller may hand
 * it off only after actual ACL readback succeeds. A setup timeout/refusal leaves
 * no admitted helper and throws; it never removes an unknown partial directory.
 */
export function prepareWindowsCleanupBootstrap(script: string, installDir: string): { directory: string; launcher: string } {
  const parent = process.env.ProgramFiles ?? 'C:\\Program Files'
  const directory = path.win32.join(parent, `.sea-cleanup-${randomUUID()}`)
  const relative = path.win32.relative(path.win32.normalize(installDir), directory)
  if (!path.win32.isAbsolute(parent) || !relative || (!relative.startsWith('..\\') && !path.win32.isAbsolute(relative))) {
    throw new Error('Cleanup bootstrap must be outside the installation directory')
  }
  // Keep the command line bounded even when admission/cleanup includes native
  // helpers. The payload receives the same protected ACL before any bytes land.
  const payload = path.win32.join(directory, 'cleanup.ps1').replaceAll("'", "''")
  const trampoline = `& ([ScriptBlock]::Create([IO.File]::ReadAllText('${payload}')))`
  const contents = buildWindowsCleanupLauncher(trampoline, directory)
  const result = spawnSync(windowsPowerShellPath(), [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand',
    Buffer.from(WINDOWS_CLEANUP_BOOTSTRAP_SCRIPT, 'utf16le').toString('base64')
  ], { input: JSON.stringify({ directory, contents, payload: script }), encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error('Windows cleanup bootstrap admission failed')
  }
  const observed: unknown = JSON.parse(result.stdout)
  const launcher = path.win32.join(directory, 'cleanup.vbs')
  if (!observed || typeof observed !== 'object' || !('directory' in observed) || !('launcher' in observed)
      || observed.directory !== directory || observed.launcher !== launcher) {
    throw new Error('Windows cleanup bootstrap returned unexpected paths')
  }
  return { directory, launcher }
}
