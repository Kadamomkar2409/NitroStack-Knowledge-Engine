import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../backend/core/db.ts';

const readCredential = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

public static class WorkspaceCredential {
  [StructLayout(LayoutKind.Sequential)]
  private struct Credential {
    public uint Flags, Type;
    public IntPtr TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint BlobSize;
    public IntPtr Blob;
  }

  [DllImport("Advapi32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

  [DllImport("Advapi32.dll", ExactSpelling = true)]
  private static extern void CredFree(IntPtr credential);

  public static int WriteHash() {
    IntPtr pointer;
    if (!CredReadW(Environment.GetEnvironmentVariable("KE_VAULT_TARGET"), 1, 0, out pointer)) {
      const int ErrorNotFound = 1168;
      return Marshal.GetLastWin32Error() == ErrorNotFound ? 2 : 1;
    }
    byte[] key = null;
    byte[] hash = null;
    try {
      var entry = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (entry.Blob == IntPtr.Zero || entry.BlobSize < 64 || entry.BlobSize > 258 || entry.BlobSize % 2 != 0) return 3;
      int length = (int)entry.BlobSize / 2;
      if (Marshal.ReadInt16(entry.Blob, (length - 1) * 2) == 0) length--;
      if (length < 32 || length > 128) return 3;
      key = new byte[length];
      for (int i = 0; i < length; i++) {
        int c = Marshal.ReadInt16(entry.Blob, i * 2);
        if (!(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_')) return 3;
        key[i] = (byte)c;
      }
      using (var sha = SHA256.Create()) hash = sha.ComputeHash(key);
      var output = Console.OpenStandardOutput();
      output.Write(hash, 0, hash.Length);
      output.Flush();
      return 0;
    } finally {
      if (key != null) Array.Clear(key, 0, key.Length);
      if (hash != null) Array.Clear(hash, 0, hash.Length);
      CredFree(pointer);
    }
  }
}
'@
  exit ([WorkspaceCredential]::WriteHash())
} catch { exit 1 }
`;

export async function readWorkspaceCredentialHash(target = 'KnowledgeEngine-MCP-STDIO') {
  if (target !== 'KnowledgeEngine-MCP-STDIO' && !/^KnowledgeEngine-MCP-STDIO-Test-[a-f0-9]{24}-(a|b|reader|invalid|missing)$/.test(target)) {
    throw new AppError(400, 'windows_credential', 'Unrecognized Windows Credential Manager target.');
  }
  const { SystemRoot, TEMP, TMP } = process.env;
  if (process.platform !== 'win32' || !SystemRoot) {
    throw new AppError(503, 'windows_credential', 'Windows Credential Manager is required.');
  }

  const powershell = join(SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // The encoded command is fixed source code. Only a hash crosses the private child pipe.
  const command = Buffer.from(readCredential, 'utf16le').toString('base64');
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    encoding: 'buffer', windowsHide: true, timeout: 10_000, maxBuffer: 4096,
    env: { SystemRoot, TEMP, TMP, NODE_ENV: 'production', KE_VAULT_TARGET: target },
  }).catch((error: NodeJS.ErrnoException) => {
    if (Number(error.code) === 2 || Number(error.code) === 3) {
      throw new AppError(401, 'windows_credential', 'Provision a valid KnowledgeEngine-MCP-STDIO Generic Credential in Windows Credential Manager.');
    }
    throw new AppError(503, 'windows_credential', 'Windows Credential Manager could not be read.');
  });
  try {
    if (stdout.length !== 32) throw new Error('Windows Credential Manager returned an invalid credential digest.');
    return stdout.toString('hex');
  } finally {
    stdout.fill(0);
  }
}
