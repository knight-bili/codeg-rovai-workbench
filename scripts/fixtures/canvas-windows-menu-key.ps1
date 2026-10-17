param([Parameter(Mandatory=$true)][int]$OwnedPid,[Parameter(Mandatory=$true)][long]$Hwnd,[Parameter(Mandatory=$true)][string]$DataRoot)
$ErrorActionPreference='Stop'
$owned=Get-CimInstance Win32_Process -Filter "ProcessId=$OwnedPid"
if (-not $owned -or $owned.Name -ne 'electron.exe' -or -not $owned.CommandLine.Contains('--user-data-dir=') -or -not $owned.CommandLine.Contains($DataRoot)) { throw 'Menu key target must be the owned isolated Electron Main' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedMenuKey {
 [StructLayout(LayoutKind.Explicit,Size=40)] public struct Input {
  [FieldOffset(0)] public uint type;[FieldOffset(8)] public ushort key;[FieldOffset(12)] public uint flags;
 }
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] input,int size);
 public static void Send(IntPtr h,uint pid) {
  uint actual;GetWindowThreadProcessId(h,out actual);if(actual!=pid||IntPtr.Size!=8)throw new Exception("Owned window identity mismatch");
  ShowWindow(h,9);SetForegroundWindow(h);System.Threading.Thread.Sleep(100);
  if(GetForegroundWindow()!=h)throw new Exception("Owned test window is not foreground");
  Input[] input={new Input{type=1,key=0x5d},new Input{type=1,key=0x5d,flags=2}};
  if(SendInput(2,input,40)!=2)throw new Exception("Native menu key input failed");
 }
}
'@
[OwnedMenuKey]::Send([IntPtr]$Hwnd,[uint32]$OwnedPid)
Write-Output (@{pid=$OwnedPid;hwnd=$Hwnd;native_virtual_key=93;events=2} | ConvertTo-Json -Compress)
