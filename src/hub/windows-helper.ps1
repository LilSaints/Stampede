param([int]$ClientPort = 0, [int]$ServerPort = 0, [int]$InspectPid = 0, [switch]$Serve)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class StampedeProcessProbe {
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", EntryPoint="Process32FirstW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", EntryPoint="Process32NextW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", EntryPoint="QueryFullProcessImageNameW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder image, ref int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint exitCode);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
        public uint size, usage, pid; public IntPtr defaultHeap; public uint moduleId, threads, parentPid;
        public int priority; public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string image;
    }
    public sealed class Identity {
        public int pid {get;set;} public int parentPid {get;set;} public string image {get;set;}
        public string startFileTime {get;set;} public string error {get;set;}
    }
    static Dictionary<int,ProcessEntry> Processes() {
        var result = new Dictionary<int,ProcessEntry>();
        IntPtr h = CreateToolhelp32Snapshot(2, 0);
        if (h == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var p = new ProcessEntry(); p.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            if (!Process32First(h, ref p)) throw new Win32Exception(Marshal.GetLastWin32Error());
            do { result[(int)p.pid] = p; } while (Process32Next(h, ref p));
        } finally { CloseHandle(h); }
        return result;
    }
    static Identity Identify(int pid, Dictionary<int,ProcessEntry> processes) {
        var id = new Identity {pid=pid}; ProcessEntry p;
        if (processes.TryGetValue(pid, out p)) {id.parentPid=(int)p.parentPid; id.image=p.image;}
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) {id.error="OpenProcess:"+Marshal.GetLastWin32Error(); return id;}
        try {
            long creation, exit, kernel, user;
            if (GetProcessTimes(h, out creation, out exit, out kernel, out user)) id.startFileTime=creation.ToString();
            else id.error="GetProcessTimes:"+Marshal.GetLastWin32Error();
            int length=32768; var image=new StringBuilder(length);
            if (QueryFullProcessImageName(h,0,image,ref length)) id.image=image.ToString();
        } finally {CloseHandle(h);}
        return id;
    }
    public static Identity Inspect(int pid) {return Identify(pid,Processes());}
    public static bool KillVerified(int pid, string expected) {
        var all=Processes(); var root=Identify(pid,all);
        if (root.startFileTime==null || root.startFileTime!=expected) return false;
        var victims=new List<Identity>(); victims.Add(root);
        for (int i=0;i<victims.Count;i++) {
            foreach (var pair in all) {
                if ((int)pair.Value.parentPid!=victims[i].pid || victims.Exists(v=>v.pid==pair.Key)) continue;
                var child=Identify(pair.Key,all);
                if (child.startFileTime!=null && long.Parse(child.startFileTime)>=long.Parse(victims[i].startFileTime)) victims.Add(child);
            }
        }
        // Hold and validate each exact instance before terminating it. A recycled
        // PID is never a substitute for the process recorded in the journal.
        victims.Reverse();
        foreach (var victim in victims) {
            IntPtr h=OpenProcess(0x1001,false,victim.pid);
            if (h==IntPtr.Zero) continue;
            try {
                long creation,exit,kernel,user;
                if (GetProcessTimes(h,out creation,out exit,out kernel,out user) && creation.ToString()==victim.startFileTime && exit==0) {
                    if (!TerminateProcess(h,1)) throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            } finally {CloseHandle(h);}
        }
        return true;
    }
    public static Identity[] Chain(int pid) {
        var all=Processes(); var result=new List<Identity>(); var seen=new HashSet<int>();
        while (pid>0 && seen.Add(pid) && result.Count<32) {
            var id=Identify(pid,all);
            if (result.Count>0 && id.startFileTime!=null && result[result.Count-1].startFileTime!=null &&
                long.Parse(id.startFileTime)>long.Parse(result[result.Count-1].startFileTime)) break;
            result.Add(id); pid=id.parentPid;
        }
        return result.ToArray();
    }
    static int Port(int raw) {return ((raw & 255)<<8) | ((raw>>8)&255);}
    public static int ClientPid(int clientPort,int serverPort) {
        int size=0; uint code=GetExtendedTcpTable(IntPtr.Zero,ref size,false,2,5,0);
        if (code!=122 && code!=0) throw new Win32Exception((int)code);
        for (int attempt=0;attempt<3;attempt++) {
            IntPtr buffer=Marshal.AllocHGlobal(size);
            try {
                code=GetExtendedTcpTable(buffer,ref size,false,2,5,0);
                if (code==122) continue;
                if (code!=0) throw new Win32Exception((int)code);
                int count=Marshal.ReadInt32(buffer);
                for(int i=0;i<count;i++) {
                    IntPtr row=IntPtr.Add(buffer,4+i*24);
                    if (Marshal.ReadInt32(row)==5 && Marshal.ReadInt32(row,4)==0x0100007f &&
                        Marshal.ReadInt32(row,12)==0x0100007f && Port(Marshal.ReadInt32(row,8))==clientPort &&
                        Port(Marshal.ReadInt32(row,16))==serverPort) return Marshal.ReadInt32(row,20);
                }
                throw new Exception("No established IPv4 loopback client row for exact connection tuple");
            } finally {Marshal.FreeHGlobal(buffer);}
        }
        throw new Exception("TCP table changed size repeatedly");
    }
}
'@

