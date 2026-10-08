import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { capture, findExecutable } from '../../src/hub/capabilities.js';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';
import { doctor } from '../../src/hub/maintenance.js';

test('Windows hub repairs explicit and inherited ACL grants and doctor rejects unsafe state', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-acl-'));
  const home = path.join(root, 'state'); const child = path.join(home, 'child');
  await mkdir(child, { recursive: true }); await writeFile(path.join(child, 'data.txt'), 'synthetic fixture');
  const shell = await findExecutable('pwsh').catch(() => findExecutable('powershell'));
  const ps = async (script: string) => {
    const result = await capture(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('$ErrorActionPreference="Stop"; ' + script, 'utf16le').toString('base64')], undefined, { ...process.env, STAMPEDE_ACL_FIXTURE: home });
    assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
  };
  const verify = async () => {
    const rows = JSON.parse(await ps(`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      $items=@(Get-Item -LiteralPath $env:STAMPEDE_ACL_FIXTURE)+@(Get-ChildItem -LiteralPath $env:STAMPEDE_ACL_FIXTURE -Recurse -Force);
      @($items | ForEach-Object { $acl=Get-Acl -LiteralPath $_.FullName; $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));
        @{root=($_.FullName -eq $env:STAMPEDE_ACL_FIXTURE); protected=$acl.AreAccessRulesProtected; count=$rules.Count;
          own=($rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid); inherited=$rules[0].IsInherited; full=($rules[0].FileSystemRights -eq 'FullControl')} }) | ConvertTo-Json -Compress`));
    for (const row of rows) { assert.equal(row.count, 1); assert.equal(row.own, true); assert.equal(row.full, true); assert.equal(row.protected, row.root); assert.equal(row.inherited, !row.root); }
  };
  const config = defaults(); const unavailable = { available: false, capabilities: {} };
  const boot = () => startHub({ home, config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: unavailable, codex: unavailable } });
  try {
    await ps(`$everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0');
      $acl=Get-Acl -LiteralPath $env:STAMPEDE_ACL_FIXTURE;
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'));
      try { $sandboxSid=[Security.Principal.NTAccount]::new('CodexSandboxUsers').Translate([Security.Principal.SecurityIdentifier]);
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sandboxSid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')); }
      catch [Security.Principal.IdentityNotMappedException] { }
      Set-Acl -LiteralPath $env:STAMPEDE_ACL_FIXTURE -AclObject $acl;
      $child=Join-Path $env:STAMPEDE_ACL_FIXTURE 'child'; $acl=Get-Acl -LiteralPath $child;
      $acl.SetAccessRuleProtection($true,$true); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));
      Set-Acl -LiteralPath $child -AclObject $acl;`);
    let hub = await boot(); try { await verify(); } finally { await hub.close(); }
    await ps(`$file=Join-Path $env:STAMPEDE_ACL_FIXTURE 'child/data.txt'; $acl=Get-Acl -LiteralPath $file;
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'));
      Set-Acl -LiteralPath $file -AclObject $acl;`);
    hub = await boot(); try { await verify(); } finally { await hub.close(); }
    const outside = path.join(root, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(home, 'unsafe-link'), 'junction');
    await assert.rejects(doctor(home), /cannot protect Stampede state:.*reparse point/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
