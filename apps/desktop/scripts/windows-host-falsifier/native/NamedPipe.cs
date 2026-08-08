using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Enduragent.WindowsHostFalsifier
{
    internal sealed class PipeOwnerSession : NativeSession
    {
        private readonly string pipeName;
        private readonly byte[] capability;
        private readonly byte[] binding;
        private readonly int maximumFrameBytes;
        private readonly int connectDeadlineMs;
        private readonly int readDeadlineMs;
        private readonly string currentSid;
        private readonly Thread worker;
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
                    bool connected = NamedPipeProbe.Connect(pipe, connectDeadlineMs);
                    if (!connected)
                    {
                        continue;
                    }

                    string clientSid = NamedPipeProbe.ImpersonatedClientSid(pipe);
                    byte[] payload = NamedPipeProbe.ReadFrame(pipe, maximumFrameBytes, readDeadlineMs);
                    Dictionary<string, object> frame = NamedPipeProbe.ParseClientFrame(payload);
                    string role = Protocol.RequireString(frame, "role", 1, 16);
                    string frameBinding = Protocol.RequireLowerHex64(frame, "bindingHex");
                    string frameCapability = Protocol.RequireLowerHex64(frame, "capabilityHex");
                    string decision = "reserved";
                    string reason = "ORDINARY_OR_UNAUTHORIZED";
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
                                capabilityConsumed = true;
                                decision = "designated";
                                reason = "CAPABILITY_CONSUMED";
                            }
                            else
                            {
                                reason = "CAPABILITY_ALREADY_CONSUMED";
                            }
                        }
                    }

                    NamedPipeProbe.WriteFrame(
                        pipe,
                        NamedPipeProbe.SerializeServerFrame(decision),
                        maximumFrameBytes,
                        readDeadlineMs);
                    Emit(
                        "client-decision",
                        Protocol.Object(
                            "decision", decision,
                            "reasonCode", reason,
                            "clientSidSha256", Protocol.Sha256(clientSid)));
                }
                catch (NativeFailure failure)
                {
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
                if (stopping) return;
                stopping = true;
            }

            SafeFileHandle current = pipe;
            pipe = null;
            if (current != null)
            {
                current.Dispose();
            }

            if (Thread.CurrentThread != worker && worker.IsAlive)
            {
                worker.Join(Math.Min(connectDeadlineMs + readDeadlineMs, 5000));
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
        private const int ErrorPipeConnected = 535;
        private const int ErrorBrokenPipe = 109;
        private const int WaitObject0 = 0;
        private const int WaitTimeout = 258;
        private const uint SecurityDescriptorRevision = 1;

        private static readonly Regex PipeNamePattern = new Regex(
            @"^\\\\\.\\pipe\\Enduragent-upgrade-v1-[a-f0-9]{64}$",
            RegexOptions.CultureInvariant);
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static readonly JavaScriptSerializer Json = CreateSerializer();

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
        private static extern bool ConnectNamedPipe(SafeFileHandle pipe, ref OVERLAPPED overlapped);

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
            SafeFileHandle file,
            byte[] buffer,
            uint bytesToRead,
            out uint bytesRead,
            ref OVERLAPPED overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WriteFile(
            SafeFileHandle file,
            byte[] buffer,
            uint bytesToWrite,
            out uint bytesWritten,
            ref OVERLAPPED overlapped);

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
            SafeFileHandle file,
            ref OVERLAPPED overlapped,
            out uint transferred,
            [MarshalAs(UnmanagedType.Bool)] bool wait);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CancelIoEx(SafeFileHandle file, ref OVERLAPPED overlapped);

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

        internal static bool Connect(SafeFileHandle pipe, int deadlineMs)
        {
            return RunOverlapped(
                pipe,
                delegate(ref OVERLAPPED overlapped, out uint immediate)
                {
                    immediate = 0;
                    bool result = ConnectNamedPipe(pipe, ref overlapped);
                    if (!result && Marshal.GetLastWin32Error() == ErrorPipeConnected) return true;
                    return result;
                },
                deadlineMs,
                "PIPE_CONNECT_FAILED",
                true) >= 0;
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
                RevertToSelf();
            }
        }

        internal static byte[] ReadFrame(SafeFileHandle pipe, int maximumBytes, int deadlineMs)
        {
            byte[] header = ReadExact(pipe, 4, deadlineMs);
            int length = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
            if (length <= 0 || length > maximumBytes)
            {
                throw new NativeFailure("PIPE_FRAME_SIZE", "named pipe frame length is invalid");
            }

            return ReadExact(pipe, length, deadlineMs);
        }

        internal static void WriteFrame(SafeFileHandle pipe, byte[] payload, int maximumBytes, int deadlineMs)
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
                int transferred = RunOverlapped(
                    pipe,
                    delegate(ref OVERLAPPED overlapped, out uint immediate)
                    {
                        return WriteFile(pipe, remaining, (uint)remaining.Length, out immediate, ref overlapped);
                    },
                    deadlineMs,
                    "PIPE_WRITE_FAILED",
                    false);
                if (transferred <= 0) throw new NativeFailure("PIPE_WRITE_SHORT", "named pipe write made no progress");
                offset += transferred;
            }
        }

        private static byte[] ReadExact(SafeFileHandle pipe, int length, int deadlineMs)
        {
            byte[] result = new byte[length];
            int offset = 0;
            while (offset < length)
            {
                byte[] chunk = new byte[length - offset];
                int transferred = RunOverlapped(
                    pipe,
                    delegate(ref OVERLAPPED overlapped, out uint immediate)
                    {
                        return ReadFile(pipe, chunk, (uint)chunk.Length, out immediate, ref overlapped);
                    },
                    deadlineMs,
                    "PIPE_READ_FAILED",
                    false);
                if (transferred <= 0) throw new NativeFailure("PIPE_READ_SHORT", "named pipe read ended early");
                Buffer.BlockCopy(chunk, 0, result, offset, transferred);
                offset += transferred;
            }

            return result;
        }

        private delegate bool OverlappedOperation(ref OVERLAPPED overlapped, out uint immediate);

        private static int RunOverlapped(
            SafeFileHandle file,
            OverlappedOperation operation,
            int deadlineMs,
            string failureCode,
            bool timeoutIsIdle)
        {
            IntPtr eventHandle = CreateEventW(IntPtr.Zero, true, false, null);
            if (eventHandle == IntPtr.Zero) ThrowWin32(failureCode, "overlapped event creation failed");
            try
            {
                OVERLAPPED overlapped = new OVERLAPPED { Event = eventHandle };
                uint immediate;
                bool completed = operation(ref overlapped, out immediate);
                if (completed) return (int)immediate;
                int error = Marshal.GetLastWin32Error();
                if (error != ErrorIoPending)
                {
                    throw new NativeFailure(failureCode, "overlapped pipe operation failed", error);
                }

                uint wait = WaitForSingleObject(eventHandle, (uint)deadlineMs);
                if (wait == WaitTimeout)
                {
                    CancelIoEx(file, ref overlapped);
                    WaitForSingleObject(eventHandle, 5000);
                    if (timeoutIsIdle) return -1;
                    throw new NativeFailure("PIPE_TIMEOUT", "named pipe operation timed out");
                }

                if (wait != WaitObject0)
                {
                    throw new NativeFailure(failureCode, "overlapped pipe wait failed", Marshal.GetLastWin32Error());
                }

                uint transferred;
                if (!GetOverlappedResult(file, ref overlapped, out transferred, false))
                {
                    throw new NativeFailure(failureCode, "overlapped pipe completion failed", Marshal.GetLastWin32Error());
                }

                return (int)transferred;
            }
            finally
            {
                CloseHandle(eventHandle);
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

        internal static byte[] SerializeServerFrame(string decision)
        {
            return StrictUtf8.GetBytes(Json.Serialize(Protocol.Object(
                "protocolVersion", Protocol.Version,
                "decision", decision)));
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
                WriteFrame(pipe, payload, maximumFrame, readDeadline);
                byte[] responseBytes = ReadFrame(pipe, maximumFrame, readDeadline);
                Dictionary<string, object> response;
                try
                {
                    response = Json.DeserializeObject(StrictUtf8.GetString(responseBytes)) as Dictionary<string, object>;
                }
                catch
                {
                    throw new NativeFailure("PIPE_RESPONSE_JSON", "named pipe response is invalid");
                }

                if (response == null) throw new NativeFailure("PIPE_RESPONSE_JSON", "named pipe response must be an object");
                Protocol.RequireExactKeys(response, new string[] { "protocolVersion", "decision" }, "named pipe response");
                if (Protocol.RequireInt(response, "protocolVersion", 1, 1) != Protocol.Version)
                    throw new NativeFailure("PIPE_RESPONSE_VERSION", "named pipe response version is invalid");
                string decision = Protocol.RequireString(response, "decision", 1, 32);
                if (decision != "designated" && decision != "reserved" && decision != "collision-refused" && decision != "refused")
                    throw new NativeFailure("PIPE_RESPONSE_DECISION", "named pipe decision is invalid");
                return Protocol.Object(
                    "decision", decision,
                    "responseSha256", Protocol.Sha256(responseBytes));
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
