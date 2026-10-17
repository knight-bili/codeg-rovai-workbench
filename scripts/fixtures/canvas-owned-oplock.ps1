param([Parameter(Mandatory=$true)][string]$SourcePath,[Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference='Stop'
$resolvedSource=[IO.Path]::GetFullPath($SourcePath)
$resolvedFixture=[IO.Path]::GetFullPath($FixtureRoot).TrimEnd('\')+'\'
if (-not $resolvedSource.StartsWith($resolvedFixture,[StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($resolvedSource)) { throw 'Oplock source must be an existing owned fixture file' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class OwnedSourceOplock {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateEvent(IntPtr attributes,bool manual,bool state,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(IntPtr file,uint code,IntPtr input,uint inputSize,IntPtr output,uint outputSize,out uint returned,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CancelIoEx(IntPtr file,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 public static void Run(string path) {
  IntPtr file=new IntPtr(-1),signal=IntPtr.Zero,overlapped=IntPtr.Zero;
  try {
   file=CreateFile(path,0x80000000,7,IntPtr.Zero,3,0x40000000,IntPtr.Zero);
   if(file==new IntPtr(-1))throw new Exception("CreateFile "+Marshal.GetLastWin32Error());
   signal=CreateEvent(IntPtr.Zero,true,false,null);
   if(signal==IntPtr.Zero)throw new Exception("CreateEvent "+Marshal.GetLastWin32Error());
   int bytes=IntPtr.Size==8?32:20;overlapped=Marshal.AllocHGlobal(bytes);
   Marshal.Copy(new byte[bytes],0,overlapped,bytes);Marshal.WriteIntPtr(overlapped,IntPtr.Size==8?24:16,signal);
   uint returned;bool done=DeviceIoControl(file,0x00090000,IntPtr.Zero,0,IntPtr.Zero,0,out returned,overlapped);
   int error=Marshal.GetLastWin32Error();if(done||error!=997)throw new Exception("FSCTL_REQUEST_OPLOCK_LEVEL_1 "+error);
   Console.WriteLine("READY");Console.Out.Flush();
   Task<string> release=Task.Run(()=>Console.ReadLine());DateTime deadline=DateTime.UtcNow.AddSeconds(65);bool broken=false;
   while(!release.IsCompleted&&DateTime.UtcNow<deadline){
    if(!broken&&WaitForSingleObject(signal,100)==0){broken=true;Console.WriteLine("BREAK");Console.Out.Flush();}
    else if(broken)System.Threading.Thread.Sleep(50);
   }
   if(!release.IsCompleted)throw new Exception("Owned oplock release deadline expired");
  } finally {
   if(file!=new IntPtr(-1)){CancelIoEx(file,overlapped);if(signal!=IntPtr.Zero)WaitForSingleObject(signal,5000);CloseHandle(file);}
   if(signal!=IntPtr.Zero)CloseHandle(signal);if(overlapped!=IntPtr.Zero)Marshal.FreeHGlobal(overlapped);
  }
  Console.WriteLine("RELEASED");Console.Out.Flush();
 }
}
'@
[OwnedSourceOplock]::Run($resolvedSource)
