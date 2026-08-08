using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Enduragent.WindowsHostFalsifier
{
    internal static class RuntimeBinding
    {
        internal static string CampaignRunId;
        internal static string CandidateSha256;
        internal static string PreflightSha256;
        internal static string ExecutionBundleManifestSha256;
        internal static string NativeCandidateDigest;
        internal static string NativeManifestSha256;
        internal static string NativeHelperSha256;
        internal static string EvidenceRootObjectIdentitySha256;
        internal static string NativeSessionId;
        internal static string RunRootIdentity;
        private static string observedRunRootIdentitySha256;
        private static bool runRootIdentityConfirmed;

        private const uint GenericRead = 0x80000000;
        private const uint FileShareRead = 0x00000001;
        private const uint OpenExisting = 3;
        private const uint FileAttributeNormal = 0x00000080;
        private static SafeFileHandle retainedAssembly;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        internal static void Initialize()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new NativeFailure("NATIVE_PLATFORM", "native helper requires Windows");
            if (!Environment.Is64BitProcess)
                throw new NativeFailure("NATIVE_ARCHITECTURE", "native helper requires an x64 process");

            CampaignRunId = RequireEnvironment("ENDURAGENT_CAMPAIGN_RUN_ID", 2, 128);
            CandidateSha256 = RequireHexEnvironment("ENDURAGENT_CAMPAIGN_CANDIDATE_SHA256");
            PreflightSha256 = RequireHexEnvironment("ENDURAGENT_PREFLIGHT_SHA256");
            ExecutionBundleManifestSha256 = RequireHexEnvironment("ENDURAGENT_EXECUTION_BUNDLE_MANIFEST_SHA256");
            NativeCandidateDigest = RequireHexEnvironment("ENDURAGENT_NATIVE_CANDIDATE_DIGEST");
            NativeManifestSha256 = RequireHexEnvironment("ENDURAGENT_NATIVE_MANIFEST_SHA256");
            NativeHelperSha256 = RequireHexEnvironment("ENDURAGENT_PREFLIGHT_NATIVE_HELPER_SHA256");
            EvidenceRootObjectIdentitySha256 = RequireHexEnvironment("ENDURAGENT_EVIDENCE_ROOT_OBJECT_IDENTITY_SHA256");
            NativeSessionId = RequireEnvironment("ENDURAGENT_NATIVE_SESSION_ID", 2, 64);
            string runRoot = RequireEnvironment("ENDURAGENT_NATIVE_RUN_ROOT", 3, 32767);
            string assemblyPath = Assembly.GetExecutingAssembly().Location;
            SafeFileHandle assemblyHold = CreateFileW(
                assemblyPath,
                GenericRead,
                FileShareRead,
                IntPtr.Zero,
                OpenExisting,
                FileAttributeNormal,
                IntPtr.Zero);
            if (assemblyHold.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                assemblyHold.Dispose();
                throw new NativeFailure("ASSEMBLY_HOLD_FAILED", "native assembly launch hold could not be retained", code);
            }
            try
            {
                byte[] assembly = File.ReadAllBytes(assemblyPath);
                string actualAssembly = Protocol.Sha256(assembly);
                if (!String.Equals(NativeHelperSha256, actualAssembly, StringComparison.Ordinal))
                    throw new NativeFailure("ASSEMBLY_IDENTITY_MISMATCH", "native assembly digest did not match the preflight binding");
                retainedAssembly = assemblyHold;
                assemblyHold = null;
            }
            finally
            {
                if (assemblyHold != null) assemblyHold.Dispose();
            }
            RunRootIdentity = FileSystemProbe.InitializeRunRoot(runRoot);
            observedRunRootIdentitySha256 = Protocol.Sha256(RunRootIdentity);
            runRootIdentityConfirmed = false;
        }

        internal static void Verify(RequestFrame frame)
        {
            if (!String.Equals((string)frame.Context["campaignRunId"], CampaignRunId, StringComparison.Ordinal) ||
                !String.Equals((string)frame.Context["candidateSha256"], CandidateSha256, StringComparison.Ordinal) ||
                !String.Equals((string)frame.Context["preflightSha256"], PreflightSha256, StringComparison.Ordinal) ||
                !String.Equals((string)frame.Context["executionBundleManifestSha256"], ExecutionBundleManifestSha256, StringComparison.Ordinal) ||
                !String.Equals((string)frame.Context["nativeCandidateDigest"], NativeCandidateDigest, StringComparison.Ordinal) ||
                !String.Equals((string)frame.Context["nativeManifestSha256"], NativeManifestSha256, StringComparison.Ordinal) ||
                !String.Equals((string)frame.Context["nativeHelperSha256"], NativeHelperSha256, StringComparison.Ordinal) ||
                !String.Equals((string)frame.Context["evidenceRootObjectIdentitySha256"], EvidenceRootObjectIdentitySha256, StringComparison.Ordinal) ||
                !String.Equals((string)frame.Context["nativeSessionId"], NativeSessionId, StringComparison.Ordinal))
            {
                throw new NativeFailure("CONTEXT_BINDING_MISMATCH", "request context does not match the native process binding");
            }
            if (!runRootIdentityConfirmed && !String.Equals(frame.Command, "native-binding-check", StringComparison.Ordinal))
                throw new NativeFailure("RUN_ROOT_BINDING_REQUIRED", "native run root has not completed its startup binding");
        }

        internal static void ConfirmRunRootIdentity()
        {
            if (!String.Equals(observedRunRootIdentitySha256, EvidenceRootObjectIdentitySha256, StringComparison.Ordinal))
                throw new NativeFailure("RUN_ROOT_IDENTITY_MISMATCH", "native run root differs from the preflight object identity");
            runRootIdentityConfirmed = true;
        }

        internal static void Dispose()
        {
            runRootIdentityConfirmed = false;
            observedRunRootIdentitySha256 = null;
            SafeFileHandle assembly = retainedAssembly;
            retainedAssembly = null;
            if (assembly != null) assembly.Dispose();
        }

        private static string RequireEnvironment(string key, int minimum, int maximum)
        {
            string value = Environment.GetEnvironmentVariable(key);
            if (String.IsNullOrEmpty(value) || value.Length < minimum || value.Length > maximum || value.IndexOf('\0') >= 0)
                throw new NativeFailure("NATIVE_ENVIRONMENT", "native process binding is incomplete");
            return value;
        }

        private static string RequireHexEnvironment(string key)
        {
            string value = RequireEnvironment(key, 64, 64);
            if (!Regex.IsMatch(value, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant))
                throw new NativeFailure("NATIVE_ENVIRONMENT", "native process digest binding is invalid");
            return value;
        }
    }

    internal abstract class NativeSession : IDisposable
    {
        private long sequence;
        internal readonly string SessionId;
        internal readonly string OperationId;

        protected NativeSession(string sessionId, string operationId)
        {
            SessionId = sessionId;
            OperationId = operationId;
        }

        protected void Emit(string eventName, Dictionary<string, object> data)
        {
            long next = Interlocked.Increment(ref sequence);
            Protocol.WriteEvent(SessionId, OperationId, next, eventName, data);
        }

        internal abstract Dictionary<string, object> Control(string action);
        public abstract void Dispose();
    }

    internal sealed class DispatchResult
    {
        internal Dictionary<string, object> Result;
        internal PipeOwnerSession PipeOwnerToStart;
    }

    internal static class PreflightObserver
    {
        private const int SystemBootEnvironmentInformation = 90;
        private const int TokenStatisticsInformation = 10;
        private const int WtsConnectStateInformation = 8;
        private const int WtsActive = 0;
        private const uint GenericRead = 0x80000000;
        private const uint FileShareRead = 0x00000001;
        private const uint OpenExisting = 3;
        private const uint FileAttributeNormal = 0x00000080;

        [StructLayout(LayoutKind.Sequential)]
        private struct SYSTEM_BOOT_ENVIRONMENT_INFORMATION
        {
            internal Guid BootIdentifier;
            internal int FirmwareType;
            internal ulong BootFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct LUID
        {
            internal uint LowPart;
            internal int HighPart;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_STATISTICS
        {
            internal LUID TokenId;
            internal LUID AuthenticationId;
            internal long ExpirationTime;
            internal int TokenType;
            internal int ImpersonationLevel;
            internal uint DynamicCharged;
            internal uint DynamicAvailable;
            internal uint GroupCount;
            internal uint PrivilegeCount;
            internal LUID ModifiedId;
        }

        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate int NtQuerySystemInformationDelegate(
            int systemInformationClass,
            ref SYSTEM_BOOT_ENVIRONMENT_INFORMATION systemInformation,
            int systemInformationLength,
            out int returnLength);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr GetModuleHandleW(string moduleName);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
        private static extern IntPtr GetProcAddress(IntPtr module, string procedureName);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTokenInformation(
            IntPtr tokenHandle,
            int tokenInformationClass,
            out TOKEN_STATISTICS tokenInformation,
            int tokenInformationLength,
            out int returnLength);

        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WTSQuerySessionInformationW(
            IntPtr server,
            uint sessionId,
            int informationClass,
            out IntPtr buffer,
            out uint bytesReturned);

        [DllImport("wtsapi32.dll")]
        private static extern void WTSFreeMemory(IntPtr memory);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        internal static int Run()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new NativeFailure("NATIVE_PLATFORM", "preflight observer requires Windows");
            if (!Environment.Is64BitProcess)
                throw new NativeFailure("NATIVE_ARCHITECTURE", "preflight observer requires x64");

            string runRoot = RequireEnvironment("ENDURAGENT_NATIVE_RUN_ROOT", 3, 32767);
            string pathProfileId = RequireEnvironment("ENDURAGENT_PATH_PROFILE_ID", 3, 32);
            if (pathProfileId != "ascii" && pathProfileId != "spaces-unicode")
                throw new NativeFailure("PREFLIGHT_PROFILE", "preflight path profile is invalid");

            string assemblyPath = Assembly.GetExecutingAssembly().Location;
            using (SafeFileHandle assemblyHold = CreateFileW(
                assemblyPath,
                GenericRead,
                FileShareRead,
                IntPtr.Zero,
                OpenExisting,
                FileAttributeNormal,
                IntPtr.Zero))
            {
                if (assemblyHold.IsInvalid)
                    throw new NativeFailure(
                        "ASSEMBLY_HOLD_FAILED",
                        "preflight assembly hold could not be retained",
                        Marshal.GetLastWin32Error());

                FileInfo assemblyFile = new FileInfo(assemblyPath);
                if (!assemblyFile.Exists ||
                    assemblyFile.Length < 512 ||
                    assemblyFile.Length > 16 * 1024 * 1024)
                    throw new NativeFailure(
                        "PREFLIGHT_ASSEMBLY",
                        "preflight helper is not a bounded assembly");
                byte[] assemblyBytes = File.ReadAllBytes(assemblyPath);
                string nativeHelperSha256 = Protocol.Sha256(assemblyBytes);
                string manifestPath = Path.Combine(
                    Path.GetDirectoryName(assemblyPath),
                    "native-candidate.json");
                FileInfo manifestFile = new FileInfo(manifestPath);
                if (!manifestFile.Exists ||
                    manifestFile.Length <= 0 ||
                    manifestFile.Length > Protocol.MaxOutputFrameBytes)
                    throw new NativeFailure(
                        "PREFLIGHT_MANIFEST",
                        "preflight candidate manifest is not bounded");
                byte[] manifestBytes = File.ReadAllBytes(manifestPath);
                Dictionary<string, object> manifest = ParseManifest(manifestBytes);
                Dictionary<string, object> manifestAssembly =
                    manifest["assembly"] as Dictionary<string, object>;
                if (manifestAssembly == null)
                    throw new NativeFailure(
                        "PREFLIGHT_MANIFEST",
                        "preflight candidate manifest has no assembly identity");
                Protocol.RequireExactKeys(
                    manifestAssembly,
                    new string[] { "name", "sha256" },
                    "preflight candidate assembly");
                string manifestAssemblySha256 =
                    Protocol.RequireLowerHex64(manifestAssembly, "sha256");
                if (!String.Equals(
                    manifestAssemblySha256,
                    nativeHelperSha256,
                    StringComparison.Ordinal))
                    throw new NativeFailure(
                        "PREFLIGHT_ASSEMBLY",
                        "preflight helper differs from its candidate manifest");

                string nativeCandidateDigest =
                    Protocol.RequireLowerHex64(manifest, "candidateDigest");
                string sourceBundleSha256 =
                    Protocol.RequireLowerHex64(manifest, "sourceBundleSha256");
                string nativeManifestSha256 = Protocol.Sha256(manifestBytes);
                string runRootIdentity = FileSystemProbe.InitializeRunRoot(runRoot);
                string rootSecuritySha256 = FileSystemProbe.RunRootSecuritySha256();
                Dictionary<string, object> home = FileSystemProbe.HomeIdentity(
                    Protocol.Object("path", FileSystemProbe.RunRootPath));
                string observedObjectIdentity = (string)home["objectIdentity"];
                if (!String.Equals(
                    observedObjectIdentity,
                    runRootIdentity,
                    StringComparison.Ordinal))
                    throw new NativeFailure(
                        "PREFLIGHT_ROOT_IDENTITY",
                        "preflight root identity changed during observation");

                string canonicalPath = FileSystemProbe.RunRootPath;
                bool nfcNormalized =
                    String.Equals(
                        canonicalPath,
                        canonicalPath.Normalize(NormalizationForm.FormC),
                        StringComparison.Ordinal);
                bool containsSpaces = canonicalPath.IndexOf(' ') >= 0;
                bool containsUnicode = ContainsNonAscii(canonicalPath);
                bool expectsComplexPath = pathProfileId == "spaces-unicode";
                if (!nfcNormalized ||
                    containsSpaces != expectsComplexPath ||
                    containsUnicode != expectsComplexPath)
                    throw new NativeFailure(
                        "PREFLIGHT_PROFILE",
                        "preflight root does not satisfy its path profile");
                if (!String.Equals(
                    rootSecuritySha256,
                    FileSystemProbe.RunRootSecuritySha256(),
                    StringComparison.Ordinal))
                    throw new NativeFailure(
                        "PREFLIGHT_ROOT_SECURITY",
                        "preflight root security changed during observation");

                string runnerUserSidSha256;
                string runnerSessionIdSha256 =
                    RunnerSessionIdentitySha256(out runnerUserSidSha256);
                Dictionary<string, object> observation = Protocol.Object(
                    "bootIdSha256", BootIdentitySha256(),
                    "containsSpaces", containsSpaces,
                    "containsUnicode", containsUnicode,
                    "driveType", (string)home["driveType"],
                    "evidenceRootObjectIdentitySha256", Protocol.Sha256(runRootIdentity),
                    "fileSystem", (string)home["fileSystem"],
                    "kind", "windows-host-native-preflight-observation",
                    "localAbsolute", true,
                    "interactiveSessionActive", true,
                    "nativeCandidateDigest", nativeCandidateDigest,
                    "nativeHelperSha256", nativeHelperSha256,
                    "nativeManifestSha256", nativeManifestSha256,
                    "networkPath", false,
                    "nfcNormalized", nfcNormalized,
                    "pathProfileId", pathProfileId,
                    "removableVolume", false,
                    "reparsePoint", Convert.ToInt64(home["reparseTag"]) != 0,
                    "rootPathSha256", (string)home["finalPathSha256"],
                    "rootSecuritySha256", rootSecuritySha256,
                    "runnerSessionIdSha256", runnerSessionIdSha256,
                    "runnerUserSidSha256", runnerUserSidSha256,
                    "schemaVersion", 1,
                    "sourceBundleSha256", sourceBundleSha256,
                    "volumeIdSha256", Protocol.HashFramed(
                        "enduragent.windows-host-test-volume.v1",
                        (string)home["volumeIdentity"]));
                Protocol.WriteStandalone(observation);
                return 0;
            }
        }

        private static Dictionary<string, object> ParseManifest(byte[] bytes)
        {
            string text;
            try
            {
                text = new UTF8Encoding(false, true).GetString(bytes);
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = Protocol.MaxOutputFrameBytes;
                serializer.RecursionLimit = 16;
                Dictionary<string, object> manifest =
                    serializer.DeserializeObject(text) as Dictionary<string, object>;
                if (manifest == null)
                    throw new NativeFailure(
                        "PREFLIGHT_MANIFEST",
                        "preflight candidate manifest is not an object");
                Protocol.RequireExactKeys(
                    manifest,
                    new string[] {
                        "schemaVersion",
                        "candidateDigest",
                        "assembly",
                        "sourceBundleSha256",
                        "toolchainDigest",
                        "sources",
                        "toolchain"
                    },
                    "preflight candidate manifest");
                return manifest;
            }
            catch (NativeFailure)
            {
                throw;
            }
            catch
            {
                throw new NativeFailure(
                    "PREFLIGHT_MANIFEST",
                    "preflight candidate manifest is invalid");
            }
        }

        private static string BootIdentitySha256()
        {
            IntPtr module = GetModuleHandleW("ntdll.dll");
            IntPtr procedure = module == IntPtr.Zero
                ? IntPtr.Zero
                : GetProcAddress(module, "NtQuerySystemInformation");
            if (procedure == IntPtr.Zero)
                throw new NativeFailure(
                    "PREFLIGHT_BOOT_IDENTITY_UNSUPPORTED",
                    "Windows boot identity is unsupported on this build");
            NtQuerySystemInformationDelegate query =
                Marshal.GetDelegateForFunctionPointer(
                    procedure,
                    typeof(NtQuerySystemInformationDelegate))
                as NtQuerySystemInformationDelegate;
            if (query == null)
                throw new NativeFailure(
                    "PREFLIGHT_BOOT_IDENTITY_UNSUPPORTED",
                    "Windows boot identity is unsupported on this build");
            SYSTEM_BOOT_ENVIRONMENT_INFORMATION information =
                new SYSTEM_BOOT_ENVIRONMENT_INFORMATION();
            int returned;
            int expectedBytes = Marshal.SizeOf(typeof(SYSTEM_BOOT_ENVIRONMENT_INFORMATION));
            int status = query(
                SystemBootEnvironmentInformation,
                ref information,
                expectedBytes,
                out returned);
            if (status < 0 || returned != expectedBytes || information.BootIdentifier == Guid.Empty)
                throw new NativeFailure(
                    "PREFLIGHT_BOOT_IDENTITY_UNSUPPORTED",
                    "Windows boot identity is unsupported on this build");
            return Protocol.HashFramed(
                "enduragent.windows-host-boot-identity.v1",
                information.BootIdentifier.ToString("D"));
        }

        private static string RunnerSessionIdentitySha256(out string userSidSha256)
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query))
            {
                TOKEN_STATISTICS statistics;
                int returned;
                if (!GetTokenInformation(
                    identity.Token,
                    TokenStatisticsInformation,
                    out statistics,
                    Marshal.SizeOf(typeof(TOKEN_STATISTICS)),
                    out returned) ||
                    returned < Marshal.SizeOf(typeof(TOKEN_STATISTICS)) ||
                    identity.User == null)
                    throw new NativeFailure(
                        "PREFLIGHT_SESSION_IDENTITY",
                        "Windows runner-session identity is unavailable",
                        Marshal.GetLastWin32Error());
                int sessionId = Process.GetCurrentProcess().SessionId;
                IntPtr stateBuffer;
                uint stateBytes;
                if (!WTSQuerySessionInformationW(
                    IntPtr.Zero,
                    checked((uint)sessionId),
                    WtsConnectStateInformation,
                    out stateBuffer,
                    out stateBytes))
                    throw new NativeFailure(
                        "PREFLIGHT_INTERACTIVE_SESSION",
                        "Windows runner session state is unavailable",
                        Marshal.GetLastWin32Error());
                try
                {
                    if (stateBuffer == IntPtr.Zero ||
                        stateBytes != sizeof(int) ||
                        Marshal.ReadInt32(stateBuffer) != WtsActive)
                        throw new NativeFailure(
                            "PREFLIGHT_INTERACTIVE_SESSION",
                            "Windows runner session is not active and interactive");
                }
                finally
                {
                    if (stateBuffer != IntPtr.Zero) WTSFreeMemory(stateBuffer);
                }
                userSidSha256 = Protocol.Sha256(identity.User.Value);
                string authenticationId =
                    unchecked((uint)statistics.AuthenticationId.HighPart).ToString("x8") +
                    statistics.AuthenticationId.LowPart.ToString("x8");
                return Protocol.HashFramed(
                    "enduragent.windows-host-runner-session-identity.v1",
                    identity.User.Value,
                    sessionId.ToString(),
                    authenticationId,
                    "WTSActive");
            }
        }

        private static bool ContainsNonAscii(string value)
        {
            foreach (char character in value)
            {
                if (character > 0x7f) return true;
            }
            return false;
        }

        private static string RequireEnvironment(string key, int minimum, int maximum)
        {
            string value = Environment.GetEnvironmentVariable(key);
            if (String.IsNullOrEmpty(value) ||
                value.Length < minimum ||
                value.Length > maximum ||
                value.IndexOf('\0') >= 0)
                throw new NativeFailure(
                    "PREFLIGHT_ENVIRONMENT",
                    "preflight observer environment is incomplete");
            return value;
        }
    }

    public static class Program
    {
        private static readonly Dictionary<string, NativeSession> Sessions =
            new Dictionary<string, NativeSession>(StringComparer.Ordinal);
        private static readonly HashSet<string> RequestIds =
            new HashSet<string>(StringComparer.Ordinal);

        public static int Main(string[] args)
        {
            if (args.Length == 1 && args[0].StartsWith("--job-child=", StringComparison.Ordinal))
                return RunJobChild(args[0].Substring("--job-child=".Length));
            if (args.Length == 1 && args[0] == "--preflight-observe")
            {
                try
                {
                    return PreflightObserver.Run();
                }
                catch
                {
                    return 4;
                }
                finally
                {
                    FileSystemProbe.DisposeRunRoot();
                }
            }
            if (args.Length == 1 && args[0] == "--broker-context-channel")
            {
                try
                {
                    return BrokerContextChannel.Run();
                }
                catch
                {
                    return 5;
                }
            }
            if (args.Length == 1 && args[0] == "--broker-context-observe")
            {
                try
                {
                    return BrokerContextChannel.ObserveOnce();
                }
                catch
                {
                    return 5;
                }
            }

            try
            {
                RuntimeBinding.Initialize();
                Stream input = Console.OpenStandardInput();
                while (true)
                {
                    RequestFrame frame;
                    try
                    {
                        frame = Protocol.ReadRequest(input);
                    }
                    catch
                    {
                        return 2;
                    }
                    if (frame == null) break;
                    if (!RequestIds.Add(frame.RequestId))
                    {
                        Protocol.WriteFailure(frame, new NativeFailure("DUPLICATE_REQUEST_ID", "request id was already used in this native session"));
                        continue;
                    }

                    try
                    {
                        RuntimeBinding.Verify(frame);
                        DispatchResult dispatched = Dispatch(frame);
                        Protocol.WriteSuccess(frame, dispatched.Result);
                        if (dispatched.PipeOwnerToStart != null) dispatched.PipeOwnerToStart.Start();
                    }
                    catch (Exception error)
                    {
                        Protocol.WriteFailure(frame, Protocol.Sanitize(error));
                    }
                }
                return 0;
            }
            catch
            {
                return 3;
            }
            finally
            {
                foreach (NativeSession session in Sessions.Values)
                {
                    try { session.Dispose(); }
                    catch { }
                }
                Sessions.Clear();
                FileSystemProbe.DisposeRunRoot();
                RuntimeBinding.Dispose();
            }
        }

        private static DispatchResult Dispatch(RequestFrame frame)
        {
            Dictionary<string, object> result;
            PipeOwnerSession start = null;
            if (frame.Command == "native-binding-check")
            {
                Protocol.RequireExactKeys(frame.Request, new string[0], "native-binding-check wire request");
                RuntimeBinding.ConfirmRunRootIdentity();
                result = Protocol.Object(
                    "ready", true,
                    "processId", Process.GetCurrentProcess().Id,
                    "nativeHelperSha256", RuntimeBinding.NativeHelperSha256,
                    "runRootIdentity", RuntimeBinding.RunRootIdentity,
                    "evidenceRootObjectIdentitySha256", RuntimeBinding.EvidenceRootObjectIdentitySha256);
            }
            else if (frame.Command == "home-identity")
            {
                Protocol.RequireExactKeys(frame.Request, new string[] { "relativePath" }, "home-identity wire request");
                result = FileSystemProbe.HomeIdentity(Protocol.Object(
                    "path", FileSystemProbe.CombineRunRelative(Protocol.RequireString(frame.Request, "relativePath", 1, 32767))));
            }
            else if (frame.Command == "private-directory-ensure")
            {
                Protocol.RequireExactKeys(frame.Request, new string[] { "relativePath", "action" }, "private-directory-ensure wire request");
                result = PrivateDirectoryResult(FileSystemProbe.EnsurePrivateDirectoryRelative(
                    Protocol.RequireString(frame.Request, "relativePath", 1, 32767),
                    Protocol.RequireString(frame.Request, "action", 1, 16)));
            }
            else if (frame.Command == "private-directory-inspect")
            {
                Protocol.RequireExactKeys(frame.Request, new string[] { "relativePath" }, "private-directory-inspect wire request");
                result = PrivateDirectoryResult(FileSystemProbe.InspectPrivateDirectoryRelative(
                    Protocol.RequireString(frame.Request, "relativePath", 1, 32767)));
            }
            else if (frame.Command == "private-file-create")
            {
                Protocol.RequireExactKeys(frame.Request, new string[] { "relativePath", "contentSource" }, "private-file-create wire request");
                byte[] content = FileSystemProbe.LoadContentSource(Protocol.RequireObject(frame.Request, "contentSource"));
                result = FileSystemProbe.CreatePrivateFile(Protocol.Object(
                    "root", FileSystemProbe.RunRootPath,
                    "relativePath", Protocol.RequireString(frame.Request, "relativePath", 1, 32767),
                    "contentBase64", Convert.ToBase64String(content)));
            }
            else if (frame.Command == "secure-path-operation")
            {
                result = DispatchSecurePath(frame.Request);
            }
            else if (frame.Command == "file-identity")
            {
                Protocol.RequireExactKeys(frame.Request, new string[] { "relativePath" }, "file-identity wire request");
                result = FileSystemProbe.FileIdentity(Protocol.Object(
                    "root", FileSystemProbe.RunRootPath,
                    "relativePath", Protocol.RequireString(frame.Request, "relativePath", 1, 32767)));
            }
            else if (frame.Command == "evidence-tree-seal")
            {
                result = FileSystemProbe.EvidenceTreeSeal(frame.Request);
            }
            else if (frame.Command == "durable-replace")
            {
                Protocol.RequireExactKeys(
                    frame.Request,
                    new string[] { "relativePath", "tempRelativePath", "contentSource", "checkpoint", "retry" },
                    "durable-replace wire request");
                byte[] content = FileSystemProbe.LoadContentSource(Protocol.RequireObject(frame.Request, "contentSource"));
                result = FileSystemProbe.DurableReplace(Protocol.Object(
                    "root", FileSystemProbe.RunRootPath,
                    "relativePath", Protocol.RequireString(frame.Request, "relativePath", 1, 32767),
                    "tempRelativePath", Protocol.RequireString(frame.Request, "tempRelativePath", 1, 32767),
                    "contentBase64", Convert.ToBase64String(content),
                    "checkpoint", Protocol.RequireString(frame.Request, "checkpoint", 1, 32),
                    "retry", Protocol.RequireObject(frame.Request, "retry")));
            }
            else if (frame.Command == "pipe-owner")
            {
                string id = NewSessionId();
                PipeOwnerSession owner = new PipeOwnerSession(id, OperationId(frame), frame.Request);
                Sessions.Add(id, owner);
                result = owner.ReadyResult();
                start = owner;
            }
            else if (frame.Command == "pipe-name-derive")
            {
                result = NamedPipeProbe.DerivePipeName(frame.Request);
            }
            else if (frame.Command == "pipe-client")
            {
                result = NamedPipeProbe.PipeClient(frame.Request);
            }
            else if (frame.Command == "pipe-foreign-precreate")
            {
                string id = NewSessionId();
                PipeForeignSession foreign = new PipeForeignSession(id, OperationId(frame), frame.Request);
                Sessions.Add(id, foreign);
                result = foreign.ReadyResult();
            }
            else if (frame.Command == "job-owner")
            {
                result = DispatchJobOwner(frame);
            }
            else if (frame.Command == "process-identity")
            {
                result = JobObjectProbe.ProcessIdentity(frame.Request);
            }
            else if (frame.Command == "job-query")
            {
                result = JobObjectProbe.JobQuery(frame.Request);
            }
            else if (frame.Command == "session-control")
            {
                result = DispatchSessionControl(frame.Request);
            }
            else
            {
                throw new NativeFailure("COMMAND_UNKNOWN", "native command is not allowlisted");
            }
            return new DispatchResult { Result = result, PipeOwnerToStart = start };
        }

        private static Dictionary<string, object> PrivateDirectoryResult(Dictionary<string, object> inspected)
        {
            return Protocol.Object(
                "objectIdentity", inspected["objectIdentity"],
                "ownerSidSha256", inspected["ownerSidSha256"],
                "protectedAcl", inspected["protectedAcl"],
                "principals", inspected["principals"],
                "unexpectedAceCount", inspected["unexpectedAceCount"],
                "sddlSha256", inspected["sddlSha256"]);
        }

        private static Dictionary<string, object> DispatchSecurePath(Dictionary<string, object> wire)
        {
            string operation = Protocol.RequireString(wire, "operation", 1, 16);
            string[] permitted = new string[] {
                "relativePath", "operation", "expectedIdentity", "destinationRelativePath", "contentSource"
            };
            string[] required;
            if (operation == "create" || operation == "replace")
                required = new string[] { "relativePath", "operation", "contentSource" };
            else if (operation == "quarantine")
                required = new string[] { "relativePath", "operation", "destinationRelativePath" };
            else if (operation == "read" || operation == "delete")
                required = new string[] { "relativePath", "operation" };
            else
                throw new NativeFailure("PROTOCOL_ENUM", "secure path operation is invalid");
            Protocol.RequireKeys(wire, required, permitted, "secure-path-operation wire request");
            Dictionary<string, object> request = Protocol.Object(
                "root", FileSystemProbe.RunRootPath,
                "relativePath", Protocol.RequireString(wire, "relativePath", 1, 32767),
                "operation", operation);
            if (wire.ContainsKey("expectedIdentity"))
                request.Add("expectedIdentity", Protocol.RequireString(wire, "expectedIdentity", 1, 128));
            if (wire.ContainsKey("destinationRelativePath"))
                request.Add("destinationRelativePath", Protocol.RequireString(wire, "destinationRelativePath", 1, 32767));
            if (wire.ContainsKey("contentSource"))
                request.Add("contentBase64", Convert.ToBase64String(
                    FileSystemProbe.LoadContentSource(Protocol.RequireObject(wire, "contentSource"))));
            return FileSystemProbe.SecurePathOperation(request);
        }

        private static Dictionary<string, object> DispatchJobOwner(RequestFrame frame)
        {
            Protocol.RequireExactKeys(
                frame.Request,
                new string[] { "scenario", "deadlines" },
                "job-owner wire request");
            string executable = Assembly.GetExecutingAssembly().Location;
            string scenario = Protocol.RequireString(frame.Request, "scenario", 1, 32);
            string[] arguments = new string[] { "--job-child=" + scenario };
            Dictionary<string, object> nativeRequest = Protocol.Object(
                "executable", executable,
                "args", arguments,
                "scenario", scenario,
                "deadlines", Protocol.RequireObject(frame.Request, "deadlines"));
            string id = NewSessionId();
            JobOwnerSession owner = new JobOwnerSession(id, OperationId(frame), nativeRequest);
            Sessions.Add(id, owner);
            return owner.ReadyResult();
        }

        private static Dictionary<string, object> DispatchSessionControl(Dictionary<string, object> request)
        {
            Protocol.RequireExactKeys(request, new string[] { "sessionId", "action" }, "session-control request");
            string sessionId = Protocol.RequireString(request, "sessionId", 2, 64);
            string action = Protocol.RequireString(request, "action", 1, 16);
            NativeSession session;
            if (!Sessions.TryGetValue(sessionId, out session))
                throw new NativeFailure("SESSION_UNKNOWN", "native resource session was not found");
            Dictionary<string, object> result = session.Control(action);
            if (action == "close") Sessions.Remove(sessionId);
            return result;
        }

        private static string OperationId(RequestFrame frame)
        {
            return (string)frame.Context["operationId"];
        }

        private static string NewSessionId()
        {
            return "ns-" + Guid.NewGuid().ToString("N");
        }

        private static int RunJobChild(string scenario)
        {
            if (scenario == "normal")
            {
                Thread.Sleep(100);
                return 0;
            }
            if (scenario == "crash-before-ready") return 23;
            if (scenario == "crash-after-ready")
            {
                Thread.Sleep(500);
                return 24;
            }
            if (scenario == "grandchild")
            {
                ProcessStartInfo start = new ProcessStartInfo(
                    Assembly.GetExecutingAssembly().Location,
                    "--job-child=hung");
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                Process.Start(start);
            }
            if (scenario == "hung" || scenario == "grandchild")
            {
                while (true) Thread.Sleep(1000);
            }
            return 25;
        }
    }
}
