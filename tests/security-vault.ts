import { execFile } from 'node:child_process';
import { join } from 'node:path';

const manageCredential = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TestCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint BlobSize;
    public IntPtr Blob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }

  [DllImport("Advapi32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("Advapi32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
  private static extern bool CredWriteW(ref Credential credential, uint flags);
  [DllImport("Advapi32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
  private static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("Advapi32.dll", ExactSpelling = true)]
  private static extern void CredFree(IntPtr credential);

  public static int Run(string target, bool remove) {
    if (remove) return CredDeleteW(target, 1, 0) ? 0 : 1;
    IntPtr existing;
    if (CredReadW(target, 1, 0, out existing)) { CredFree(existing); return 1; }
    if (Marshal.GetLastWin32Error() != 1168) return 1;
    var input = Console.OpenStandardInput();
    var blob = new byte[86];
    var pinned = GCHandle.Alloc(blob, GCHandleType.Pinned);
    try {
      for (int i = 0; i < 43; i++) {
        int value = input.ReadByte();
        if (value < 0 || value > 127) return 1;
        blob[i * 2] = (byte)value;
      }
      if (input.ReadByte() != -1) return 1;
      var entry = new Credential { Type = 1, TargetName = target, Persist = 1,
        UserName = "Knowledge Engine security test", Blob = pinned.AddrOfPinnedObject(), BlobSize = (uint)blob.Length };
      return CredWriteW(ref entry, 0) ? 0 : 1;
    } finally { Array.Clear(blob, 0, blob.Length); pinned.Free(); }
  }
}
'@
  exit ([TestCredential]::Run($env:KE_TEST_VAULT_TARGET, $env:KE_TEST_VAULT_DELETE -eq '1'))
} catch { exit 1 }
`;

export async function updateTestVault(target: string, key?: string) {
  const { SystemRoot, TEMP, TMP } = process.env;
  if (process.platform !== 'win32' || !SystemRoot || !/^KnowledgeEngine-MCP-STDIO-Test-[a-f0-9]{24}-(a|b|reader|invalid)$/.test(target)) {
    throw new Error('A Windows session and a test-only credential target are required.');
  }
  if (key !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid test key format.');
  const powershell = join(SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = Buffer.from(manageCredential, 'utf16le').toString('base64');
  await new Promise<void>((resolve, reject) => {
    const child = execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      windowsHide: true, timeout: 10_000, maxBuffer: 4096,
      env: { SystemRoot, TEMP, TMP, NODE_ENV: 'production', KE_TEST_VAULT_TARGET: target, KE_TEST_VAULT_DELETE: key ? '0' : '1' },
    }, error => error ? reject(new Error('Windows test vault operation failed.')) : resolve());
    child.stdin?.on('error', () => {});
    child.stdin?.end(key);
  });
}
