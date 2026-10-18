import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const unsafe = 'LOCAL_STORAGE_UNSAFE';
const failed = 'LOCAL_STORAGE_FAILED';
class StorageError extends Error {}
const rejectUnsafe = () => { throw new StorageError(unsafe); };

// This is a literal Windows PowerShell 5.1 script, not generated commands.
// Only the environment carries the path. Never request/persist Audit (SACL),
// which would require SeSecurityPrivilege on otherwise ordinary directories.
const protectWindowsDirectory = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $target = $env:TELEGRAM_BROWSER_PRIVATE_DIRECTORY
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
    $identities = @($sid)
    if ($sid.Value -ne $systemSid.Value) { $identities += $systemSid }

    function New-PrivateSecurity {
        $security = [System.Security.AccessControl.DirectorySecurity]::new()
        $security.SetOwner($sid)
        $security.SetAccessRuleProtection($true, $false)
        foreach ($identity in $identities) {
            $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, $fullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
            [void]$security.AddAccessRule($rule)
        }
        return $security
    }

    function Read-Attributes([string]$entry) {
        try { return [System.IO.File]::GetAttributes($entry) }
        catch {
            $cause = $_.Exception
            while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
            if ($cause -is [System.IO.FileNotFoundException] -or $cause -is [System.IO.DirectoryNotFoundException]) { return $null }
            throw
        }
    }

    function Assert-Directory([string]$entry) {
        $attributes = Read-Attributes $entry
        if ($null -eq $attributes -or ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) {
            throw 'LOCAL_STORAGE_UNSAFE'
        }
    }

    function Assert-Private([string]$entry) {
        Assert-Directory $entry
        $acl = [System.IO.Directory]::GetAccessControl($entry, $sections)
        if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $acl.AreAccessRulesProtected) { throw 'LOCAL_STORAGE_UNSAFE' }
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne $identities.Count) { throw 'LOCAL_STORAGE_UNSAFE' }
        foreach ($identity in $identities) {
            $matches = @($rules | Where-Object { $_.IdentityReference.Value -eq $identity.Value })
            if ($matches.Count -ne 1) { throw 'LOCAL_STORAGE_UNSAFE' }
            $rule = $matches[0]
            if ($rule.IsInherited -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne $fullControl -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { throw 'LOCAL_STORAGE_UNSAFE' }
        }
    }

    $entries = [System.Collections.Generic.List[string]]::new()
    $cursor = [System.IO.DirectoryInfo]::new($target)
    while ($null -ne $cursor) {
        $entries.Insert(0, $cursor.FullName)
        $cursor = $cursor.Parent
    }
    $checked = [System.Collections.Generic.List[string]]::new()
    $hardened = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in $entries) {
        foreach ($parent in $checked) { Assert-Directory $parent }
        $attributes = Read-Attributes $entry
        $created = $null -eq $attributes
        if ($created) {
            # The Framework overload supplies the protected ACL at creation,
            # rather than briefly exposing a directory through inherited grants.
            [void][System.IO.Directory]::CreateDirectory($entry, (New-PrivateSecurity))
        }
        Assert-Directory $entry
        if ($created -or $entry -eq $target) {
            $existing = [System.IO.Directory]::GetAccessControl($entry, $sections)
            if ($existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'LOCAL_STORAGE_UNSAFE' }
            foreach ($parent in $checked) { Assert-Directory $parent }
            [System.IO.Directory]::SetAccessControl($entry, (New-PrivateSecurity))
            Assert-Private $entry
            $hardened.Add($entry)
        }
        $checked.Add($entry)
    }
    foreach ($entry in $checked) { Assert-Directory $entry }
    foreach ($entry in $hardened) { Assert-Private $entry }
    [Console]::Out.Write('OK')
} catch {
    if ($_.Exception.Message -eq 'LOCAL_STORAGE_UNSAFE') { [Console]::Out.Write('LOCAL_STORAGE_UNSAFE') }
    else { [Console]::Out.Write('LOCAL_STORAGE_FAILED') }
    exit 1
}
`;

function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function inspectDirectory(directory) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) rejectUnsafe();
  if (!samePath(await fs.realpath(directory), directory)) rejectUnsafe();
  // Catch a replacement during the lstat/realpath pair, including plain dirs.
  const verified = await fs.lstat(directory, { bigint: true });
  if (!verified.isDirectory() || verified.isSymbolicLink() || !sameIdentity(stat, verified)) rejectUnsafe();
  return verified;
}

function directoryChain(target) {
  const entries = [];
  for (let current = target;;) {
    entries.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) return entries;
    current = parent;
  }
}

async function verifySnapshots(snapshots) {
  for (const { directory, stat } of snapshots) {
    if (!sameIdentity(stat, await inspectDirectory(directory))) rejectUnsafe();
  }
}

async function protectPosixDirectory(directory, snapshots) {
  await verifySnapshots(snapshots);
  const expected = snapshots.at(-1).stat;
  if (typeof process.getuid === 'function' && expected.uid !== BigInt(process.getuid())) rejectUnsafe();
  const handle = await fs.open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameIdentity(expected, opened)) rejectUnsafe();
    await handle.chmod(0o700);
    const secured = await handle.stat({ bigint: true });
    if ((secured.mode & 0o7777n) !== 0o700n || (typeof process.getuid === 'function' && secured.uid !== BigInt(process.getuid()))) rejectUnsafe();
    await verifySnapshots(snapshots);
  } finally { await handle.close(); }
}

async function protectOnWindows(target) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await execFileAsync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', protectWindowsDirectory], {
      env: { ...process.env, TELEGRAM_BROWSER_PRIVATE_DIRECTORY: target },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 1024,
    });
    if (stdout !== 'OK') throw new StorageError(failed);
  } catch (error) {
    if (error?.stdout === unsafe) rejectUnsafe();
    throw new StorageError(failed);
  }
}

/**
 * Secure a directory, never a redirected path. Existing ancestors are checked,
 * not chmod'ed/re-ACL'ed; only the target and newly created directories change.
 * Checks detect path replacement but cannot make path-based OS APIs atomic
 * against an attacker concurrently renaming ancestors.
 */
export async function ensurePrivateDirectory(input) {
  try {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) rejectUnsafe();
    const target = path.resolve(input);
    if (path.dirname(target) === target) rejectUnsafe();
    const entries = directoryChain(target);
    const snapshots = [];
    for (const directory of entries) {
      let stat;
      try { stat = await inspectDirectory(directory); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await verifySnapshots(snapshots);
        if (process.platform === 'win32') break;
        try { await fs.mkdir(directory, { mode: 0o700 }); }
        catch (creationError) { if (creationError?.code !== 'EEXIST') throw creationError; }
        stat = await inspectDirectory(directory);
        snapshots.push({ directory, stat });
        await protectPosixDirectory(directory, snapshots);
        continue;
      }
      snapshots.push({ directory, stat });
    }
    await verifySnapshots(snapshots);
    if (process.platform === 'win32') {
      await protectOnWindows(target);
      await verifySnapshots(snapshots);
      // Newly created components also need lstat + realpath checks.
      for (const directory of entries) await inspectDirectory(directory);
    } else {
      await protectPosixDirectory(target, snapshots);
    }
    return target;
  } catch (error) {
    // No raw paths, child output, causes, or OS errors cross this boundary.
    throw new Error(error instanceof StorageError ? error.message : failed);
  }
}
