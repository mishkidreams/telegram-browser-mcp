import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensurePrivateDirectory } from '../src/local-storage.mjs';

const windows = process.platform === 'win32';
const execFileAsync = promisify(execFile);
const unsafe = 'LOCAL_STORAGE_UNSAFE';
const failed = 'LOCAL_STORAGE_FAILED';

async function fixture(t) {
  // Canonicalize only the OS temp root; all mutations stay in our own root.
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'tg-private-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function rejectsFixed(promise, expected = unsafe) {
  await assert.rejects(promise, error => {
    assert.equal(error.constructor, Error);
    assert.equal(error.message, expected);
    assert.equal(error.cause, undefined);
    assert.equal(error.stdout, undefined);
    assert.equal(error.stderr, undefined);
    assert.equal(error.path, undefined);
    return true;
  });
}

async function windowsScript(script, env) {
  try {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execFileAsync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8', timeout: 20_000, maxBuffer: 32_768,
    });
    return stdout;
  } catch { throw new Error('WINDOWS_TEST_METADATA_FAILED'); }
}

// Only booleans and numeric ACL flags leave PowerShell. No names, SDDL, or
// account identifiers are logged, even on assertion failures.
async function windowsMetadata(entries) {
  const output = await windowsScript(String.raw`
$ErrorActionPreference = 'Stop'
try {
    $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
    $items = @()
    foreach ($entry in (ConvertFrom-Json $env:TELEGRAM_STORAGE_TEST_PATHS)) {
        $attributes = [System.IO.File]::GetAttributes($entry)
        if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) { $acl = [System.IO.Directory]::GetAccessControl($entry, $sections) }
        else { $acl = [System.IO.File]::GetAccessControl($entry, $sections) }
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
            [pscustomobject]@{
                current = $_.IdentityReference.Value -eq $current
                system = $_.IdentityReference.Value -eq 'S-1-5-18'
                inherited = $_.IsInherited
                allow = $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow
                rights = [int]$_.FileSystemRights
                inheritance = [int]$_.InheritanceFlags
                propagation = [int]$_.PropagationFlags
            }
        })
        $items += [pscustomobject]@{
            ownerIsCurrent = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $current
            protected = $acl.AreAccessRulesProtected
            rules = $rules
        }
    }
    ConvertTo-Json -InputObject $items -Depth 6 -Compress
} catch { [Console]::Out.Write('TEST_FAILED'); exit 1 }
`, { TELEGRAM_STORAGE_TEST_PATHS: JSON.stringify(entries) });
  try { return JSON.parse(output); }
  catch { throw new Error('WINDOWS_TEST_METADATA_FAILED'); }
}

function assertWindowsPrivate(metadata, { inherited = false, file = false } = {}) {
  assert.equal(metadata.ownerIsCurrent, true);
  assert.equal(metadata.protected, !inherited);
  assert.equal(metadata.rules.some(rule => rule.current), true);
  assert.equal(metadata.rules.some(rule => rule.system), true);
  assert.equal(metadata.rules.length, metadata.rules.some(rule => rule.current && rule.system) ? 1 : 2);
  for (const rule of metadata.rules) {
    assert.equal(rule.current || rule.system, true);
    assert.equal(rule.inherited, inherited);
    assert.equal(rule.allow, true);
    assert.equal(rule.rights, 2032127); // FullControl, including Synchronize.
    assert.equal(rule.inheritance, file ? 0 : 3); // ObjectInherit | ContainerInherit.
    assert.equal(rule.propagation, 0);
  }
}

test('creates plain empty storage recursively and returns an absolute resolved path', async t => {
  const root = await fixture(t);
  const target = path.join(root, 'one', 'two', 'storage');
  const relative = path.relative(process.cwd(), target);
  assert.equal(await ensurePrivateDirectory(relative), path.resolve(target));
  assert.deepEqual(await fs.readdir(target), []);
  assert.equal(await ensurePrivateDirectory(target), target);
  assert.equal((await fs.lstat(target)).isDirectory(), true);
});

test('paths are literal data, including shell syntax and metadata-like directory names', async t => {
  const root = await fixture(t);
  const target = path.join(root, "literal ' [brackets] ; $data", '.owner');
  assert.equal(await ensurePrivateDirectory(target), target);
  assert.deepEqual(await fs.readdir(target), []);
  assert.deepEqual(await fs.readdir(root), ["literal ' [brackets] ; $data"]);
});

test('existing ordinary storage preserves its contents and leaves existing ancestors unchanged', async t => {
  const root = await fixture(t);
  const parent = path.join(root, 'existing-parent');
  const target = path.join(parent, 'storage');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'fixture.txt'), 'owned fixture bytes');
  const before = windows ? await windowsMetadata([parent]) : (await fs.stat(parent)).mode;
  assert.equal(await ensurePrivateDirectory(target), target);
  assert.equal(await fs.readFile(path.join(target, 'fixture.txt'), 'utf8'), 'owned fixture bytes');
  const after = windows ? await windowsMetadata([parent]) : (await fs.stat(parent)).mode;
  assert.deepEqual(after, before);
});

test('invalid inputs and filesystem roots fail with fixed errors only', async () => {
  for (const input of [undefined, null, 42, {}, '', '   ', 'private\0sentinel', path.parse(process.cwd()).root]) {
    await rejectsFixed(ensurePrivateDirectory(input));
  }
});

test('files at the target or in its ancestry are rejected without altering contents', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  await fs.writeFile(file, 'owned fixture bytes');
  await rejectsFixed(ensurePrivateDirectory(file));
  await rejectsFixed(ensurePrivateDirectory(path.join(file, 'nested')));
  assert.equal(await fs.readFile(file, 'utf8'), 'owned fixture bytes');
});

