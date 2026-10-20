// Compiled as a Windows GUI executable: neither this process nor its WSL child
// allocates a console or asks Windows Terminal to host one.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;

internal static class WslDownloadsSupervisor
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits limits, uint size);
    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    private static string logPath;
    private static void Log(string message)
    {
        try
        {
            if (File.Exists(logPath) && new FileInfo(logPath).Length > 1024 * 1024)
            {
                File.Copy(logPath, logPath + ".previous", true);
                File.Delete(logPath);
            }
            File.AppendAllText(logPath, DateTimeOffset.Now.ToString("o") + " " + message + Environment.NewLine);
        }
        catch { /* A log failure must not shut down the service. */ }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length < 1 || args.Length > 2 || !Regex.IsMatch(args[0], @"^[\w.-]+$")) return 2;
        string distro = args[0];
        string directory = args.Length == 2 ? args[1] : null;
        if (directory != null && !Regex.IsMatch(directory, @"^/[\w./-]+$")) return 2;
        bool first;
        using (var singleton = new Mutex(true, @"Local\LocalPass.WSL.Downloads." + distro, out first))
        {
            if (!first) return 0;
            string runtime = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalPass", "WSL");
            Directory.CreateDirectory(runtime);
            logPath = Path.Combine(runtime, "keepalive.log");
            string command = directory == null ? "deploy_dir=\"$HOME/apps/localpass\"; " : "deploy_dir='" + directory + "'; ";
            command += "until docker info >/dev/null 2>&1; do sleep 5; done; docker compose --project-directory \"$deploy_dir\" -f \"$deploy_dir/compose.yaml\" up -d >/dev/null 2>&1 || exit 1; exec /bin/sleep infinity";
            Log("Windowless supervisor started for " + distro + ", Windows PID " + Process.GetCurrentProcess().Id + ".");
            while (true)
            {
                IntPtr job = IntPtr.Zero;
                try
                {
                    job = CreateJobObject(IntPtr.Zero, null);
                    var limits = new JobLimits();
                    limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits))))
                        throw new InvalidOperationException("Unable to create child process cleanup job.");
                    using (var child = new Process())
                    {
                        child.StartInfo = new ProcessStartInfo {
                            FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "wsl.exe"),
                            Arguments = "-d " + distro + " --exec /bin/sh -c \"" + command.Replace("\"", "\\\"") + "\"",
                            UseShellExecute = false, CreateNoWindow = true,
                            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
                        };
                        child.OutputDataReceived += delegate { };
                        child.ErrorDataReceived += delegate { };
                        child.Start();
                        if (!AssignProcessToJobObject(job, child.Handle))
                        {
                            child.Kill();
                            throw new InvalidOperationException("Unable to attach WSL process cleanup job.");
                        }
                        child.BeginOutputReadLine();
                        child.BeginErrorReadLine();
                        Log("WSL keepalive started, Windows PID " + child.Id + ".");
                        child.WaitForExit();
                        Log("WSL keepalive exited with 0x" + child.ExitCode.ToString("X8") + "; retrying in 15 seconds.");
                    }
                }
                catch (Exception error) { Log("Unable to keep WSL running: " + error.Message); }
                finally { if (job != IntPtr.Zero) CloseHandle(job); }
                Thread.Sleep(15000);
            }
        }
    }
}
