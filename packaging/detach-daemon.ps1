$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TaobaoDetached {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Startup {
    public int cb;
    public string reserved, desktop, title;
    public int x, y, xSize, ySize, xCount, yCount, fill, flags;
    public short show, reservedLength;
    public IntPtr reservedBytes, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct Info { public IntPtr process, thread; public int pid, tid; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
    ref Startup startup, out Info info);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Launch(string exe, string command, string directory) {
    Startup startup = new Startup(); startup.cb = Marshal.SizeOf(typeof(Startup));
    Info info;
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, bInheritHandles=false.
    if (!CreateProcessW(exe, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,
      0x208, IntPtr.Zero, directory, ref startup, out info))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    CloseHandle(info.thread); CloseHandle(info.process);
  }
}
'@
[TaobaoDetached]::Launch($env:TAOBAO_DETACHED_EXE, $env:TAOBAO_DETACHED_COMMAND, $env:TAOBAO_SEARCH_PROJECT_ROOT)