test('existing final redirects and redirected parents are rejected, without touching their destinations', async t => {
  const root = await fixture(t);
  const destination = path.join(root, 'destination');
  await fs.mkdir(destination);
  if (!windows) await fs.chmod(destination, 0o755);
  const before = windows ? await windowsMetadata([destination]) : (await fs.stat(destination)).mode;
  const alias = path.join(root, 'redirect');
  await fs.symlink(destination, alias, windows ? 'junction' : 'dir');
  await rejectsFixed(ensurePrivateDirectory(alias));
  await rejectsFixed(ensurePrivateDirectory(path.join(alias, 'nested')));
  assert.deepEqual(await fs.readdir(destination), []);
  const after = windows ? await windowsMetadata([destination]) : (await fs.stat(destination)).mode;
  assert.deepEqual(after, before);
});

test('a parent redirected after an initial path check is detected before hardening', async t => {
  const root = await fixture(t);
  const parent = path.join(root, 'parent');
  const target = path.join(parent, 'storage');
  const destination = path.join(root, 'destination');
  const redirectedTarget = path.join(destination, 'storage');
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(redirectedTarget, { recursive: true });
  if (!windows) await fs.chmod(redirectedTarget, 0o755);
  const before = windows ? await windowsMetadata([redirectedTarget]) : (await fs.stat(redirectedTarget)).mode;
  const originalRealpath = fs.realpath;
  let changed = false;
  const mock = t.mock.method(fs, 'realpath', async (...args) => {
    const result = await originalRealpath(...args);
    if (!changed && args[0] === target) {
      changed = true;
      await fs.rename(parent, path.join(root, 'original-parent'));
      await fs.symlink(destination, parent, windows ? 'junction' : 'dir');
    }
    return result;
  });
  try { await rejectsFixed(ensurePrivateDirectory(target)); }
  finally { mock.mock.restore(); }
  assert.equal(changed, true);
  const after = windows ? await windowsMetadata([redirectedTarget]) : (await fs.stat(redirectedTarget)).mode;
  assert.deepEqual(after, before);
});

test('POSIX new directories and an existing permissive target have exactly mode 0700', { skip: windows }, async t => {
  const root = await fixture(t);
  const first = path.join(root, 'first');
  const second = path.join(first, 'second');
  const target = path.join(second, 'storage');
  await ensurePrivateDirectory(target);
  for (const directory of [first, second, target]) {
    const stat = await fs.stat(directory);
    assert.equal(stat.mode & 0o7777, 0o700);
    if (typeof process.getuid === 'function') assert.equal(stat.uid, process.getuid());
  }
  await fs.chmod(target, 0o777);
  await ensurePrivateDirectory(target);
  assert.equal((await fs.stat(target)).mode & 0o7777, 0o700);
});

test('POSIX incompatible ownership is rejected before permissions change', { skip: windows || typeof process.getuid !== 'function' }, async t => {
  const root = await fixture(t);
  const target = path.join(root, 'storage');
  await fs.mkdir(target);
  await fs.chmod(target, 0o755);
  const uid = process.getuid();
  // Exercise the ownership comparison without requiring chown privileges or
  // touching anything outside this fixture.
  const mock = t.mock.method(process, 'getuid', () => uid + 1);
  try { await rejectsFixed(ensurePrivateDirectory(target)); }
  finally { mock.mock.restore(); }
  assert.equal((await fs.stat(target)).mode & 0o7777, 0o755);
});

test('Windows replaces unrelated explicit grants and protects inheritable user/SYSTEM DACLs', { skip: !windows }, async t => {
  const root = await fixture(t);
  const target = path.join(root, 'storage');
  await fs.mkdir(target);
  await windowsScript(String.raw`
$ErrorActionPreference = 'Stop'
try {
    $entry = $env:TELEGRAM_STORAGE_TEST_TARGET
    $sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
    $acl = [System.IO.Directory]::GetAccessControl($entry, $sections)
    $world = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($world, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
    [System.IO.Directory]::SetAccessControl($entry, $acl)
} catch { [Console]::Out.Write('TEST_FAILED'); exit 1 }
`, { TELEGRAM_STORAGE_TEST_TARGET: target });
  const [before] = await windowsMetadata([target]);
  assert.equal(before.rules.some(rule => !rule.current && !rule.system), true);
  await ensurePrivateDirectory(target);
  const child = path.join(target, 'child');
  const file = path.join(child, 'fixture.txt');
  await fs.mkdir(child);
  await fs.writeFile(file, 'owned fixture bytes');
  const [secured, inheritedDirectory, inheritedFile] = await windowsMetadata([target, child, file]);
  assertWindowsPrivate(secured);
  assertWindowsPrivate(inheritedDirectory, { inherited: true });
  assertWindowsPrivate(inheritedFile, { inherited: true, file: true });
});

test('Windows creates every new component with a protected private DACL', { skip: !windows }, async t => {
  const root = await fixture(t);
  const first = path.join(root, 'first');
  const second = path.join(first, 'second');
  const target = path.join(second, 'storage');
  await ensurePrivateDirectory(target);
  for (const metadata of await windowsMetadata([first, second, target])) assertWindowsPrivate(metadata);
});

test('Windows native helper launch failures expose neither input paths nor raw child errors', { skip: !windows }, async t => {
  const root = await fixture(t);
  const original = process.env.SystemRoot;
  process.env.SystemRoot = path.join(root, 'missing-windows-sentinel');
  try { await rejectsFixed(ensurePrivateDirectory(path.join(root, 'storage')), failed); }
  finally {
    if (original === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = original;
  }
});
