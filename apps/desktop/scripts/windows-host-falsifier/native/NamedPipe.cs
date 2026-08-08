using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Enduragent.WindowsHostFalsifier
{
    internal sealed class PipeIoDeadline
    {
        private readonly Stopwatch elapsed;
        private readonly int deadlineMs;

        internal PipeIoDeadline(int deadlineMs)
        {
            this.deadlineMs = deadlineMs;
            elapsed = Stopwatch.StartNew();
        }

        internal int RemainingMilliseconds()
        {
            long remaining = deadlineMs - elapsed.ElapsedMilliseconds;
            if (remaining <= 0)
            {
                throw new NativeFailure("PIPE_TIMEOUT", "named pipe operation timed out");
            }
            return (int)remaining;
        }
    }

    internal sealed class PipeOwnerSession : NativeSession
    {
        private const int StopCompletionDeadlineMs = 6000;
        private readonly string pipeName;
        private readonly byte[] capability;
        private readonly byte[] binding;
        private readonly int maximumFrameBytes;
        private readonly int connectDeadlineMs;
        private readonly int readDeadlineMs;
        private readonly string currentSid;
        private readonly Thread worker;
        private readonly NamedPipeProbe.OperationCancellation operationCancellation;
        private readonly object stateLock = new object();
        private SafeFileHandle pipe;
        private bool capabilityConsumed;
        private bool stopping;

        internal PipeOwnerSession(
            string sessionId,
            string operationId,
            Dictionary<string, object> request)
            : base(sessionId, operationId)
        {
            Protocol.RequireExactKeys(
                request,
                new string[] {
                    "pipeName", "capabilityHex", "bindingHex", "maxFrameBytes",
                    "connectDeadlineMs", "readDeadlineMs"
                },
                "pipe-owner request");
            pipeName = NamedPipeProbe.RequirePipeName(request);
            capability = Protocol.ParseHex(Protocol.RequireLowerHex64(request, "capabilityHex"));
            binding = Protocol.ParseHex(Protocol.RequireLowerHex64(request, "bindingHex"));
            maximumFrameBytes = Protocol.RequireInt(request, "maxFrameBytes", 256, 65536);
            connectDeadlineMs = Protocol.RequireInt(request, "connectDeadlineMs", 1, 120000);
            readDeadlineMs = Protocol.RequireInt(request, "readDeadlineMs", 1, 120000);
            currentSid = NamedPipeProbe.CurrentSid();
            pipe = NamedPipeProbe.CreateSecurePipe(pipeName, maximumFrameBytes, true);
            operationCancellation = new NamedPipeProbe.OperationCancellation();
            worker = new Thread(Run);
            worker.IsBackground = true;
            worker.Name = "EnduragentFalsifierPipeOwner";
        }

        internal void Start()
        {
            worker.Start();
        }

        internal Dictionary<string, object> ReadyResult()
        {
            return Protocol.Object(
                "sessionId", SessionId,
                "state", "ready",
                "ownerSidSha256", Protocol.Sha256(currentSid),
                "pipeNameSha256", Protocol.Sha256(pipeName));
        }

        private void Run()
        {
            Emit("ready", Protocol.Object("pipeNameSha256", Protocol.Sha256(pipeName)));
            while (true)
            {
                lock (stateLock)
                {
                    if (stopping) return;
                }

                try
                {
                    bool connected = NamedPipeProbe.Connect(
                        pipe,
                        connectDeadlineMs,
                        operationCancellation);
                    if (!connected)
                    {
                        continue;
                    }

                    PipeIoDeadline ioDeadline = new PipeIoDeadline(readDeadlineMs);
                    byte[] payload = NamedPipeProbe.ReadFrame(
                        pipe,
                        maximumFrameBytes,
                        ioDeadline,
                        operationCancellation);
                    string clientSid = NamedPipeProbe.ImpersonatedClientSid(pipe);
                    Dictionary<string, object> frame = NamedPipeProbe.ParseClientFrame(payload);
                    string role = Protocol.RequireString(frame, "role", 1, 16);
                    string frameBinding = Protocol.RequireLowerHex64(frame, "bindingHex");
                    string frameCapability = Protocol.RequireLowerHex64(frame, "capabilityHex");
                    string decision = "reserved";
                    string reason = "ORDINARY_OR_UNAUTHORIZED";
                    bool offerCanConsumeCapability = false;
                    if (!String.Equals(clientSid, currentSid, StringComparison.Ordinal))
                    {
                        decision = "refused";
                        reason = "CLIENT_SID_MISMATCH";
                    }
                    else if (!Protocol.FixedTimeEquals(binding, Protocol.ParseHex(frameBinding)))
                    {
                        decision = "collision-refused";
                        reason = "BINDING_COLLISION";
                    }
                    else if (role == "successor" &&
                        Protocol.FixedTimeEquals(capability, Protocol.ParseHex(frameCapability)))
                    {
                        lock (stateLock)
                        {
                            if (!capabilityConsumed)
                            {
                                decision = "designated";
                                reason = "CAPABILITY_AVAILABLE";
                                offerCanConsumeCapability = true;
                            }
                            else
                            {
                                reason = "CAPABILITY_ALREADY_CONSUMED";
                            }
                        }
                    }

                    byte[] offerBytes = NamedPipeProbe.SerializeOfferFrame(
                        decision,
                        NamedPipeProbe.FreshChallengeHex());
                    string offerSha256 = Protocol.Sha256(offerBytes);
                    NamedPipeProbe.WriteFrame(
                        pipe,
                        offerBytes,
                        maximumFrameBytes,
                        ioDeadline,
                        operationCancellation);
                    NamedPipeProbe.ValidateAcknowledgment(
                        NamedPipeProbe.ReadFrame(
                            pipe,
                            maximumFrameBytes,
                            ioDeadline,
                            operationCancellation),
                        "offer-ack",
                        "offerSha256",
                        offerSha256);

                    lock (stateLock)
                    {
                        if (stopping)
                        {
                            throw new NativeFailure("SESSION_STOPPING", "named pipe owner is stopping");
                        }
                        if (offerCanConsumeCapability)
                        {
                            if (!capabilityConsumed)
                            {
                                capabilityConsumed = true;
                                decision = "designated";
                                reason = "CAPABILITY_CONSUMED";
                            }
                            else
                            {
                                decision = "reserved";
                                reason = "CAPABILITY_ALREADY_CONSUMED";
                            }
                        }
                    }

                    byte[] receiptBytes = NamedPipeProbe.SerializeCommitReceipt(
                        decision,
                        offerSha256,
                        NamedPipeProbe.FreshChallengeHex());
                    NamedPipeProbe.WriteFrame(
                        pipe,
                        receiptBytes,
                        maximumFrameBytes,
                        ioDeadline,
                        operationCancellation);
                    NamedPipeProbe.ValidateAcknowledgment(
                        NamedPipeProbe.ReadFrame(
                            pipe,
                            maximumFrameBytes,
                            ioDeadline,
                            operationCancellation),
                        "commit-ack",
                        "receiptSha256",
                        Protocol.Sha256(receiptBytes));
                    Emit(
                        "client-decision",
                        Protocol.Object(
                            "decision", decision,
                            "reasonCode", reason,
                            "clientSidSha256", Protocol.Sha256(clientSid)));
                }
                catch (NativeFailure failure)
                {
                    bool expectedStopFailure;
                    lock (stateLock)
                    {
                        expectedStopFailure = stopping &&
                            NamedPipeProbe.IsExpectedStopFailure(failure);
                    }
                    if (expectedStopFailure) return;
                    Emit(
                        "client-error",
                        Protocol.Object(
                            "code", failure.Code,
                            "win32Code", failure.NativeCode.HasValue ? (object)failure.NativeCode.Value : null));
                }
                finally
                {
                    if (pipe != null && !pipe.IsInvalid && !pipe.IsClosed)
                    {
                        NamedPipeProbe.Disconnect(pipe);
                    }
                }
            }
        }

        internal override Dictionary<string, object> Control(string action)
        {
            if (action == "query")
            {
                lock (stateLock)
                {
                    return Protocol.Object(
                        "sessionId", SessionId,
                        "state", stopping ? "stopping" : "ready",
                        "capabilityConsumed", capabilityConsumed);
                }
            }

            if (action != "close")
            {
                throw new NativeFailure("SESSION_ACTION", "pipe owner supports only query or close");
            }

            Dispose();
            return Protocol.Object("sessionId", SessionId, "state", "closed");
        }

        public override void Dispose()
        {
            lock (stateLock)
            {
                stopping = true;
            }

            operationCancellation.Stop();
            if (Thread.CurrentThread == worker)
            {
                Environment.FailFast("named pipe owner cannot dispose its own worker");
            }
            if (worker.IsAlive && !worker.Join(StopCompletionDeadlineMs))
            {
                Environment.FailFast("named pipe owner did not stop within its cancellation deadline");
            }

            SafeFileHandle current;
            lock (stateLock)
            {
                current = pipe;
                pipe = null;
            }
            if (current != null)
            {
                current.Dispose();
            }
        }
    }

    internal sealed class PipeForeignSession : NativeSession
    {
        private SafeFileHandle pipe;

        internal PipeForeignSession(
            string sessionId,
            string operationId,
            Dictionary<string, object> request)
            : base(sessionId, operationId)
        {
            Protocol.RequireExactKeys(
                request,
                new string[] { "pipeName", "maxFrameBytes" },
                "pipe-foreign-precreate request");
            string name = NamedPipeProbe.RequirePipeName(request);
            int maximumFrameBytes = Protocol.RequireInt(request, "maxFrameBytes", 256, 65536);
            pipe = NamedPipeProbe.CreateSecurePipe(name, maximumFrameBytes, true);
        }

        internal Dictionary<string, object> ReadyResult()
        {
            return Protocol.Object("sessionId", SessionId, "state", "ready");
        }

        internal override Dictionary<string, object> Control(string action)
        {
            if (action == "query")
            {
                return Protocol.Object("sessionId", SessionId, "state", pipe == null ? "closed" : "ready");
            }

            if (action != "close")
            {
                throw new NativeFailure("SESSION_ACTION", "foreign pipe supports only query or close");
            }

            Dispose();
            return Protocol.Object("sessionId", SessionId, "state", "closed");
        }

        public override void Dispose()
        {
            SafeFileHandle current = pipe;
            pipe = null;
            if (current != null) current.Dispose();
        }
    }

    internal static class NamedPipeProbe
    {
        private const uint PipeAccessDuplex = 0x00000003;
        private const uint FileFlagFirstPipeInstance = 0x00080000;
        private const uint FileFlagOverlapped = 0x40000000;
        private const uint PipeTypeByte = 0x00000000;
        private const uint PipeReadModeByte = 0x00000000;
        private const uint PipeWait = 0x00000000;
        private const uint PipeRejectRemoteClients = 0x00000008;
        private const uint GenericRead = 0x80000000;
        private const uint GenericWrite = 0x40000000;
        private const uint OpenExisting = 3;
        private const int ErrorIoPending = 997;
        private const int ErrorIoIncomplete = 996;
        private const int ErrorOperationAborted = 995;
        private const int ErrorPipeConnected = 535;
        private const int ErrorBrokenPipe = 109;
        private const int WaitObject0 = 0;
        private const int WaitTimeout = 258;
        private const uint CancellationCompletionDeadlineMs = 5000;
        private const uint SecurityDescriptorRevision = 1;

        private static readonly Regex PipeNamePattern = new Regex(
            @"^\\\\\.\\pipe\\Enduragent-upgrade-v1-[a-f0-9]{64}$",
            RegexOptions.CultureInvariant);
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static readonly JavaScriptSerializer Json = CreateSerializer();

        internal sealed class OperationCancellation
        {
            private readonly object stateLock = new object();
            private bool stopping;
            private IntPtr activeFile;
            private IntPtr activeOverlapped;

            internal bool Start(
                IntPtr file,
                IntPtr overlapped,
                OverlappedOperation operation,
                out int error)
            {
                lock (stateLock)
                {
                    if (stopping)
                    {
                        throw new NativeFailure("SESSION_STOPPING", "named pipe owner is stopping");
                    }
                    if (activeOverlapped != IntPtr.Zero)
                    {
                        Environment.FailFast("named pipe owner registered concurrent I/O");
                    }
                    activeFile = file;
                    activeOverlapped = overlapped;
                    try
                    {
                        bool completed = operation(file, overlapped);
                        error = completed ? 0 : Marshal.GetLastWin32Error();
                        return completed;
                    }
                    catch
                    {
                        Environment.FailFast("named pipe operation failed during registered initiation");
                        throw;
                    }
                }
            }

            internal void Complete(IntPtr overlapped)
            {
                lock (stateLock)
                {
                    if (activeOverlapped != overlapped)
                    {
                        Environment.FailFast("named pipe owner completed an unregistered I/O operation");
                    }
                    activeFile = IntPtr.Zero;
                    activeOverlapped = IntPtr.Zero;
                }
            }

            internal void Stop()
            {
                lock (stateLock)
                {
                    stopping = true;
                    if (activeOverlapped != IntPtr.Zero)
                    {
                        CancelIoEx(activeFile, activeOverlapped);
                    }
                }
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            internal int Length;
            internal IntPtr SecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)]
            internal bool InheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct OVERLAPPED
        {
            internal IntPtr Internal;
            internal IntPtr InternalHigh;
            internal uint Offset;
            internal uint OffsetHigh;
            internal IntPtr Event;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateNamedPipeW(
            string name,
            uint openMode,
            uint pipeMode,
            uint maximumInstances,
            uint outputBufferSize,
            uint inputBufferSize,
            uint defaultTimeout,
            ref SECURITY_ATTRIBUTES securityAttributes);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConnectNamedPipe(IntPtr pipe, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DisconnectNamedPipe(SafeFileHandle pipe);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WaitNamedPipeW(string name, uint timeout);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(
            IntPtr file,
            IntPtr buffer,
            uint bytesToRead,
            IntPtr bytesRead,
            IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WriteFile(
            IntPtr file,
            IntPtr buffer,
            uint bytesToWrite,
            IntPtr bytesWritten,
            IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateEventW(
            IntPtr eventAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool manualReset,
            [MarshalAs(UnmanagedType.Bool)] bool initialState,
            string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetOverlappedResult(
            IntPtr file,
            IntPtr overlapped,
            out uint transferred,
            [MarshalAs(UnmanagedType.Bool)] bool wait);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CancelIoEx(IntPtr file, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ImpersonateNamedPipeClient(SafeFileHandle pipe);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool RevertToSelf();

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string stringSecurityDescriptor,
            uint stringSdRevision,
            out IntPtr securityDescriptor,
            out uint securityDescriptorSize);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 65536;
            serializer.RecursionLimit = 8;
            return serializer;
        }

        internal static string RequirePipeName(Dictionary<string, object> request)
        {
            string name = Protocol.RequireString(request, "pipeName", 95, 95);
            if (!PipeNamePattern.IsMatch(name))
            {
                throw new NativeFailure("PIPE_NAME", "pipe name does not match the frozen grammar");
            }

            return name;
        }

        internal static string CurrentSid()
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query))
            {
                if (identity.User == null)
                {
                    throw new NativeFailure("CURRENT_SID_UNAVAILABLE", "current user SID is unavailable");
                }

                return identity.User.Value;
            }
        }

        internal static SafeFileHandle CreateSecurePipe(string name, int bufferSize, bool firstInstance)
        {
            string sddl = "D:P(A;;GA;;;" + CurrentSid() + ")(A;;GA;;;SY)";
            IntPtr descriptor;
            uint descriptorSize;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl,
                SecurityDescriptorRevision,
                out descriptor,
                out descriptorSize))
            {
                ThrowWin32("PIPE_SECURITY", "pipe security descriptor creation failed");
            }

            try
            {
                SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES
                {
                    Length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
                    SecurityDescriptor = descriptor,
                    InheritHandle = false
                };
                uint openMode = PipeAccessDuplex | FileFlagOverlapped;
                if (firstInstance) openMode |= FileFlagFirstPipeInstance;
                SafeFileHandle pipe = CreateNamedPipeW(
                    name,
                    openMode,
                    PipeTypeByte | PipeReadModeByte | PipeWait | PipeRejectRemoteClients,
                    1,
                    (uint)bufferSize,
                    (uint)bufferSize,
                    0,
                    ref attributes);
                if (pipe.IsInvalid)
                {
                    int code = Marshal.GetLastWin32Error();
                    pipe.Dispose();
                    throw new NativeFailure("PIPE_CREATE_FAILED", "exclusive named pipe creation failed", code);
                }

                return pipe;
            }
            finally
            {
                LocalFree(descriptor);
            }
        }

        internal static bool Connect(
            SafeFileHandle pipe,
            int deadlineMs,
            OperationCancellation cancellation)
        {
            return RunOverlapped(
                pipe,
                delegate(IntPtr file, IntPtr overlapped)
                {
                    return ConnectNamedPipe(file, overlapped);
                },
                deadlineMs,
                "PIPE_CONNECT_FAILED",
                true,
                true,
                cancellation) >= 0;
        }

        internal static void Disconnect(SafeFileHandle pipe)
        {
            if (!DisconnectNamedPipe(pipe))
            {
                int code = Marshal.GetLastWin32Error();
                if (code != ErrorBrokenPipe) return;
            }
        }

        internal static string ImpersonatedClientSid(SafeFileHandle pipe)
        {
            if (!ImpersonateNamedPipeClient(pipe))
            {
                ThrowWin32("PIPE_CLIENT_IDENTITY", "named pipe client impersonation failed");
            }

            try
            {
                using (WindowsIdentity identity = WindowsIdentity.GetCurrent(true))
                {
                    if (identity == null || identity.User == null)
                    {
                        throw new NativeFailure("PIPE_CLIENT_IDENTITY", "named pipe client SID is unavailable");
                    }

                    return identity.User.Value;
                }
            }
            finally
            {
                if (!RevertToSelf())
                {
                    Environment.FailFast("named pipe client impersonation could not be reverted");
                }
            }
        }

        internal static bool IsExpectedStopFailure(NativeFailure failure)
        {
            if (failure.Code == "SESSION_STOPPING") return true;
            if (!failure.NativeCode.HasValue || failure.NativeCode.Value != ErrorOperationAborted)
                return false;
            return failure.Code == "PIPE_CONNECT_FAILED" ||
                failure.Code == "PIPE_READ_FAILED" ||
                failure.Code == "PIPE_WRITE_FAILED";
        }

        internal static byte[] ReadFrame(
            SafeFileHandle pipe,
            int maximumBytes,
            PipeIoDeadline deadline,
            OperationCancellation cancellation)
        {
            byte[] header = ReadExact(pipe, 4, deadline, cancellation);
            int length = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
            if (length <= 0 || length > maximumBytes)
            {
                throw new NativeFailure("PIPE_FRAME_SIZE", "named pipe frame length is invalid");
            }

            return ReadExact(pipe, length, deadline, cancellation);
        }

        internal static void WriteFrame(
            SafeFileHandle pipe,
            byte[] payload,
            int maximumBytes,
            PipeIoDeadline deadline,
            OperationCancellation cancellation)
        {
            if (payload.Length <= 0 || payload.Length > maximumBytes)
            {
                throw new NativeFailure("PIPE_FRAME_SIZE", "named pipe response exceeds the frame limit");
            }

            byte[] framed = new byte[payload.Length + 4];
            framed[0] = (byte)(payload.Length >> 24);
            framed[1] = (byte)(payload.Length >> 16);
            framed[2] = (byte)(payload.Length >> 8);
            framed[3] = (byte)payload.Length;
            Buffer.BlockCopy(payload, 0, framed, 4, payload.Length);
            int offset = 0;
            while (offset < framed.Length)
            {
                byte[] remaining = new byte[framed.Length - offset];
                Buffer.BlockCopy(framed, offset, remaining, 0, remaining.Length);
                GCHandle pinned = GCHandle.Alloc(remaining, GCHandleType.Pinned);
                int transferred;
                try
                {
                    transferred = RunOverlapped(
                        pipe,
                        delegate(IntPtr file, IntPtr overlapped)
                        {
                            return WriteFile(
                                file,
                                pinned.AddrOfPinnedObject(),
                                (uint)remaining.Length,
                                IntPtr.Zero,
                                overlapped);
                        },
                        deadline.RemainingMilliseconds(),
                        "PIPE_WRITE_FAILED",
                        false,
                        false,
                        cancellation);
                }
                finally
                {
                    pinned.Free();
                }
                if (transferred <= 0) throw new NativeFailure("PIPE_WRITE_SHORT", "named pipe write made no progress");
                offset += transferred;
            }
        }

        private static byte[] ReadExact(
            SafeFileHandle pipe,
            int length,
            PipeIoDeadline deadline,
            OperationCancellation cancellation)
        {
            byte[] result = new byte[length];
            int offset = 0;
            while (offset < length)
            {
                byte[] chunk = new byte[length - offset];
                GCHandle pinned = GCHandle.Alloc(chunk, GCHandleType.Pinned);
                int transferred;
                try
                {
                    transferred = RunOverlapped(
                        pipe,
                        delegate(IntPtr file, IntPtr overlapped)
                        {
                            return ReadFile(
                                file,
                                pinned.AddrOfPinnedObject(),
                                (uint)chunk.Length,
                                IntPtr.Zero,
                                overlapped);
                        },
                        deadline.RemainingMilliseconds(),
                        "PIPE_READ_FAILED",
                        false,
                        false,
                        cancellation);
                }
                finally
                {
                    pinned.Free();
                }
                if (transferred <= 0) throw new NativeFailure("PIPE_READ_SHORT", "named pipe read ended early");
                Buffer.BlockCopy(chunk, 0, result, offset, transferred);
                offset += transferred;
            }

            return result;
        }

        internal delegate bool OverlappedOperation(IntPtr file, IntPtr overlapped);

        private static int RunOverlapped(
            SafeFileHandle file,
            OverlappedOperation operation,
            int deadlineMs,
            string failureCode,
            bool timeoutIsIdle,
            bool pipeConnectedIsSuccess,
            OperationCancellation cancellation)
        {
            IntPtr eventHandle = CreateEventW(IntPtr.Zero, true, false, null);
            if (eventHandle == IntPtr.Zero) ThrowWin32(failureCode, "overlapped event creation failed");
            IntPtr overlappedPointer = IntPtr.Zero;
            bool fileReferenceAdded = false;
            bool operationRegistered = false;
            bool operationStarted = false;
            bool operationTerminal = false;
            try
            {
                overlappedPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(OVERLAPPED)));
                Marshal.StructureToPtr(new OVERLAPPED { Event = eventHandle }, overlappedPointer, false);
                file.DangerousAddRef(ref fileReferenceAdded);
                IntPtr fileHandle = file.DangerousGetHandle();
                int error;
                bool completed;
                if (cancellation == null)
                {
                    try
                    {
                        completed = operation(fileHandle, overlappedPointer);
                        error = completed ? 0 : Marshal.GetLastWin32Error();
                        operationStarted = true;
                    }
                    catch
                    {
                        Environment.FailFast("named pipe operation failed during initiation");
                        throw;
                    }
                }
                else
                {
                    completed = cancellation.Start(
                        fileHandle,
                        overlappedPointer,
                        operation,
                        out error);
                    operationRegistered = true;
                    operationStarted = true;
                }
                if (completed)
                {
                    if (pipeConnectedIsSuccess)
                    {
                        operationTerminal = true;
                        return 0;
                    }
                    uint synchronousTransferred;
                    if (!GetOverlappedResult(
                        fileHandle,
                        overlappedPointer,
                        out synchronousTransferred,
                        false))
                    {
                        int completionError = Marshal.GetLastWin32Error();
                        if (completionError == ErrorIoIncomplete)
                        {
                            Environment.FailFast("synchronous named pipe I/O was not terminal");
                        }
                        operationTerminal = true;
                        throw new NativeFailure(
                            failureCode,
                            "overlapped pipe completion failed",
                            completionError);
                    }
                    operationTerminal = true;
                    return (int)synchronousTransferred;
                }
                if (pipeConnectedIsSuccess && error == ErrorPipeConnected)
                {
                    operationTerminal = true;
                    return 0;
                }
                if (error != ErrorIoPending)
                {
                    operationTerminal = true;
                    throw new NativeFailure(failureCode, "overlapped pipe operation failed", error);
                }

                uint wait = WaitForSingleObject(eventHandle, (uint)deadlineMs);
                if (wait == WaitTimeout)
                {
                    CancelAndAwaitCompletion(fileHandle, overlappedPointer, eventHandle);
                    operationTerminal = true;
                    if (timeoutIsIdle) return -1;
                    throw new NativeFailure("PIPE_TIMEOUT", "named pipe operation timed out");
                }

                if (wait != WaitObject0)
                {
                    int waitError = Marshal.GetLastWin32Error();
                    CancelAndAwaitCompletion(fileHandle, overlappedPointer, eventHandle);
                    operationTerminal = true;
                    throw new NativeFailure(failureCode, "overlapped pipe wait failed", waitError);
                }

                uint transferred;
                if (!GetOverlappedResult(fileHandle, overlappedPointer, out transferred, false))
                {
                    int completionError = Marshal.GetLastWin32Error();
                    if (completionError == ErrorIoIncomplete)
                    {
                        Environment.FailFast("signaled named pipe I/O was not terminal");
                    }
                    operationTerminal = true;
                    throw new NativeFailure(
                        failureCode,
                        "overlapped pipe completion failed",
                        completionError);
                }

                operationTerminal = true;
                return (int)transferred;
            }
            finally
            {
                if (operationStarted && !operationTerminal)
                {
                    Environment.FailFast("named pipe I/O escaped before completion");
                }
                if (operationRegistered)
                {
                    cancellation.Complete(overlappedPointer);
                }
                if (fileReferenceAdded) file.DangerousRelease();
                if (overlappedPointer != IntPtr.Zero) Marshal.FreeHGlobal(overlappedPointer);
                CloseHandle(eventHandle);
            }
        }

        private static void CancelAndAwaitCompletion(
            IntPtr file,
            IntPtr overlapped,
            IntPtr eventHandle)
        {
            CancelIoEx(file, overlapped);
            uint cancellationWait = WaitForSingleObject(eventHandle, CancellationCompletionDeadlineMs);
            if (cancellationWait != WaitObject0)
            {
                Environment.FailFast("named pipe cancellation did not reach a terminal state");
            }

            uint ignored;
            if (!GetOverlappedResult(file, overlapped, out ignored, false) &&
                Marshal.GetLastWin32Error() == ErrorIoIncomplete)
            {
                Environment.FailFast("named pipe cancellation completion was not observable");
            }
        }

        internal static Dictionary<string, object> ParseClientFrame(byte[] payload)
        {
            Dictionary<string, object> frame;
            try
            {
                frame = Json.DeserializeObject(StrictUtf8.GetString(payload)) as Dictionary<string, object>;
            }
            catch
            {
                throw new NativeFailure("PIPE_FRAME_JSON", "named pipe frame is invalid");
            }

            if (frame == null) throw new NativeFailure("PIPE_FRAME_JSON", "named pipe frame must be an object");
            Protocol.RequireExactKeys(
                frame,
                new string[] { "protocolVersion", "role", "bindingHex", "capabilityHex" },
                "named pipe frame");
            if (Protocol.RequireInt(frame, "protocolVersion", 1, 1) != Protocol.Version)
            {
                throw new NativeFailure("PIPE_FRAME_VERSION", "named pipe frame version is invalid");
            }

            string role = Protocol.RequireString(frame, "role", 1, 16);
            if (role != "ordinary" && role != "successor")
            {
                throw new NativeFailure("PIPE_FRAME_ROLE", "named pipe role is invalid");
            }

            Protocol.RequireLowerHex64(frame, "bindingHex");
            Protocol.RequireLowerHex64(frame, "capabilityHex");
            return frame;
        }

        internal static string FreshChallengeHex()
        {
            byte[] challenge = new byte[32];
            try
            {
                using (RandomNumberGenerator generator = RandomNumberGenerator.Create())
                {
                    generator.GetBytes(challenge);
                }
            }
            catch
            {
                throw new NativeFailure("PIPE_CHALLENGE", "named pipe challenge generation failed");
            }
            return Protocol.Hex(challenge);
        }

        internal static byte[] SerializeOfferFrame(string decision, string challengeHex)
        {
            return StrictUtf8.GetBytes(Json.Serialize(Protocol.Object(
                "protocolVersion", Protocol.Version,
                "phase", "offer",
                "decision", decision,
                "challengeHex", challengeHex)));
        }

        internal static Dictionary<string, object> ParseOfferFrame(byte[] payload)
        {
            Dictionary<string, object> offer = ParsePipeObject(
                payload,
                "PIPE_OFFER_JSON",
                "named pipe offer");
            Protocol.RequireExactKeys(
                offer,
                new string[] { "protocolVersion", "phase", "decision", "challengeHex" },
                "named pipe offer");
            ValidateProtocolVersion(offer, "PIPE_OFFER_VERSION", "named pipe offer version is invalid");
            if (Protocol.RequireString(offer, "phase", 1, 16) != "offer")
                throw new NativeFailure("PIPE_OFFER_PHASE", "named pipe offer phase is invalid");
            ValidateDecision(Protocol.RequireString(offer, "decision", 1, 32), "PIPE_OFFER_DECISION");
            Protocol.RequireLowerHex64(offer, "challengeHex");
            return offer;
        }

        internal static byte[] SerializeAcknowledgment(
            string phase,
            string digestKey,
            string digest)
        {
            return StrictUtf8.GetBytes(Json.Serialize(Protocol.Object(
                "protocolVersion", Protocol.Version,
                "phase", phase,
                digestKey, digest)));
        }

        internal static void ValidateAcknowledgment(
            byte[] payload,
            string expectedPhase,
            string digestKey,
            string expectedDigest)
        {
            Dictionary<string, object> acknowledgment = ParsePipeObject(
                payload,
                "PIPE_ACK_JSON",
                "named pipe acknowledgment");
            Protocol.RequireExactKeys(
                acknowledgment,
                new string[] { "protocolVersion", "phase", digestKey },
                "named pipe acknowledgment");
            ValidateProtocolVersion(
                acknowledgment,
                "PIPE_ACK_VERSION",
                "named pipe acknowledgment version is invalid");
            if (Protocol.RequireString(acknowledgment, "phase", 1, 16) != expectedPhase)
                throw new NativeFailure("PIPE_ACK_PHASE", "named pipe acknowledgment phase is invalid");
            string actualDigest = Protocol.RequireLowerHex64(acknowledgment, digestKey);
            if (!Protocol.FixedTimeEquals(
                Protocol.ParseHex(actualDigest),
                Protocol.ParseHex(expectedDigest)))
            {
                throw new NativeFailure("PIPE_ACK_DIGEST", "named pipe acknowledgment digest is invalid");
            }
        }

        internal static byte[] SerializeCommitReceipt(
            string decision,
            string offerSha256,
            string challengeHex)
        {
            return StrictUtf8.GetBytes(Json.Serialize(Protocol.Object(
                "protocolVersion", Protocol.Version,
                "phase", "commit",
                "decision", decision,
                "offerSha256", offerSha256,
                "challengeHex", challengeHex)));
        }

        internal static Dictionary<string, object> ParseCommitReceipt(
            byte[] payload,
            string expectedOfferSha256,
            string offeredDecision)
        {
            Dictionary<string, object> receipt = ParsePipeObject(
                payload,
                "PIPE_RECEIPT_JSON",
                "named pipe commit receipt");
            Protocol.RequireExactKeys(
                receipt,
                new string[] {
                    "protocolVersion", "phase", "decision", "offerSha256", "challengeHex"
                },
                "named pipe commit receipt");
            ValidateProtocolVersion(
                receipt,
                "PIPE_RECEIPT_VERSION",
                "named pipe commit receipt version is invalid");
            if (Protocol.RequireString(receipt, "phase", 1, 16) != "commit")
                throw new NativeFailure("PIPE_RECEIPT_PHASE", "named pipe commit receipt phase is invalid");
            string decision = Protocol.RequireString(receipt, "decision", 1, 32);
            ValidateDecision(decision, "PIPE_RECEIPT_DECISION");
            string actualOfferSha256 = Protocol.RequireLowerHex64(receipt, "offerSha256");
            Protocol.RequireLowerHex64(receipt, "challengeHex");
            if (!Protocol.FixedTimeEquals(
                Protocol.ParseHex(actualOfferSha256),
                Protocol.ParseHex(expectedOfferSha256)))
            {
                throw new NativeFailure("PIPE_RECEIPT_OFFER", "named pipe commit receipt offer is invalid");
            }
            if (offeredDecision == "designated")
            {
                if (decision != "designated" && decision != "reserved")
                    throw new NativeFailure("PIPE_RECEIPT_DECISION", "named pipe commit decision transition is invalid");
            }
            else if (decision != offeredDecision)
            {
                throw new NativeFailure("PIPE_RECEIPT_DECISION", "named pipe commit decision transition is invalid");
            }
            return receipt;
        }

        private static Dictionary<string, object> ParsePipeObject(
            byte[] payload,
            string failureCode,
            string label)
        {
            Dictionary<string, object> value;
            try
            {
                value = Json.DeserializeObject(StrictUtf8.GetString(payload)) as Dictionary<string, object>;
            }
            catch
            {
                throw new NativeFailure(failureCode, label + " is invalid");
            }
            if (value == null) throw new NativeFailure(failureCode, label + " must be an object");
            return value;
        }

        private static void ValidateProtocolVersion(
            Dictionary<string, object> value,
            string failureCode,
            string message)
        {
            if (Protocol.RequireInt(value, "protocolVersion", 1, 1) != Protocol.Version)
                throw new NativeFailure(failureCode, message);
        }

        private static void ValidateDecision(string decision, string failureCode)
        {
            if (decision != "designated" &&
                decision != "reserved" &&
                decision != "collision-refused" &&
                decision != "refused")
            {
                throw new NativeFailure(failureCode, "named pipe decision is invalid");
            }
        }

        internal static Dictionary<string, object> PipeClient(Dictionary<string, object> request)
        {
            Protocol.RequireExactKeys(
                request,
                new string[] {
                    "pipeName", "capabilityHex", "bindingHex", "role", "maxFrameBytes",
                    "connectDeadlineMs", "readDeadlineMs"
                },
                "pipe-client request");
            string name = RequirePipeName(request);
            string capability = Protocol.RequireLowerHex64(request, "capabilityHex");
            string binding = Protocol.RequireLowerHex64(request, "bindingHex");
            string role = Protocol.RequireString(request, "role", 1, 16);
            if (role != "ordinary" && role != "successor")
                throw new NativeFailure("PROTOCOL_ENUM", "pipe client role is invalid");
            int maximumFrame = Protocol.RequireInt(request, "maxFrameBytes", 256, 65536);
            int connectDeadline = Protocol.RequireInt(request, "connectDeadlineMs", 1, 120000);
            int readDeadline = Protocol.RequireInt(request, "readDeadlineMs", 1, 120000);
            if (!WaitNamedPipeW(name, (uint)connectDeadline))
            {
                ThrowWin32("PIPE_CONNECT_FAILED", "named pipe endpoint was unavailable");
            }

            using (SafeFileHandle pipe = CreateFileW(
                name,
                GenericRead | GenericWrite,
                0,
                IntPtr.Zero,
                OpenExisting,
                FileFlagOverlapped,
                IntPtr.Zero))
            {
                if (pipe.IsInvalid)
                {
                    int code = Marshal.GetLastWin32Error();
                    throw new NativeFailure("PIPE_CONNECT_FAILED", "named pipe connection failed", code);
                }

                byte[] payload = StrictUtf8.GetBytes(Json.Serialize(Protocol.Object(
                    "protocolVersion", Protocol.Version,
                    "role", role,
                    "bindingHex", binding,
                    "capabilityHex", capability)));
                PipeIoDeadline ioDeadline = new PipeIoDeadline(readDeadline);
                WriteFrame(pipe, payload, maximumFrame, ioDeadline, null);
                byte[] offerBytes = ReadFrame(pipe, maximumFrame, ioDeadline, null);
                Dictionary<string, object> offer = ParseOfferFrame(offerBytes);
                string offeredDecision = Protocol.RequireString(offer, "decision", 1, 32);
                string offerSha256 = Protocol.Sha256(offerBytes);
                WriteFrame(
                    pipe,
                    SerializeAcknowledgment("offer-ack", "offerSha256", offerSha256),
                    maximumFrame,
                    ioDeadline,
                    null);
                byte[] receiptBytes = ReadFrame(pipe, maximumFrame, ioDeadline, null);
                Dictionary<string, object> receipt = ParseCommitReceipt(
                    receiptBytes,
                    offerSha256,
                    offeredDecision);
                string decision = Protocol.RequireString(receipt, "decision", 1, 32);
                string responseSha256 = Protocol.Sha256(receiptBytes);
                WriteFrame(
                    pipe,
                    SerializeAcknowledgment("commit-ack", "receiptSha256", responseSha256),
                    maximumFrame,
                    ioDeadline,
                    null);
                return Protocol.Object(
                    "decision", decision,
                    "responseSha256", responseSha256);
            }
        }

        internal static Dictionary<string, object> DerivePipeName(Dictionary<string, object> request)
        {
            Protocol.RequireExactKeys(
                request,
                new string[] { "appId", "canonicalHomeId" },
                "pipe-name-derive request");
            string appId = Protocol.RequireString(request, "appId", 1, 256);
            string canonicalHomeId = Protocol.RequireString(request, "canonicalHomeId", 1, 4096);
            string suffix = Protocol.HashFramed(
                "enduragent.windows-upgrade-fence.v1",
                appId,
                canonicalHomeId);
            string pipeName = "\\\\.\\pipe\\Enduragent-upgrade-v1-" + suffix;
            return Protocol.Object("pipeName", pipeName, "suffix", suffix);
        }

        private static void ThrowWin32(string code, string message)
        {
            throw new NativeFailure(code, message, Marshal.GetLastWin32Error());
        }
    }
}
