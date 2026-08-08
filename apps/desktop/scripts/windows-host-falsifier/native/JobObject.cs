using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Enduragent.WindowsHostFalsifier
{
    internal sealed class JobOwnerSession : NativeSession
    {
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint CreateSuspended = 0x00000004;
        private const uint CreateNewProcessGroup = 0x00000200;
        private const uint CreateUnicodeEnvironment = 0x00000400;
        private const uint CreateNoWindow = 0x08000000;
        private const int WaitObject0 = 0;

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFO
        {
            internal int Cb;
            internal string Reserved;
            internal string Desktop;
            internal string Title;
            internal uint X;
            internal uint Y;
            internal uint XSize;
            internal uint YSize;
            internal uint XCountChars;
            internal uint YCountChars;
            internal uint FillAttribute;
            internal uint Flags;
            internal ushort ShowWindow;
            internal ushort Reserved2;
            internal IntPtr Reserved2Pointer;
            internal IntPtr StandardInput;
            internal IntPtr StandardOutput;
            internal IntPtr StandardError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            internal IntPtr Process;
            internal IntPtr Thread;
            internal uint ProcessId;
            internal uint ThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            internal long PerProcessUserTimeLimit;
            internal long PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSetSize;
            internal UIntPtr MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass;
            internal uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            internal ulong ReadOperationCount;
            internal ulong WriteOperationCount;
            internal ulong OtherOperationCount;
            internal ulong ReadTransferCount;
            internal ulong WriteTransferCount;
            internal ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            internal IO_COUNTERS IoInfo;
            internal UIntPtr ProcessMemoryLimit;
            internal UIntPtr JobMemoryLimit;
            internal UIntPtr PeakProcessMemoryUsed;
            internal UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            SafeFileHandle job,
            int informationClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeFileHandle process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(SafeFileHandle thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(SafeFileHandle process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsProcessInJob(
            SafeFileHandle process,
            SafeFileHandle job,
            out bool result);

        private SafeFileHandle job;
        private SafeFileHandle process;
        private SafeFileHandle primaryThread;
        private readonly int gracefulDeadlineMs;
        private readonly int forceDeadlineMs;
        private readonly int processId;
        private readonly string creationTimeSha256;
        private readonly bool insideOuterJob;
        private bool disposed;

        internal JobOwnerSession(
            string sessionId,
            string operationId,
            Dictionary<string, object> request)
            : base(sessionId, operationId)
        {
            Protocol.RequireExactKeys(
                request,
                new string[] { "executable", "args", "scenario", "deadlines" },
                "job-owner request");
            string executable = Protocol.RequireString(request, "executable", 1, 32767);
            string[] arguments = Protocol.RequireStringArray(request, "args", 32, 4096);
            string scenario = Protocol.RequireString(request, "scenario", 1, 32);
            HashSet<string> scenarios = new HashSet<string>(new string[] {
                "normal", "hung", "grandchild", "crash-before-ready", "crash-after-ready"
            }, StringComparer.Ordinal);
            if (!scenarios.Contains(scenario))
                throw new NativeFailure("PROTOCOL_ENUM", "job scenario is invalid");
            Dictionary<string, object> deadlines = Protocol.RequireObject(request, "deadlines");
            Protocol.RequireExactKeys(
                deadlines,
                new string[] { "startMs", "gracefulMs", "forceMs" },
                "job deadlines");
            Protocol.RequireInt(deadlines, "startMs", 1, 120000);
            gracefulDeadlineMs = Protocol.RequireInt(deadlines, "gracefulMs", 1, 120000);
            forceDeadlineMs = Protocol.RequireInt(deadlines, "forceMs", 1, 120000);

            bool outer;
            using (SafeFileHandle current = JobObjectProbe.OpenCurrentProcess())
            {
                if (!IsProcessInJob(current, null, out outer))
                    ThrowWin32("OUTER_JOB_QUERY_FAILED", "outer job membership query failed");
            }
            insideOuterJob = outer;

            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job.IsInvalid) ThrowWin32("JOB_CREATE_FAILED", "job object creation failed");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                ref limits,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            {
                ThrowWin32("JOB_LIMIT_FAILED", "kill-on-close job limit configuration failed");
            }

            STARTUPINFO startup = new STARTUPINFO { Cb = Marshal.SizeOf(typeof(STARTUPINFO)) };
            PROCESS_INFORMATION created;
            StringBuilder commandLine = new StringBuilder(BuildCommandLine(executable, arguments));
            if (!CreateProcessW(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CreateSuspended | CreateNewProcessGroup | CreateUnicodeEnvironment | CreateNoWindow,
                IntPtr.Zero,
                Path.GetDirectoryName(executable),
                ref startup,
                out created))
            {
                ThrowWin32("PROCESS_CREATE_FAILED", "suspended process creation failed");
            }

            process = new SafeFileHandle(created.Process, true);
            primaryThread = new SafeFileHandle(created.Thread, true);
            processId = checked((int)created.ProcessId);
            creationTimeSha256 = JobObjectProbe.CreationTimeSha256(process, processId);
            Emit(
                "created",
                Protocol.Object(
                    "pid", processId,
                    "creationTimeSha256", creationTimeSha256,
                    "suspended", true));
            if (!AssignProcessToJobObject(job, process))
            {
                int code = Marshal.GetLastWin32Error();
                TerminateProcess(process, 0xE001);
                throw new NativeFailure("JOB_ASSIGN_FAILED", "job assignment failed before process start", code);
            }

            Emit(
                "assigned",
                Protocol.Object(
                    "pid", processId,
                    "creationTimeSha256", creationTimeSha256,
                    "assignedBeforeResume", true));
            if (ResumeThread(primaryThread) == UInt32.MaxValue)
            {
                int code = Marshal.GetLastWin32Error();
                TerminateJobObject(job, 0xE002);
                throw new NativeFailure("PROCESS_RESUME_FAILED", "assigned process resume failed", code);
            }

            Emit(
                "resumed",
                Protocol.Object(
                    "pid", processId,
                    "creationTimeSha256", creationTimeSha256,
                    "assignedBeforeResume", true));
        }

        internal Dictionary<string, object> ReadyResult()
        {
            return Protocol.Object(
                "sessionId", SessionId,
                "state", "running",
                "pid", processId,
                "creationTimeSha256", creationTimeSha256,
                "assignedBeforeResume", true,
                "insideOuterJob", insideOuterJob);
        }

        internal override Dictionary<string, object> Control(string action)
        {
            if (action == "query") return Query();
            if (action == "graceful")
            {
                bool exited = WaitForSingleObject(process, (uint)gracefulDeadlineMs) == WaitObject0;
                return Protocol.Object(
                    "sessionId", SessionId,
                    "outcome", exited ? "exited" : "graceful-unsupported",
                    "identityMatches", JobObjectProbe.IdentityMatches(processId, creationTimeSha256));
            }

            if (action == "terminate")
            {
                if (!TerminateJobObject(job, 0xE003))
                    ThrowWin32("JOB_TERMINATE_FAILED", "job termination failed");
                bool exited = WaitForSingleObject(process, (uint)forceDeadlineMs) == WaitObject0;
                Emit("terminated", Protocol.Object("pid", processId, "exited", exited));
                return Protocol.Object(
                    "sessionId", SessionId,
                    "outcome", exited ? "terminated" : "termination-failed",
                    "identityMatches", JobObjectProbe.IdentityMatches(processId, creationTimeSha256));
            }

            if (action == "close")
            {
                Dispose();
                return Protocol.Object("sessionId", SessionId, "outcome", "closed");
            }

            throw new NativeFailure("SESSION_ACTION", "job owner action is invalid");
        }

        private Dictionary<string, object> Query()
        {
            bool identityMatches = JobObjectProbe.IdentityMatches(processId, creationTimeSha256);
            bool running = JobObjectProbe.IsRunning(process);
            bool assigned;
            if (!IsProcessInJob(process, job, out assigned))
                ThrowWin32("JOB_QUERY_FAILED", "job membership query failed");
            object[] tree = JobObjectProbe.QueryTree(job);
            Emit("tree", Protocol.Object("processes", tree));
            return Protocol.Object(
                "sessionId", SessionId,
                "running", running,
                "identityMatches", identityMatches,
                "assigned", assigned,
                "processes", tree);
        }

        public override void Dispose()
        {
            if (disposed) return;
            disposed = true;
            SafeFileHandle currentJob = job;
            job = null;
            if (currentJob != null) currentJob.Dispose();
            if (process != null)
            {
                WaitForSingleObject(process, (uint)forceDeadlineMs);
                process.Dispose();
                process = null;
            }
            if (primaryThread != null)
            {
                primaryThread.Dispose();
                primaryThread = null;
            }
        }

        private static string BuildCommandLine(string executable, string[] arguments)
        {
            StringBuilder result = new StringBuilder(QuoteArgument(executable));
            foreach (string argument in arguments)
            {
                result.Append(' ');
                result.Append(QuoteArgument(argument));
            }
            return result.ToString();
        }

        private static string QuoteArgument(string value)
        {
            if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
                return value;
            StringBuilder quoted = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    backslashes += 1;
                    continue;
                }
                if (character == '"')
                {
                    quoted.Append('\\', backslashes * 2 + 1);
                    quoted.Append('"');
                    backslashes = 0;
                    continue;
                }
                quoted.Append('\\', backslashes);
                backslashes = 0;
                quoted.Append(character);
            }
            quoted.Append('\\', backslashes * 2);
            quoted.Append('"');
            return quoted.ToString();
        }

        private static void ThrowWin32(string code, string message)
        {
            throw new NativeFailure(code, message, Marshal.GetLastWin32Error());
        }
    }

    internal static class JobObjectProbe
    {
        private const uint ProcessTerminate = 0x0001;
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const uint Synchronize = 0x00100000;
        private const int StillActive = 259;
        private const int JobObjectBasicProcessIdList = 3;
        private const int ErrorInvalidParameter = 87;
        private const int ErrorMoreData = 234;

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            internal uint Low;
            internal uint High;
        }

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern SafeFileHandle OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetProcessTimes(
            SafeFileHandle process,
            out FILETIME creationTime,
            out FILETIME exitTime,
            out FILETIME kernelTime,
            out FILETIME userTime);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(SafeFileHandle process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            SafeFileHandle job,
            int informationClass,
            IntPtr information,
            uint informationLength,
            out uint returnLength);

        internal static SafeFileHandle OpenCurrentProcess()
        {
            return new SafeFileHandle(GetCurrentProcess(), false);
        }

        internal static Dictionary<string, object> ProcessIdentity(Dictionary<string, object> request)
        {
            Protocol.RequireExactKeys(request, new string[] { "pid" }, "process-identity request");
            int pid = Protocol.RequireInt(request, "pid", 1, Int32.MaxValue);
            SafeFileHandle process = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, (uint)pid);
            if (process.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                process.Dispose();
                if (code != ErrorInvalidParameter)
                    throw new NativeFailure("PROCESS_OPEN_FAILED", "process identity could not be queried", code);
                return Protocol.Object(
                    "exists", false,
                    "pid", pid,
                    "creationTimeSha256", null,
                    "running", false,
                    "exitCode", null);
            }

            using (process)
            {
                uint exitCode;
                if (!GetExitCodeProcess(process, out exitCode))
                    ThrowWin32("PROCESS_QUERY_FAILED", "process state query failed");
                return Protocol.Object(
                    "exists", true,
                    "pid", pid,
                    "creationTimeSha256", CreationTimeSha256(process, pid),
                    "running", exitCode == StillActive,
                    "exitCode", exitCode == StillActive ? null : (object)(long)exitCode);
            }
        }

        internal static Dictionary<string, object> JobQuery(Dictionary<string, object> request)
        {
            Protocol.RequireExactKeys(request, new string[] { "pid", "creationTimeSha256" }, "job-query request");
            int pid = Protocol.RequireInt(request, "pid", 1, Int32.MaxValue);
            string expected = Protocol.RequireLowerHex64(request, "creationTimeSha256");
            SafeFileHandle process = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, (uint)pid);
            if (process.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                process.Dispose();
                if (code != ErrorInvalidParameter)
                    throw new NativeFailure("PROCESS_OPEN_FAILED", "process state could not be queried", code);
                return Protocol.Object(
                    "exists", false,
                    "identityMatches", false,
                    "running", false,
                    "exitCode", null);
            }

            using (process)
            {
                string actual = CreationTimeSha256(process, pid);
                uint exitCode;
                if (!GetExitCodeProcess(process, out exitCode))
                    ThrowWin32("PROCESS_QUERY_FAILED", "process state query failed");
                return Protocol.Object(
                    "exists", true,
                    "identityMatches", String.Equals(expected, actual, StringComparison.Ordinal),
                    "running", exitCode == StillActive,
                    "exitCode", exitCode == StillActive ? null : (object)(long)exitCode);
            }
        }

        internal static bool IdentityMatches(int pid, string expected)
        {
            SafeFileHandle process = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, (uint)pid);
            if (process.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                process.Dispose();
                if (code != ErrorInvalidParameter)
                    throw new NativeFailure("PROCESS_OPEN_FAILED", "process identity could not be verified", code);
                return false;
            }
            using (process)
            {
                return String.Equals(CreationTimeSha256(process, pid), expected, StringComparison.Ordinal);
            }
        }

        internal static string CreationTimeSha256(SafeFileHandle process, int pid)
        {
            FILETIME creation;
            FILETIME exit;
            FILETIME kernel;
            FILETIME user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
                ThrowWin32("PROCESS_TIME_FAILED", "process creation time is unavailable");
            ulong ticks = ((ulong)creation.High << 32) | creation.Low;
            return Protocol.HashFramed(
                "enduragent.windows-process-identity.v1",
                pid.ToString(CultureInfo.InvariantCulture),
                ticks.ToString(CultureInfo.InvariantCulture));
        }

        internal static bool IsRunning(SafeFileHandle process)
        {
            uint exitCode;
            if (!GetExitCodeProcess(process, out exitCode))
                ThrowWin32("PROCESS_QUERY_FAILED", "process state query failed");
            return exitCode == StillActive;
        }

        internal static object[] QueryTree(SafeFileHandle job)
        {
            int capacity = 32;
            while (capacity <= 1024)
            {
                int header = 8;
                int size = header + capacity * IntPtr.Size;
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    for (int index = 0; index < size; index += 1) Marshal.WriteByte(buffer, index, 0);
                    uint returned;
                    if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)size, out returned))
                    {
                        int count = Marshal.ReadInt32(buffer, 4);
                        if (count > capacity)
                        {
                            capacity *= 2;
                            continue;
                        }
                        List<object> result = new List<object>();
                        for (int index = 0; index < count; index += 1)
                        {
                            long rawPid = IntPtr.Size == 8
                                ? Marshal.ReadInt64(buffer, header + index * IntPtr.Size)
                                : Marshal.ReadInt32(buffer, header + index * IntPtr.Size);
                            if (rawPid <= 0 || rawPid > Int32.MaxValue) continue;
                            int pid = (int)rawPid;
                            SafeFileHandle process = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, (uint)pid);
                            if (process.IsInvalid)
                            {
                                int code = Marshal.GetLastWin32Error();
                                process.Dispose();
                                if (code != ErrorInvalidParameter)
                                    throw new NativeFailure("PROCESS_OPEN_FAILED", "job member identity could not be queried", code);
                                result.Add(Protocol.Object("pid", pid, "creationTimeSha256", null));
                            }
                            else
                            {
                                using (process)
                                {
                                    result.Add(Protocol.Object(
                                        "pid", pid,
                                        "creationTimeSha256", CreationTimeSha256(process, pid)));
                                }
                            }
                        }
                        return result.ToArray();
                    }
                    int queryCode = Marshal.GetLastWin32Error();
                    if (queryCode != ErrorMoreData)
                        throw new NativeFailure("JOB_QUERY_FAILED", "job process tree could not be queried", queryCode);
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
                capacity *= 2;
            }
            throw new NativeFailure("JOB_TREE_TOO_LARGE", "job process tree exceeds the bounded query limit");
        }

        private static void ThrowWin32(string code, string message)
        {
            throw new NativeFailure(code, message, Marshal.GetLastWin32Error());
        }
    }
}
