param(
  [Parameter(Mandatory)][int]$AppPid,
  [Parameter(Mandatory)][long]$WindowHandle,
  [Parameter(Mandatory)][ValidateSet('compose','commit','toggle-ime','clear','cancel','enter','copy')][string]$Action
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class CanvasWindowsInput {
  [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x,y; public uint data,flags,time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Keyboard keyboard; [FieldOffset(0)] public Mouse mouse; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Union data; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern short GetKeyState(int key);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  public static string Layout(IntPtr hwnd) { uint pid; return GetKeyboardLayout(GetWindowThreadProcessId(hwnd,out pid)).ToInt64().ToString("X"); }
  public static void Guard(IntPtr hwnd,int expected) {
    uint pid; GetWindowThreadProcessId(hwnd,out pid);
    if(pid!=expected || GetAncestor(GetForegroundWindow(),2)!=hwnd) throw new Exception("Owned application must be foreground before physical input");
  }
  static void Key(IntPtr hwnd,int pid,ushort vk,bool up) {
    Guard(hwnd,pid);
    var input = new Input { type=1, data=new Union { keyboard=new Keyboard { vk=vk, flags=up?2u:0u } } };
    if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(Input)))!=1) throw new Exception("SendInput failed: "+Marshal.GetLastWin32Error());
  }
  static void Tap(IntPtr hwnd,int pid,ushort vk) { Key(hwnd,pid,vk,false); Thread.Sleep(35); Key(hwnd,pid,vk,true); Thread.Sleep(65); }
  static void Chord(IntPtr hwnd,int pid,ushort vk,bool shift) {
    Key(hwnd,pid,0x11,false);
    try { if(shift) Key(hwnd,pid,0x10,false); try { Tap(hwnd,pid,vk); } finally { if(shift) Key(hwnd,pid,0x10,true); } }
    finally { Key(hwnd,pid,0x11,true); }
  }
  public static void Run(IntPtr hwnd,int pid,string action) {
    Guard(hwnd,pid);
    foreach(var vk in new[]{0x10,0x11,0x12,0x5B,0x5C}) if(GetAsyncKeyState(vk)<0) throw new Exception("A physical modifier is held; input cancelled");
    if((GetKeyState(0x14)&1)!=0) throw new Exception("CapsLock is enabled; input cancelled without changing it");
    if(action=="compose") { foreach(char c in "NIHAO") Tap(hwnd,pid,(ushort)c); }
    else if(action=="commit") Tap(hwnd,pid,0x20);
    else if(action=="toggle-ime") Tap(hwnd,pid,0x10);
    else if(action=="clear") Chord(hwnd,pid,0x55,false);
    else if(action=="cancel") Tap(hwnd,pid,0x1B);
    else if(action=="copy") Chord(hwnd,pid,0x43,true);
    else if(action=="enter") Tap(hwnd,pid,0x0D);
    Thread.Sleep(400);
  }
}
'@
$taskHwnd = [IntPtr]::new($WindowHandle)
[CanvasWindowsInput]::Guard($taskHwnd,$AppPid)
$taskLayoutBefore = [CanvasWindowsInput]::Layout($taskHwnd)
[CanvasWindowsInput]::Run($taskHwnd,$AppPid,$Action)
[pscustomobject]@{ action=$Action; app_pid=$AppPid; window_handle=$WindowHandle; transport='Win32 SendInput virtual keys; no Unicode injection or DOM composition'; layout_before=$taskLayoutBefore; layout_after=[CanvasWindowsInput]::Layout($taskHwnd); foreground_verified=$true } | ConvertTo-Json -Compress
