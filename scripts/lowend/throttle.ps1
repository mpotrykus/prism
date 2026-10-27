param(
  [Parameter(Mandatory)][int]$ProcessId,
  [Parameter(Mandatory)][int]$Cores,
  [Parameter(Mandatory)][int]$CpuRate
)

# A Windows Job Object hard cap is the only host-side way to slow a running qemu: the
# emulator has no clock-speed knob, and ncore alone just changes thread count, not speed.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PrismJob {
  [DllImport("kernel32.dll")] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr i, int l);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [StructLayout(LayoutKind.Explicit)] public struct CPU_RATE {
    [FieldOffset(0)] public uint ControlFlags;
    [FieldOffset(4)] public uint CpuRate;
  }
  public static void Cap(IntPtr process, uint rate) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    var info = new CPU_RATE { ControlFlags = 0x1 | 0x4, CpuRate = rate };
    IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(info));
    Marshal.StructureToPtr(info, p, false);
    if (!SetInformationJobObject(job, 15, p, Marshal.SizeOf(info))) throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, process)) throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
  }
}
"@

$proc = Get-Process -Id $ProcessId
$mask = [int64]0
for ($i = 0; $i -lt $Cores; $i++) { $mask = $mask -bor ([int64]1 -shl $i) }
$proc.ProcessorAffinity = [IntPtr]$mask
if ($CpuRate -lt 10000) { [PrismJob]::Cap($proc.Handle, [uint32]$CpuRate) }
Write-Output "throttle: pid=$ProcessId cores=$Cores rate=$($CpuRate/100)% of host"