function Protect-StampedeState($Directory) {
    $root = [IO.Path]::GetFullPath($Directory)
    if ($root.TrimEnd('\') -eq [IO.Path]::GetPathRoot($root).TrimEnd('\') -or $root.TrimEnd('\') -eq $env:USERPROFILE.TrimEnd('\')) { throw 'Refusing broad state directory' }
    $rootInfo = [IO.DirectoryInfo]::new($root)
    $items = @($rootInfo) + @(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop)
    foreach ($item in $items) { if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "State directory contains a reparse point: $($item.FullName)" } }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($item in $items) {
        $isDirectory = $item -is [IO.DirectoryInfo]
        $acl = if ($isDirectory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
        $sddl = if ($item.FullName -eq $rootInfo.FullName) { "D:P(A;OICI;FA;;;$sid)" } else { 'D:AI' }
        $acl.SetSecurityDescriptorSddlForm($sddl, [Security.AccessControl.AccessControlSections]::Access)
        if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl) } else { $item.SetAccessControl($acl) }
    }
    foreach ($item in $items) {
        $acl = if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::GetAccessControl($item) } else { $item.GetAccessControl() }
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        $isRoot = $item.FullName -eq $rootInfo.FullName
        if ($acl.AreAccessRulesProtected -ne $isRoot -or $rules.Count -ne 1) { throw "DACL verification failed: $($item.FullName)" }
        foreach ($rule in $rules) {
            if ($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.IsInherited -eq $isRoot) { throw "Unexpected ACL entry: $($item.FullName)" }
            if ($item -is [IO.DirectoryInfo] -and $rule.InheritanceFlags -ne 'ContainerInherit, ObjectInherit') { throw "Unexpected inheritance flags: $($item.FullName)" }
        }
    }
    return @{verified=$true;count=$items.Count;sid=$sid}
}

function Invoke-Lookup($Request) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ($Request.protectState) {
            $result = @{acl=(Protect-StampedeState $Request.protectState)}
        } elseif ($Request.killIdentity) {
            $result = @{killed=[StampedeProcessProbe]::KillVerified([int]$Request.killIdentity.pid,[string]$Request.killIdentity.startFileTime)}
        } elseif ($Request.inspectPid) {
            $result = @{identity=[StampedeProcessProbe]::Inspect([int]$Request.inspectPid)}
        } else {
            $clientProcessId = [StampedeProcessProbe]::ClientPid([int]$Request.clientPort,[int]$Request.serverPort)
            $result = @{clientPid=$clientProcessId; chain=@([StampedeProcessProbe]::Chain($clientProcessId))}
        }
        $result.ok=$true
    } catch { $result=@{ok=$false; error=$_.Exception.Message} }
    $result.lookupMs=$watch.Elapsed.TotalMilliseconds
    $result | ConvertTo-Json -Compress -Depth 6
}

if ($Serve) {
    '{"ready":true}'
    while ($null -ne ($requestLine = [Console]::ReadLine())) {
        try { Invoke-Lookup ($requestLine | ConvertFrom-Json) }
        catch { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress }
    }
} else {
    Invoke-Lookup @{clientPort=$ClientPort;serverPort=$ServerPort;inspectPid=$InspectPid}
}
