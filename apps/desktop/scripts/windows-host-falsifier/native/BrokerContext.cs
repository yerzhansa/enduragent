using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Enduragent.WindowsHostFalsifier
{
    internal static class BrokerContextChannel
    {
        private const string SecurityProfile = "role-separated-immutable-file-mailbox-v1";
        private const string JournalSecurityProfile =
            "role-separated-append-only-journal-v1";
        private const string JournalDatabaseLeaf = "broker-journal.sqlite";
        private const string ObservedKind = "windows-host-native-broker-storage-observed";
        private const string AcquiredKind = "windows-host-native-broker-context-acquired";
        private const string RevalidatedKind = "windows-host-native-broker-context-revalidated";
        private const string ReleasedKind = "windows-host-native-broker-context-released";

        private const uint FileReadAttributes = 0x00000080;
        private const uint ReadControl = 0x00020000;
        private const uint WriteDac = 0x00040000;
        private const uint WriteOwner = 0x00080000;
        private const uint Synchronize = 0x00100000;
        private const uint GenericRead = 0x80000000;
        private const uint GenericWrite = 0x40000000;
        private const uint ShareRead = 0x00000001;
        private const uint ShareWrite = 0x00000002;
        private const uint OpenExisting = 3;
        private const uint FileAttributeNormal = 0x00000080;
        private const uint FileFlagBackupSemantics = 0x02000000;
        private const uint FileFlagOpenReparsePoint = 0x00200000;
        private const uint FileDirectoryFile = 0x00000001;
        private const uint FileSynchronousIoNonAlert = 0x00000020;
        private const uint FileOpenReparsePoint = 0x00200000;
        private const uint NtFileOpen = 1;
        private const uint NtFileOpenIf = 3;
        private const uint FileNonDirectoryFile = 0x00000040;
        private const uint ObjectCaseInsensitive = 0x00000040;
        private const uint DriveFixed = 3;
        private const int FileAttributeTagInfo = 9;
        private const int FileIdInfo = 18;
        private const int SeFileObject = 1;
        private const uint OwnerSecurityInformation = 0x00000001;
        private const uint DaclSecurityInformation = 0x00000004;
        private const uint ProtectedDaclSecurityInformation = 0x80000000;
        private const int SecurityDescriptorRevision = 1;
        private const int TokenStatisticsInformation = 10;
        private const int WtsConnectStateInformation = 8;
        private const int WtsActive = 0;
        private const int SystemBootEnvironmentInformation = 90;

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_ATTRIBUTE_TAG_INFO
        {
            internal uint FileAttributes;
            internal uint ReparseTag;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_ID_128
        {
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
            internal byte[] Identifier;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_ID_INFO
        {
            internal ulong VolumeSerialNumber;
            internal FILE_ID_128 FileId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct UNICODE_STRING
        {
            internal ushort Length;
            internal ushort MaximumLength;
            internal IntPtr Buffer;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct OBJECT_ATTRIBUTES
        {
            internal int Length;
            internal IntPtr RootDirectory;
            internal IntPtr ObjectName;
            internal uint Attributes;
            internal IntPtr SecurityDescriptor;
            internal IntPtr SecurityQualityOfService;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_STATUS_BLOCK
        {
            internal IntPtr Status;
            internal UIntPtr Information;
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

        [StructLayout(LayoutKind.Sequential)]
        private struct SYSTEM_BOOT_ENVIRONMENT_INFORMATION
        {
            internal Guid BootIdentifier;
            internal int FirmwareType;
            internal ulong BootFlags;
        }

        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate int NtQuerySystemInformationDelegate(
            int systemInformationClass,
            ref SYSTEM_BOOT_ENVIRONMENT_INFORMATION systemInformation,
            int systemInformationLength,
            out int returnLength);

        private sealed class Snapshot
        {
            internal string MailboxRequestedPathSha256;
            internal string MailboxFinalPath;
            internal string MailboxPathSha256;
            internal string MailboxObjectIdentity;
            internal string MailboxRootObjectIdentitySha256;
            internal string MailboxVolumeIdentity;
            internal string MailboxVolumeIdSha256;
            internal string MailboxOwnerSid;
            internal string MailboxOwnerSidSha256;
            internal string MailboxSddl;
            internal string MailboxAclSha256;
            internal string JournalRootRequestedPathSha256;
            internal string JournalRootFinalPath;
            internal string JournalRootPathSha256;
            internal string JournalRootObjectIdentity;
            internal string JournalRootObjectIdentitySha256;
            internal string JournalVolumeIdentity;
            internal string JournalVolumeIdSha256;
            internal string JournalRootOwnerSid;
            internal string JournalRootOwnerSidSha256;
            internal string JournalRootSddl;
            internal string JournalRootAclSha256;
            internal string JournalDatabaseFinalPath;
            internal string JournalDatabasePathSha256;
            internal string JournalDatabaseObjectIdentity;
            internal string JournalDatabaseObjectIdentitySha256;
            internal string JournalDatabaseOwnerSid;
            internal string JournalDatabaseOwnerSidSha256;
            internal string JournalDatabaseSddl;
            internal string JournalDatabaseAclSha256;
            internal string ProcessSid;
            internal string ProcessSidSha256;
            internal string AuthenticationLuid;
            internal string AuthenticationLuidSha256;
            internal string BootIdentity;
            internal string BootIdSha256;
            internal string RunnerSessionIdentity;
            internal string RunnerSessionIdSha256;
            internal string NativeHelperSha256;
            internal string MailboxTransportIdentitySha256;
            internal string JournalTransportIdentitySha256;
            internal string NativeObservationSha256;
        }

        private sealed class ChannelState : IDisposable
        {
            private readonly string mailboxPath;
            private readonly string journalRootPath;
            private readonly string expectedMailboxAclSha256;
            private readonly string expectedJournalRootAclSha256;
            private readonly string expectedJournalDatabaseAclSha256;
            private readonly HashSet<string> challenges =
                new HashSet<string>(StringComparer.Ordinal);
            private SafeFileHandle retainedMailbox;
            private SafeFileHandle retainedJournalRoot;
            private SafeFileHandle retainedJournalDatabase;
            private SafeFileHandle retainedAssembly;
            private Snapshot baseline;
            private int sequence;
            private string previousReceiptSha256;
            private bool released;

            internal ChannelState(
                string pinnedMailboxPath,
                string pinnedJournalRootPath,
                string pinnedExpectedMailboxAclSha256,
                string pinnedExpectedJournalRootAclSha256,
                string pinnedExpectedJournalDatabaseAclSha256,
                string challengeSha256,
                bool createJournalDatabaseIfMissing)
            {
                mailboxPath = ValidateStoragePath(
                    pinnedMailboxPath,
                    "broker mailbox",
                    "BROKER_CONTEXT_MAILBOX_PATH");
                journalRootPath = ValidateStoragePath(
                    pinnedJournalRootPath,
                    "broker journal root",
                    "BROKER_CONTEXT_JOURNAL_PATH");
                AssertDisjointRoots(mailboxPath, journalRootPath);
                expectedMailboxAclSha256 = pinnedExpectedMailboxAclSha256;
                expectedJournalRootAclSha256 = pinnedExpectedJournalRootAclSha256;
                expectedJournalDatabaseAclSha256 = pinnedExpectedJournalDatabaseAclSha256;
                challenges.Add(challengeSha256);

                SafeFileHandle mailbox = null;
                SafeFileHandle journalRoot = null;
                SafeFileHandle journalDatabase = null;
                SafeFileHandle assembly = null;
                try
                {
                    mailbox = OpenDirectoryWithoutReparse(mailboxPath, "broker mailbox");
                    journalRoot = OpenDirectoryWithoutReparse(
                        journalRootPath,
                        "broker journal root");
                    AssertDisjointRootHandles(mailbox, journalRoot);
                    journalDatabase = createJournalDatabaseIfMissing
                        ? OpenOrCreateJournalDatabase(journalRoot)
                        : OpenJournalDatabase(journalRoot);
                    assembly = OpenAssemblyHold();
                    Snapshot acquired = Observe(
                        mailbox,
                        journalRoot,
                        journalDatabase,
                        assembly,
                        mailboxPath,
                        journalRootPath);
                    if (!String.Equals(
                        acquired.MailboxAclSha256,
                        expectedMailboxAclSha256,
                        StringComparison.Ordinal))
                    {
                        throw new NativeFailure(
                            "BROKER_CONTEXT_ACL_MISMATCH",
                            "broker mailbox ACL differs from its pinned preparation");
                    }
                    if (!String.Equals(
                        acquired.JournalRootAclSha256,
                        expectedJournalRootAclSha256,
                        StringComparison.Ordinal))
                    {
                        throw new NativeFailure(
                            "BROKER_CONTEXT_JOURNAL_ROOT_ACL_MISMATCH",
                            "broker journal root ACL differs from its pinned preparation");
                    }
                    if (!String.Equals(
                        acquired.JournalDatabaseAclSha256,
                        expectedJournalDatabaseAclSha256,
                        StringComparison.Ordinal))
                    {
                        throw new NativeFailure(
                            "BROKER_CONTEXT_JOURNAL_DATABASE_ACL_MISMATCH",
                            "broker journal database ACL differs from its pinned preparation");
                    }
                    retainedMailbox = mailbox;
                    retainedJournalRoot = journalRoot;
                    retainedJournalDatabase = journalDatabase;
                    retainedAssembly = assembly;
                    baseline = acquired;
                    mailbox = null;
                    journalRoot = null;
                    journalDatabase = null;
                    assembly = null;
                }
                finally
                {
                    if (mailbox != null) mailbox.Dispose();
                    if (journalRoot != null) journalRoot.Dispose();
                    if (journalDatabase != null) journalDatabase.Dispose();
                    if (assembly != null) assembly.Dispose();
                }
            }

            internal Dictionary<string, object> Observed(string challengeSha256)
            {
                if (sequence != 0 || released)
                    throw new NativeFailure(
                        "BROKER_CONTEXT_STATE",
                        "broker storage observation state is invalid");
                sequence = 1;
                Dictionary<string, object> result = Frame(
                    ObservedKind,
                    challengeSha256,
                    null,
                    baseline);
                previousReceiptSha256 = (string)result["receiptSha256"];
                return result;
            }

            internal Dictionary<string, object> Acquired(string challengeSha256)
            {
                if (sequence != 0 || released)
                    throw new NativeFailure(
                        "BROKER_CONTEXT_STATE",
                        "broker context acquisition state is invalid");
                sequence = 1;
                Dictionary<string, object> result = Frame(
                    AcquiredKind,
                    challengeSha256,
                    null,
                    baseline);
                previousReceiptSha256 = (string)result["receiptSha256"];
                return result;
            }

            internal Dictionary<string, object> Advance(
                string kind,
                int requestedSequence,
                string challengeSha256,
                string requestedPreviousReceiptSha256)
            {
                if (released)
                    throw new NativeFailure(
                        "BROKER_CONTEXT_RELEASED",
                        "broker context channel was already released");
                if (requestedSequence != sequence + 1)
                    throw new NativeFailure(
                        "BROKER_CONTEXT_SEQUENCE",
                        "broker context frame sequence is not contiguous");
                if (!String.Equals(
                    requestedPreviousReceiptSha256,
                    previousReceiptSha256,
                    StringComparison.Ordinal))
                    throw new NativeFailure(
                        "BROKER_CONTEXT_RECEIPT_CHAIN",
                        "broker context frame does not extend the receipt chain");
                if (!challenges.Add(challengeSha256))
                    throw new NativeFailure(
                        "BROKER_CONTEXT_CHALLENGE_REPLAY",
                        "broker context challenge was replayed");

                Snapshot current;
                using (SafeFileHandle reopenedMailbox =
                    OpenDirectoryWithoutReparse(mailboxPath, "broker mailbox"))
                using (SafeFileHandle reopenedJournalRoot =
                    OpenDirectoryWithoutReparse(journalRootPath, "broker journal root"))
                using (SafeFileHandle reopenedJournalDatabase =
                    OpenJournalDatabase(reopenedJournalRoot))
                {
                    AssertDisjointRootHandles(reopenedMailbox, reopenedJournalRoot);
                    current = Observe(
                        reopenedMailbox,
                        reopenedJournalRoot,
                        reopenedJournalDatabase,
                        retainedAssembly,
                        mailboxPath,
                        journalRootPath);
                    AssertSnapshotUnchanged(baseline, current);
                    AssertRetainedHandles();
                }

                sequence = requestedSequence;
                Dictionary<string, object> result = Frame(
                    kind,
                    challengeSha256,
                    requestedPreviousReceiptSha256,
                    current);
                previousReceiptSha256 = (string)result["receiptSha256"];
                if (kind == ReleasedKind)
                {
                    released = true;
                    CloseRetained();
                }
                return result;
            }

            private void AssertRetainedHandles()
            {
                if (retainedMailbox == null || retainedMailbox.IsClosed || retainedMailbox.IsInvalid)
                    throw new NativeFailure(
                        "BROKER_CONTEXT_HANDLE_LOST",
                        "retained broker mailbox handle is unavailable");
                RequirePlainDirectory(retainedMailbox, "broker mailbox");
                string retainedIdentity = FormatObjectIdentity(
                    GetFileId(retainedMailbox, "broker mailbox"));
                if (!String.Equals(
                    retainedIdentity,
                    baseline.MailboxObjectIdentity,
                    StringComparison.Ordinal))
                    throw new NativeFailure(
                        "BROKER_CONTEXT_OBJECT_CHANGED",
                        "retained broker mailbox object identity changed");
                if (retainedJournalRoot == null || retainedJournalRoot.IsClosed ||
                    retainedJournalRoot.IsInvalid)
                    throw new NativeFailure(
                        "BROKER_CONTEXT_HANDLE_LOST",
                        "retained broker journal root handle is unavailable");
                RequirePlainDirectory(retainedJournalRoot, "broker journal root");
                string retainedJournalRootIdentity =
                    FormatObjectIdentity(GetFileId(retainedJournalRoot, "broker journal root"));
                if (!String.Equals(
                    retainedJournalRootIdentity,
                    baseline.JournalRootObjectIdentity,
                    StringComparison.Ordinal))
                    throw new NativeFailure(
                        "BROKER_CONTEXT_JOURNAL_ROOT_CHANGED",
                        "retained broker journal root object identity changed");
                if (retainedJournalDatabase == null || retainedJournalDatabase.IsClosed ||
                    retainedJournalDatabase.IsInvalid)
                    throw new NativeFailure(
                        "BROKER_CONTEXT_HANDLE_LOST",
                        "retained broker journal database handle is unavailable");
                RequirePlainFile(retainedJournalDatabase, "broker journal database");
                string retainedJournalDatabaseIdentity =
                    FormatObjectIdentity(GetFileId(
                        retainedJournalDatabase,
                        "broker journal database"));
                if (!String.Equals(
                    retainedJournalDatabaseIdentity,
                    baseline.JournalDatabaseObjectIdentity,
                    StringComparison.Ordinal))
                    throw new NativeFailure(
                        "BROKER_CONTEXT_JOURNAL_DATABASE_CHANGED",
                        "retained broker journal database object identity changed");
            }

            private Dictionary<string, object> Frame(
                string kind,
                string challengeSha256,
                string previous,
                Snapshot snapshot)
            {
                string receiptSha256 = Protocol.HashFramed(
                    "enduragent.windows-host-native-broker-context-receipt.v1",
                    kind,
                    sequence.ToString(CultureInfo.InvariantCulture),
                    challengeSha256,
                    previous ?? "",
                    snapshot.NativeObservationSha256);
                return Protocol.Object(
                    "protocolVersion", Protocol.Version,
                    "kind", kind,
                    "sequence", sequence,
                    "challengeSha256", challengeSha256,
                    "previousReceiptSha256", previous,
                    "mailboxSecurityProfile", SecurityProfile,
                    "nativeHelperSha256", snapshot.NativeHelperSha256,
                    "mailboxRequestedPathSha256", snapshot.MailboxRequestedPathSha256,
                    "mailboxPathSha256", snapshot.MailboxPathSha256,
                    "mailboxRootObjectIdentitySha256", snapshot.MailboxRootObjectIdentitySha256,
                    "mailboxVolumeIdSha256", snapshot.MailboxVolumeIdSha256,
                    "mailboxOwnerSidSha256", snapshot.MailboxOwnerSidSha256,
                    "mailboxAclSha256", snapshot.MailboxAclSha256,
                    "processSidSha256", snapshot.ProcessSidSha256,
                    "authenticationLuidSha256", snapshot.AuthenticationLuidSha256,
                    "bootIdSha256", snapshot.BootIdSha256,
                    "runnerSessionIdSha256", snapshot.RunnerSessionIdSha256,
                    "mailboxTransportIdentitySha256", snapshot.MailboxTransportIdentitySha256,
                    "mailboxFileSystem", "NTFS",
                    "mailboxDriveType", "fixed",
                    "mailboxLocalAbsolute", true,
                    "mailboxNetworkPath", false,
                    "mailboxReparsePoint", false,
                    "journalSecurityProfile", JournalSecurityProfile,
                    "journalRootRequestedPathSha256",
                        snapshot.JournalRootRequestedPathSha256,
                    "journalRootPathSha256", snapshot.JournalRootPathSha256,
                    "journalRootObjectIdentitySha256",
                        snapshot.JournalRootObjectIdentitySha256,
                    "journalVolumeIdSha256", snapshot.JournalVolumeIdSha256,
                    "journalRootOwnerSidSha256", snapshot.JournalRootOwnerSidSha256,
                    "journalRootAclSha256", snapshot.JournalRootAclSha256,
                    "journalDatabasePathSha256", snapshot.JournalDatabasePathSha256,
                    "journalDatabaseObjectIdentitySha256",
                        snapshot.JournalDatabaseObjectIdentitySha256,
                    "journalDatabaseOwnerSidSha256",
                        snapshot.JournalDatabaseOwnerSidSha256,
                    "journalDatabaseAclSha256", snapshot.JournalDatabaseAclSha256,
                    "journalTransportIdentitySha256",
                        snapshot.JournalTransportIdentitySha256,
                    "journalFileSystem", "NTFS",
                    "journalDriveType", "fixed",
                    "journalLocalAbsolute", true,
                    "journalNetworkPath", false,
                    "journalReparsePoint", false,
                    "interactiveSessionActive", true,
                    "nativeObservationSha256", snapshot.NativeObservationSha256,
                    "receiptSha256", receiptSha256);
            }

            private void CloseRetained()
            {
                SafeFileHandle mailbox = retainedMailbox;
                SafeFileHandle journalRoot = retainedJournalRoot;
                SafeFileHandle journalDatabase = retainedJournalDatabase;
                SafeFileHandle assembly = retainedAssembly;
                retainedMailbox = null;
                retainedJournalRoot = null;
                retainedJournalDatabase = null;
                retainedAssembly = null;
                if (mailbox != null) mailbox.Dispose();
                if (journalRoot != null) journalRoot.Dispose();
                if (assembly != null) assembly.Dispose();
                if (journalDatabase != null) journalDatabase.Dispose();
            }

            public void Dispose()
            {
                CloseRetained();
                baseline = null;
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleEx(
            SafeFileHandle file,
            int informationClass,
            out FILE_ATTRIBUTE_TAG_INFO information,
            uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleEx(
            SafeFileHandle file,
            int informationClass,
            out FILE_ID_INFO information,
            uint bufferSize);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle file,
            StringBuilder path,
            uint pathLength,
            uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FlushFileBuffers(SafeFileHandle file);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetVolumeInformationByHandleW(
            SafeFileHandle file,
            StringBuilder volumeName,
            uint volumeNameSize,
            out uint volumeSerialNumber,
            out uint maximumComponentLength,
            out uint fileSystemFlags,
            StringBuilder fileSystemName,
            uint fileSystemNameSize);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern uint GetDriveTypeW(string rootPathName);

        [DllImport("ntdll.dll")]
        private static extern int NtCreateFile(
            out IntPtr fileHandle,
            uint desiredAccess,
            ref OBJECT_ATTRIBUTES objectAttributes,
            out IO_STATUS_BLOCK ioStatusBlock,
            IntPtr allocationSize,
            uint fileAttributes,
            uint shareAccess,
            uint createDisposition,
            uint createOptions,
            IntPtr eaBuffer,
            uint eaLength);

        [DllImport("ntdll.dll")]
        private static extern uint RtlNtStatusToDosError(int status);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern uint GetSecurityInfo(
            SafeFileHandle handle,
            int objectType,
            uint securityInformation,
            out IntPtr owner,
            out IntPtr group,
            out IntPtr dacl,
            out IntPtr sacl,
            out IntPtr securityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetKernelObjectSecurity(
            IntPtr handle,
            uint securityInformation,
            byte[] securityDescriptor);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
            IntPtr securityDescriptor,
            uint requestedRevision,
            uint securityInformation,
            out IntPtr stringSecurityDescriptor,
            out uint stringLength);

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
        private static extern IntPtr GetModuleHandleW(string moduleName);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
        private static extern IntPtr GetProcAddress(IntPtr module, string procedureName);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        internal static int Run()
        {
            return Run(false);
        }

        internal static int ObserveOnce()
        {
            return Run(true);
        }

        private static int Run(bool observationOnly)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new NativeFailure(
                    "NATIVE_PLATFORM",
                    "broker context channel requires Windows");
            if (!Environment.Is64BitProcess)
                throw new NativeFailure(
                    "NATIVE_ARCHITECTURE",
                    "broker context channel requires x64");

            Stream input = Console.OpenStandardInput();
            Dictionary<string, object> initial =
                Protocol.ReadStandaloneObject(input, "broker context init frame");
            if (initial == null)
                throw new NativeFailure(
                    "BROKER_CONTEXT_EOF",
                    "broker context channel ended before initialization");
            Protocol.RequireExactKeys(
                initial,
                new string[] {
                    "protocolVersion", "kind", "sequence", "challengeSha256",
                    "previousReceiptSha256", "mailboxPath", "mailboxSecurityProfile",
                    "expectedMailboxAclSha256", "journalRoot", "journalSecurityProfile",
                    "expectedJournalRootAclSha256", "expectedJournalDatabaseAclSha256"
                },
                "broker context init frame");
            RequireProtocolVersion(initial);
            if (!String.Equals(
                Protocol.RequireString(initial, "kind", 4, 32),
                observationOnly ? "observe" : "init",
                StringComparison.Ordinal) ||
                Protocol.RequireInt(initial, "sequence", 1, Int32.MaxValue) != 1)
                throw new NativeFailure(
                    "BROKER_CONTEXT_INIT",
                    "broker context initialization frame is invalid");
            if (initial["previousReceiptSha256"] != null)
                throw new NativeFailure(
                    "BROKER_CONTEXT_RECEIPT_CHAIN",
                    "broker context initialization cannot extend a prior receipt");
            string challengeSha256 = Protocol.RequireLowerHex64(initial, "challengeSha256");
            string mailboxPath = Protocol.RequireString(initial, "mailboxPath", 4, 32767);
            string profile = Protocol.RequireString(
                initial,
                "mailboxSecurityProfile",
                SecurityProfile.Length,
                SecurityProfile.Length);
            if (!String.Equals(profile, SecurityProfile, StringComparison.Ordinal))
                throw new NativeFailure(
                    "BROKER_CONTEXT_SECURITY_PROFILE",
                    "broker mailbox security profile is unsupported");
            string expectedAclSha256 =
                Protocol.RequireLowerHex64(initial, "expectedMailboxAclSha256");
            string journalRoot = Protocol.RequireString(initial, "journalRoot", 4, 32767);
            string journalProfile = Protocol.RequireString(
                initial,
                "journalSecurityProfile",
                JournalSecurityProfile.Length,
                JournalSecurityProfile.Length);
            if (!String.Equals(
                journalProfile,
                JournalSecurityProfile,
                StringComparison.Ordinal))
                throw new NativeFailure(
                    "BROKER_CONTEXT_JOURNAL_SECURITY_PROFILE",
                    "broker journal security profile is unsupported");
            string expectedJournalRootAclSha256 =
                Protocol.RequireLowerHex64(initial, "expectedJournalRootAclSha256");
            string expectedJournalDatabaseAclSha256 =
                Protocol.RequireLowerHex64(initial, "expectedJournalDatabaseAclSha256");

            using (ChannelState state = new ChannelState(
                mailboxPath,
                journalRoot,
                expectedAclSha256,
                expectedJournalRootAclSha256,
                expectedJournalDatabaseAclSha256,
                challengeSha256,
                observationOnly))
            {
                if (observationOnly)
                {
                    Protocol.WriteStandalone(state.Observed(challengeSha256));
                    return 0;
                }
                Protocol.WriteStandalone(state.Acquired(challengeSha256));
                while (true)
                {
                    Dictionary<string, object> frame =
                        Protocol.ReadStandaloneObject(input, "broker context control frame");
                    if (frame == null)
                        throw new NativeFailure(
                            "BROKER_CONTEXT_EOF",
                            "broker context channel ended before release");
                    Protocol.RequireExactKeys(
                        frame,
                        new string[] {
                            "protocolVersion", "kind", "sequence", "challengeSha256",
                            "previousReceiptSha256"
                        },
                        "broker context control frame");
                    RequireProtocolVersion(frame);
                    string kind = Protocol.RequireString(frame, "kind", 7, 32);
                    string outputKind;
                    if (kind == "revalidate") outputKind = RevalidatedKind;
                    else if (kind == "release") outputKind = ReleasedKind;
                    else
                        throw new NativeFailure(
                            "BROKER_CONTEXT_COMMAND",
                            "broker context command is not allowlisted");
                    int nextSequence = Protocol.RequireInt(
                        frame,
                        "sequence",
                        2,
                        Int32.MaxValue);
                    string nextChallenge =
                        Protocol.RequireLowerHex64(frame, "challengeSha256");
                    string previous =
                        Protocol.RequireLowerHex64(frame, "previousReceiptSha256");
                    Dictionary<string, object> result = state.Advance(
                        outputKind,
                        nextSequence,
                        nextChallenge,
                        previous);
                    Protocol.WriteStandalone(result);
                    if (kind == "release") return 0;
                }
            }
        }

        private static void RequireProtocolVersion(Dictionary<string, object> frame)
        {
            if (Protocol.RequireInt(frame, "protocolVersion", 1, 1) != Protocol.Version)
                throw new NativeFailure(
                    "PROTOCOL_VERSION",
                    "unsupported broker context protocol version");
        }

        private static string ValidateStoragePath(string value, string label, string code)
        {
            if (String.IsNullOrEmpty(value) ||
                value.Length > 32767 ||
                value.IndexOf('\0') >= 0 ||
                value.Length < 4 ||
                value[0] < 'A' ||
                value[0] > 'Z' ||
                value[1] != ':' ||
                value[2] != '\\' ||
                value.IndexOf('/') >= 0 ||
                value.StartsWith("\\\\", StringComparison.Ordinal) ||
                !String.Equals(
                    value,
                    value.Normalize(NormalizationForm.FormC),
                    StringComparison.Ordinal))
                throw new NativeFailure(
                    code,
                    label + " path is not a canonical local-drive path");
            string full = Path.GetFullPath(value).TrimEnd('\\');
            if (!String.Equals(full, value, StringComparison.Ordinal))
                throw new NativeFailure(
                    code,
                    label + " path is not canonical");
            string[] components = value.Substring(3).Split(new char[] { '\\' });
            if (components.Length == 0)
                throw new NativeFailure(
                    code,
                    label + " path has no directory component");
            foreach (string component in components)
            {
                if (component.Length == 0 ||
                    component == "." ||
                    component == ".." ||
                    component.EndsWith(".", StringComparison.Ordinal) ||
                    component.EndsWith(" ", StringComparison.Ordinal) ||
                    component.IndexOf(':') >= 0 ||
                    ContainsUnsafePathCharacter(component) ||
                    IsReservedDosComponent(component))
                    throw new NativeFailure(
                        code,
                        label + " path contains an unsafe component");
            }
            return value;
        }

        private static bool ContainsUnsafePathCharacter(string component)
        {
            foreach (char character in component)
            {
                if (character < 0x20 ||
                    character == '<' ||
                    character == '>' ||
                    character == '"' ||
                    character == '|' ||
                    character == '?' ||
                    character == '*')
                    return true;
            }
            return false;
        }

        private static bool IsReservedDosComponent(string component)
        {
            int extension = component.IndexOf('.');
            string stem = (extension < 0 ? component : component.Substring(0, extension))
                .ToUpperInvariant();
            if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
                stem == "CLOCK$" || stem == "CONIN$" || stem == "CONOUT$")
                return true;
            if (stem.Length == 4 &&
                (stem.StartsWith("COM", StringComparison.Ordinal) ||
                    stem.StartsWith("LPT", StringComparison.Ordinal)) &&
                stem[3] >= '1' && stem[3] <= '9')
                return true;
            return false;
        }

        private static void AssertDisjointRoots(string mailboxPath, string journalPath)
        {
            string mailbox = mailboxPath.TrimEnd('\\');
            string journal = journalPath.TrimEnd('\\');
            if (String.Equals(mailbox, journal, StringComparison.OrdinalIgnoreCase) ||
                mailbox.StartsWith(journal + "\\", StringComparison.OrdinalIgnoreCase) ||
                journal.StartsWith(mailbox + "\\", StringComparison.OrdinalIgnoreCase))
                throw new NativeFailure(
                    "BROKER_CONTEXT_ROOT_OVERLAP",
                    "broker mailbox and journal roots must be disjoint");
        }

        private static void AssertDisjointRootHandles(
            SafeFileHandle mailbox,
            SafeFileHandle journalRoot)
        {
            string mailboxFinal = GetFinalVolumePath(mailbox, "broker mailbox");
            string journalFinal = GetFinalVolumePath(journalRoot, "broker journal root");
            AssertDisjointRoots(mailboxFinal, journalFinal);
            string mailboxIdentity = FormatObjectIdentity(
                GetFileId(mailbox, "broker mailbox"));
            string journalIdentity = FormatObjectIdentity(
                GetFileId(journalRoot, "broker journal root"));
            if (String.Equals(mailboxIdentity, journalIdentity, StringComparison.Ordinal))
                throw new NativeFailure(
                    "BROKER_CONTEXT_ROOT_OVERLAP",
                    "broker mailbox and journal roots identify the same object");
        }

        private static SafeFileHandle OpenDirectoryWithoutReparse(string path, string label)
        {
            string rootPath = path.Substring(0, 3);
            if (GetDriveTypeW(rootPath) != DriveFixed)
                throw new NativeFailure(
                    "BROKER_CONTEXT_STORAGE",
                    label + " is not on fixed local storage");
            SafeFileHandle current = CreateFileW(
                rootPath,
                FileReadAttributes | ReadControl | Synchronize,
                ShareRead | ShareWrite,
                IntPtr.Zero,
                OpenExisting,
                FileFlagBackupSemantics | FileFlagOpenReparsePoint,
                IntPtr.Zero);
            if (current.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                current.Dispose();
                throw new NativeFailure(
                    "BROKER_CONTEXT_OPEN_FAILED",
                    label + " volume root could not be opened",
                    code);
            }
            try
            {
                RequirePlainDirectory(current, label + " volume root");
                string[] components = path.Substring(3).Split(new char[] { '\\' });
                foreach (string component in components)
                {
                    SafeFileHandle next = NtOpenDirectoryRelative(current, component, label);
                    current.Dispose();
                    current = next;
                }
                SafeFileHandle result = current;
                current = null;
                return result;
            }
            finally
            {
                if (current != null) current.Dispose();
            }
        }

        private static SafeFileHandle NtOpenDirectoryRelative(
            SafeFileHandle parent,
            string component,
            string label)
        {
            IntPtr buffer = Marshal.StringToHGlobalUni(component);
            IntPtr unicodePointer = IntPtr.Zero;
            try
            {
                UNICODE_STRING unicode = new UNICODE_STRING
                {
                    Length = checked((ushort)(component.Length * 2)),
                    MaximumLength = checked((ushort)((component.Length + 1) * 2)),
                    Buffer = buffer
                };
                unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
                Marshal.StructureToPtr(unicode, unicodePointer, false);
                OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES
                {
                    Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
                    RootDirectory = parent.DangerousGetHandle(),
                    ObjectName = unicodePointer,
                    Attributes = ObjectCaseInsensitive,
                    SecurityDescriptor = IntPtr.Zero,
                    SecurityQualityOfService = IntPtr.Zero
                };
                IO_STATUS_BLOCK statusBlock;
                IntPtr raw;
                int status = NtCreateFile(
                    out raw,
                    FileReadAttributes | ReadControl | Synchronize,
                    ref attributes,
                    out statusBlock,
                    IntPtr.Zero,
                    0,
                    ShareRead | ShareWrite,
                    NtFileOpen,
                    FileDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert,
                    IntPtr.Zero,
                    0);
                if (status < 0)
                    throw new NativeFailure(
                        "BROKER_CONTEXT_OPEN_FAILED",
                        label + " path component could not be opened",
                        checked((int)RtlNtStatusToDosError(status)));
                SafeFileHandle handle = new SafeFileHandle(raw, true);
                try
                {
                    RequirePlainDirectory(handle, label);
                    SafeFileHandle result = handle;
                    handle = null;
                    return result;
                }
                finally
                {
                    if (handle != null) handle.Dispose();
                }
            }
            finally
            {
                if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static SafeFileHandle OpenOrCreateJournalDatabase(
            SafeFileHandle journalRoot)
        {
            bool created;
            SafeFileHandle database = NtOpenFileRelative(
                journalRoot,
                JournalDatabaseLeaf,
                true,
                out created);
            try
            {
                if (created)
                {
                    ApplyExactJournalDatabaseSecurity(database);
                    if (!FlushFileBuffers(database))
                        ThrowWin32(
                            "BROKER_CONTEXT_JOURNAL_DATABASE_FLUSH",
                            "new broker journal database could not be flushed");
                }
                RequirePlainFile(database, "broker journal database");
                SafeFileHandle result = database;
                database = null;
                return result;
            }
            finally
            {
                if (database != null) database.Dispose();
            }
        }

        private static SafeFileHandle OpenJournalDatabase(SafeFileHandle journalRoot)
        {
            bool created;
            SafeFileHandle database = NtOpenFileRelative(
                journalRoot,
                JournalDatabaseLeaf,
                false,
                out created);
            if (created)
            {
                database.Dispose();
                throw new NativeFailure(
                    "BROKER_CONTEXT_JOURNAL_DATABASE_CHANGED",
                    "broker journal database disappeared while authority was live");
            }
            return database;
        }

        private static SafeFileHandle NtOpenFileRelative(
            SafeFileHandle parent,
            string component,
            bool createIfMissing,
            out bool created)
        {
            IntPtr buffer = Marshal.StringToHGlobalUni(component);
            IntPtr unicodePointer = IntPtr.Zero;
            try
            {
                UNICODE_STRING unicode = new UNICODE_STRING
                {
                    Length = checked((ushort)(component.Length * 2)),
                    MaximumLength = checked((ushort)((component.Length + 1) * 2)),
                    Buffer = buffer
                };
                unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
                Marshal.StructureToPtr(unicode, unicodePointer, false);
                OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES
                {
                    Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
                    RootDirectory = parent.DangerousGetHandle(),
                    ObjectName = unicodePointer,
                    Attributes = ObjectCaseInsensitive,
                    SecurityDescriptor = IntPtr.Zero,
                    SecurityQualityOfService = IntPtr.Zero
                };
                IO_STATUS_BLOCK statusBlock;
                IntPtr raw;
                int status = NtCreateFile(
                    out raw,
                    GenericRead | GenericWrite | ReadControl | WriteDac | WriteOwner |
                        Synchronize,
                    ref attributes,
                    out statusBlock,
                    IntPtr.Zero,
                    FileAttributeNormal,
                    ShareRead | ShareWrite,
                    createIfMissing ? NtFileOpenIf : NtFileOpen,
                    FileNonDirectoryFile | FileOpenReparsePoint |
                        FileSynchronousIoNonAlert,
                    IntPtr.Zero,
                    0);
                if (status < 0)
                    throw new NativeFailure(
                        "BROKER_CONTEXT_JOURNAL_DATABASE_OPEN",
                        "broker journal database could not be opened",
                        checked((int)RtlNtStatusToDosError(status)));
                created = statusBlock.Information.ToUInt64() == 2;
                SafeFileHandle handle = new SafeFileHandle(raw, true);
                try
                {
                    RequirePlainFile(handle, "broker journal database");
                    SafeFileHandle result = handle;
                    handle = null;
                    return result;
                }
                finally
                {
                    if (handle != null) handle.Dispose();
                }
            }
            finally
            {
                if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static void ApplyExactJournalDatabaseSecurity(SafeFileHandle handle)
        {
            string currentSid;
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query))
            {
                if (identity.User == null)
                    throw new NativeFailure(
                        "BROKER_CONTEXT_PROCESS_IDENTITY",
                        "broker process identity is unavailable");
                currentSid = identity.User.Value;
            }
            RawSecurityDescriptor raw = new RawSecurityDescriptor(
                "O:" + currentSid +
                "D:P(A;;FA;;;" + currentSid + ")" +
                "(A;;FA;;;SY)(A;;FA;;;BA)");
            byte[] descriptor = new byte[raw.BinaryLength];
            raw.GetBinaryForm(descriptor, 0);
            if (!SetKernelObjectSecurity(
                handle.DangerousGetHandle(),
                OwnerSecurityInformation | DaclSecurityInformation |
                    ProtectedDaclSecurityInformation,
                descriptor))
                ThrowWin32(
                    "BROKER_CONTEXT_JOURNAL_DATABASE_SECURITY",
                    "broker journal database security could not be initialized");
        }

        private static SafeFileHandle OpenAssemblyHold()
        {
            string path = Assembly.GetExecutingAssembly().Location;
            SafeFileHandle handle = CreateFileW(
                path,
                GenericRead,
                ShareRead,
                IntPtr.Zero,
                OpenExisting,
                FileAttributeNormal | FileFlagOpenReparsePoint,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new NativeFailure(
                    "BROKER_CONTEXT_HELPER_HOLD",
                    "broker context helper identity could not be retained",
                    code);
            }
            return handle;
        }

        private static Snapshot Observe(
            SafeFileHandle mailbox,
            SafeFileHandle journalRoot,
            SafeFileHandle journalDatabase,
            SafeFileHandle assembly,
            string mailboxRequestedPath,
            string journalRootRequestedPath)
        {
            if (mailbox == null || mailbox.IsInvalid || mailbox.IsClosed ||
                journalRoot == null || journalRoot.IsInvalid || journalRoot.IsClosed ||
                journalDatabase == null || journalDatabase.IsInvalid ||
                journalDatabase.IsClosed ||
                assembly == null || assembly.IsInvalid || assembly.IsClosed)
                throw new NativeFailure(
                    "BROKER_CONTEXT_HANDLE_LOST",
                    "broker context retained handle is unavailable");
            RequirePlainDirectory(mailbox, "broker mailbox");
            RequirePlainDirectory(journalRoot, "broker journal root");
            RequirePlainFile(journalDatabase, "broker journal database");
            AssertDisjointRootHandles(mailbox, journalRoot);
            string mailboxFileSystem = FileSystemName(mailbox, "broker mailbox");
            string journalFileSystem = FileSystemName(journalRoot, "broker journal root");
            if (!String.Equals(mailboxFileSystem, "NTFS", StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(journalFileSystem, "NTFS", StringComparison.OrdinalIgnoreCase))
                throw new NativeFailure(
                    "BROKER_CONTEXT_FILE_SYSTEM",
                    "broker mailbox and journal storage must be on NTFS");
            string mailboxFinalPath = GetFinalVolumePath(mailbox, "broker mailbox");
            string mailboxObjectIdentity = FormatObjectIdentity(
                GetFileId(mailbox, "broker mailbox"));
            string mailboxVolumeIdentity = VolumeIdentity(
                mailbox,
                mailboxFinalPath,
                mailboxFileSystem,
                "broker mailbox");
            string journalRootFinalPath = GetFinalVolumePath(
                journalRoot,
                "broker journal root");
            string journalRootObjectIdentity = FormatObjectIdentity(
                GetFileId(journalRoot, "broker journal root"));
            string journalVolumeIdentity = VolumeIdentity(
                journalRoot,
                journalRootFinalPath,
                journalFileSystem,
                "broker journal root");
            string journalDatabaseFinalPath = GetFinalVolumePath(
                journalDatabase,
                "broker journal database");
            AssertDirectChild(
                journalRootFinalPath,
                journalDatabaseFinalPath,
                JournalDatabaseLeaf);
            string journalDatabaseObjectIdentity = FormatObjectIdentity(
                GetFileId(journalDatabase, "broker journal database"));

            string processSid;
            string authenticationLuid;
            string runnerSessionIdentity;
            ObserveProcessSession(
                out processSid,
                out authenticationLuid,
                out runnerSessionIdentity);
            string mailboxOwnerSid;
            string mailboxSddl;
            ObserveExactSecurity(
                mailbox,
                processSid,
                true,
                "broker mailbox",
                out mailboxOwnerSid,
                out mailboxSddl);
            string journalRootOwnerSid;
            string journalRootSddl;
            ObserveExactSecurity(
                journalRoot,
                processSid,
                true,
                "broker journal root",
                out journalRootOwnerSid,
                out journalRootSddl);
            string journalDatabaseOwnerSid;
            string journalDatabaseSddl;
            ObserveExactSecurity(
                journalDatabase,
                processSid,
                false,
                "broker journal database",
                out journalDatabaseOwnerSid,
                out journalDatabaseSddl);
            string mailboxAclSha256 = Protocol.Sha256(mailboxSddl);
            string mailboxRequestedPathSha256 = Protocol.Sha256(mailboxRequestedPath);
            string mailboxPathSha256 = Protocol.Sha256(mailboxFinalPath);
            string mailboxObjectSha256 = Protocol.Sha256(mailboxObjectIdentity);
            string mailboxVolumeSha256 = Protocol.Sha256(mailboxVolumeIdentity);
            string processSidSha256 = Protocol.Sha256(processSid);
            string mailboxOwnerSidSha256 = Protocol.Sha256(mailboxOwnerSid);
            string journalRootRequestedPathSha256 =
                Protocol.Sha256(journalRootRequestedPath);
            string journalRootPathSha256 = Protocol.Sha256(journalRootFinalPath);
            string journalRootObjectSha256 = Protocol.Sha256(journalRootObjectIdentity);
            string journalVolumeSha256 = Protocol.Sha256(journalVolumeIdentity);
            string journalRootOwnerSidSha256 = Protocol.Sha256(journalRootOwnerSid);
            string journalRootAclSha256 = Protocol.Sha256(journalRootSddl);
            string journalDatabasePathSha256 = Protocol.Sha256(journalDatabaseFinalPath);
            string journalDatabaseObjectSha256 =
                Protocol.Sha256(journalDatabaseObjectIdentity);
            string journalDatabaseOwnerSidSha256 =
                Protocol.Sha256(journalDatabaseOwnerSid);
            string journalDatabaseAclSha256 = Protocol.Sha256(journalDatabaseSddl);
            string authenticationLuidSha256 = Protocol.HashFramed(
                "enduragent.windows-host-authentication-luid.v1",
                authenticationLuid);
            string bootIdentity = BootIdentity();
            string bootIdSha256 = Protocol.HashFramed(
                "enduragent.windows-host-boot-identity.v1",
                bootIdentity);
            string runnerSessionIdSha256 = Protocol.HashFramed(
                "enduragent.windows-host-runner-session-identity.v1",
                processSid,
                Process.GetCurrentProcess().SessionId.ToString(CultureInfo.InvariantCulture),
                authenticationLuid,
                "WTSActive");
            string helperSha256 = AssemblySha256(assembly);
            string transportIdentitySha256 = Protocol.HashFramed(
                "enduragent.windows-host-broker-mailbox-transport.v1",
                mailboxPathSha256,
                mailboxObjectSha256,
                mailboxVolumeSha256,
                mailboxAclSha256);
            string journalTransportIdentitySha256 = Protocol.HashFramed(
                "enduragent.windows-host-broker-journal-transport.v1",
                journalRootPathSha256,
                journalRootObjectSha256,
                journalVolumeSha256,
                journalRootAclSha256,
                journalDatabasePathSha256,
                journalDatabaseObjectSha256,
                journalDatabaseAclSha256);
            string observationSha256 = Protocol.HashFramed(
                "enduragent.windows-host-native-broker-context-observation.v1",
                SecurityProfile,
                helperSha256,
                mailboxRequestedPathSha256,
                mailboxPathSha256,
                mailboxObjectSha256,
                mailboxVolumeSha256,
                mailboxOwnerSidSha256,
                mailboxAclSha256,
                processSidSha256,
                authenticationLuidSha256,
                bootIdSha256,
                runnerSessionIdSha256,
                transportIdentitySha256,
                "NTFS",
                "fixed",
                "true",
                "false",
                "false",
                JournalSecurityProfile,
                journalRootRequestedPathSha256,
                journalRootPathSha256,
                journalRootObjectSha256,
                journalVolumeSha256,
                journalRootOwnerSidSha256,
                journalRootAclSha256,
                journalDatabasePathSha256,
                journalDatabaseObjectSha256,
                journalDatabaseOwnerSidSha256,
                journalDatabaseAclSha256,
                journalTransportIdentitySha256,
                "NTFS",
                "fixed",
                "true",
                "false",
                "false",
                "true");
            return new Snapshot
            {
                MailboxRequestedPathSha256 = mailboxRequestedPathSha256,
                MailboxFinalPath = mailboxFinalPath,
                MailboxPathSha256 = mailboxPathSha256,
                MailboxObjectIdentity = mailboxObjectIdentity,
                MailboxRootObjectIdentitySha256 = mailboxObjectSha256,
                MailboxVolumeIdentity = mailboxVolumeIdentity,
                MailboxVolumeIdSha256 = mailboxVolumeSha256,
                MailboxOwnerSid = mailboxOwnerSid,
                MailboxOwnerSidSha256 = mailboxOwnerSidSha256,
                MailboxSddl = mailboxSddl,
                MailboxAclSha256 = mailboxAclSha256,
                JournalRootRequestedPathSha256 = journalRootRequestedPathSha256,
                JournalRootFinalPath = journalRootFinalPath,
                JournalRootPathSha256 = journalRootPathSha256,
                JournalRootObjectIdentity = journalRootObjectIdentity,
                JournalRootObjectIdentitySha256 = journalRootObjectSha256,
                JournalVolumeIdentity = journalVolumeIdentity,
                JournalVolumeIdSha256 = journalVolumeSha256,
                JournalRootOwnerSid = journalRootOwnerSid,
                JournalRootOwnerSidSha256 = journalRootOwnerSidSha256,
                JournalRootSddl = journalRootSddl,
                JournalRootAclSha256 = journalRootAclSha256,
                JournalDatabaseFinalPath = journalDatabaseFinalPath,
                JournalDatabasePathSha256 = journalDatabasePathSha256,
                JournalDatabaseObjectIdentity = journalDatabaseObjectIdentity,
                JournalDatabaseObjectIdentitySha256 = journalDatabaseObjectSha256,
                JournalDatabaseOwnerSid = journalDatabaseOwnerSid,
                JournalDatabaseOwnerSidSha256 = journalDatabaseOwnerSidSha256,
                JournalDatabaseSddl = journalDatabaseSddl,
                JournalDatabaseAclSha256 = journalDatabaseAclSha256,
                ProcessSid = processSid,
                ProcessSidSha256 = processSidSha256,
                AuthenticationLuid = authenticationLuid,
                AuthenticationLuidSha256 = authenticationLuidSha256,
                BootIdentity = bootIdentity,
                BootIdSha256 = bootIdSha256,
                RunnerSessionIdentity = runnerSessionIdentity,
                RunnerSessionIdSha256 = runnerSessionIdSha256,
                NativeHelperSha256 = helperSha256,
                MailboxTransportIdentitySha256 = transportIdentitySha256,
                JournalTransportIdentitySha256 = journalTransportIdentitySha256,
                NativeObservationSha256 = observationSha256
            };
        }

        private static void AssertSnapshotUnchanged(Snapshot expected, Snapshot actual)
        {
            if (!String.Equals(expected.MailboxRequestedPathSha256, actual.MailboxRequestedPathSha256, StringComparison.Ordinal) ||
                !String.Equals(expected.MailboxFinalPath, actual.MailboxFinalPath, StringComparison.Ordinal) ||
                !String.Equals(expected.MailboxObjectIdentity, actual.MailboxObjectIdentity, StringComparison.Ordinal) ||
                !String.Equals(expected.MailboxVolumeIdentity, actual.MailboxVolumeIdentity, StringComparison.Ordinal) ||
                !String.Equals(expected.MailboxOwnerSid, actual.MailboxOwnerSid, StringComparison.Ordinal) ||
                !String.Equals(expected.MailboxSddl, actual.MailboxSddl, StringComparison.Ordinal) ||
                !String.Equals(expected.JournalRootRequestedPathSha256, actual.JournalRootRequestedPathSha256, StringComparison.Ordinal) ||
                !String.Equals(expected.JournalRootFinalPath, actual.JournalRootFinalPath, StringComparison.Ordinal) ||
                !String.Equals(expected.JournalRootObjectIdentity, actual.JournalRootObjectIdentity, StringComparison.Ordinal) ||
                !String.Equals(expected.JournalVolumeIdentity, actual.JournalVolumeIdentity, StringComparison.Ordinal) ||
                !String.Equals(expected.JournalRootOwnerSid, actual.JournalRootOwnerSid, StringComparison.Ordinal) ||
                !String.Equals(expected.JournalRootSddl, actual.JournalRootSddl, StringComparison.Ordinal) ||
                !String.Equals(expected.JournalDatabaseFinalPath, actual.JournalDatabaseFinalPath, StringComparison.Ordinal) ||
                !String.Equals(expected.JournalDatabaseObjectIdentity, actual.JournalDatabaseObjectIdentity, StringComparison.Ordinal) ||
                !String.Equals(expected.JournalDatabaseOwnerSid, actual.JournalDatabaseOwnerSid, StringComparison.Ordinal) ||
                !String.Equals(expected.JournalDatabaseSddl, actual.JournalDatabaseSddl, StringComparison.Ordinal) ||
                !String.Equals(expected.ProcessSid, actual.ProcessSid, StringComparison.Ordinal) ||
                !String.Equals(expected.AuthenticationLuid, actual.AuthenticationLuid, StringComparison.Ordinal) ||
                !String.Equals(expected.BootIdentity, actual.BootIdentity, StringComparison.Ordinal) ||
                !String.Equals(expected.RunnerSessionIdentity, actual.RunnerSessionIdentity, StringComparison.Ordinal) ||
                !String.Equals(expected.NativeHelperSha256, actual.NativeHelperSha256, StringComparison.Ordinal) ||
                !String.Equals(expected.NativeObservationSha256, actual.NativeObservationSha256, StringComparison.Ordinal))
                throw new NativeFailure(
                    "BROKER_CONTEXT_CHANGED",
                    "broker execution context changed while authority was live");
        }

        private static void AssertDirectChild(
            string parentFinalPath,
            string childFinalPath,
            string leaf)
        {
            string expected = parentFinalPath.TrimEnd('\\') + "\\" + leaf;
            if (!String.Equals(expected, childFinalPath, StringComparison.Ordinal))
                throw new NativeFailure(
                    "BROKER_CONTEXT_JOURNAL_DATABASE_PATH",
                    "broker journal database is not the fixed file under its pinned root");
        }

        private static void RequirePlainDirectory(SafeFileHandle handle, string label)
        {
            FILE_ATTRIBUTE_TAG_INFO information;
            if (!GetFileInformationByHandleEx(
                handle,
                FileAttributeTagInfo,
                out information,
                (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))))
                ThrowWin32(
                    "BROKER_CONTEXT_FILE_INFORMATION",
                    label + " attributes are unavailable");
            if ((information.FileAttributes & 0x10) == 0 ||
                (information.FileAttributes & 0x400) != 0 ||
                information.ReparseTag != 0)
                throw new NativeFailure(
                    "BROKER_CONTEXT_REPARSE",
                    label + " contains a reparse point or is not a directory");
        }

        private static void RequirePlainFile(SafeFileHandle handle, string label)
        {
            FILE_ATTRIBUTE_TAG_INFO information;
            if (!GetFileInformationByHandleEx(
                handle,
                FileAttributeTagInfo,
                out information,
                (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))))
                ThrowWin32(
                    "BROKER_CONTEXT_FILE_INFORMATION",
                    label + " attributes are unavailable");
            if ((information.FileAttributes & 0x10) != 0 ||
                (information.FileAttributes & 0x400) != 0 ||
                information.ReparseTag != 0)
                throw new NativeFailure(
                    "BROKER_CONTEXT_REPARSE",
                    label + " contains a reparse point or is not a file");
        }

        private static FILE_ID_INFO GetFileId(SafeFileHandle handle, string label)
        {
            FILE_ID_INFO information;
            if (!GetFileInformationByHandleEx(
                handle,
                FileIdInfo,
                out information,
                (uint)Marshal.SizeOf(typeof(FILE_ID_INFO))))
                ThrowWin32(
                    "BROKER_CONTEXT_FILE_ID",
                    label + " object identity is unavailable");
            if (information.FileId.Identifier == null ||
                information.FileId.Identifier.Length != 16)
                throw new NativeFailure(
                    "BROKER_CONTEXT_FILE_ID",
                    label + " object identity is invalid");
            return information;
        }

        private static string FormatObjectIdentity(FILE_ID_INFO identity)
        {
            return "file-v1:" + Protocol.HashFramed(
                "enduragent.windows-file-identity.v1",
                identity.VolumeSerialNumber.ToString("x16", CultureInfo.InvariantCulture),
                Protocol.Hex(identity.FileId.Identifier));
        }

        private static string FileSystemName(SafeFileHandle handle, string label)
        {
            StringBuilder fileSystem = new StringBuilder(64);
            uint serial;
            uint maximumComponent;
            uint flags;
            if (!GetVolumeInformationByHandleW(
                handle,
                null,
                0,
                out serial,
                out maximumComponent,
                out flags,
                fileSystem,
                (uint)fileSystem.Capacity))
                ThrowWin32(
                    "BROKER_CONTEXT_VOLUME",
                    label + " volume information is unavailable");
            return fileSystem.ToString();
        }

        private static string VolumeIdentity(
            SafeFileHandle handle,
            string finalPath,
            string fileSystem,
            string label)
        {
            int rootEnd = finalPath.IndexOf("}\\", StringComparison.Ordinal);
            if (!finalPath.StartsWith("\\\\?\\Volume{", StringComparison.OrdinalIgnoreCase) ||
                rootEnd < 0)
                throw new NativeFailure(
                    "BROKER_CONTEXT_VOLUME",
                    label + " volume GUID identity is unavailable");
            string volumeRoot = finalPath.Substring(0, rootEnd + 2);
            if (GetDriveTypeW(volumeRoot) != DriveFixed)
                throw new NativeFailure(
                    "BROKER_CONTEXT_STORAGE",
                    label + " is not on fixed local storage");
            FILE_ID_INFO identity = GetFileId(handle, label);
            return "volume-v1:" + Protocol.HashFramed(
                "enduragent.windows-volume-identity.v1",
                volumeRoot,
                identity.VolumeSerialNumber.ToString("x16", CultureInfo.InvariantCulture),
                fileSystem);
        }

        private static string GetFinalVolumePath(SafeFileHandle handle, string label)
        {
            StringBuilder initial = new StringBuilder(512);
            uint length = GetFinalPathNameByHandleW(
                handle,
                initial,
                (uint)initial.Capacity,
                1);
            if (length == 0)
                ThrowWin32(
                    "BROKER_CONTEXT_FINAL_PATH",
                    label + " final path is unavailable");
            if (length < initial.Capacity) return initial.ToString();
            if (length > 32767)
                throw new NativeFailure(
                    "BROKER_CONTEXT_FINAL_PATH",
                    label + " final path exceeds the supported limit");
            StringBuilder expanded = new StringBuilder(checked((int)length + 1));
            uint second = GetFinalPathNameByHandleW(
                handle,
                expanded,
                (uint)expanded.Capacity,
                1);
            if (second == 0 || second >= expanded.Capacity)
                ThrowWin32(
                    "BROKER_CONTEXT_FINAL_PATH",
                    label + " final path is unstable");
            return expanded.ToString();
        }

        private static void ObserveExactSecurity(
            SafeFileHandle handle,
            string currentSid,
            bool directory,
            string label,
            out string ownerSid,
            out string sddl)
        {
            IntPtr owner;
            IntPtr group;
            IntPtr dacl;
            IntPtr sacl;
            IntPtr descriptor;
            uint result = GetSecurityInfo(
                handle,
                SeFileObject,
                OwnerSecurityInformation | DaclSecurityInformation,
                out owner,
                out group,
                out dacl,
                out sacl,
                out descriptor);
            if (result != 0)
                throw new NativeFailure(
                    "BROKER_CONTEXT_SECURITY",
                    label + " security descriptor is unavailable",
                    checked((int)result));
            try
            {
                IntPtr sddlPointer;
                uint sddlLength;
                if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SecurityDescriptorRevision,
                    OwnerSecurityInformation | DaclSecurityInformation,
                    out sddlPointer,
                    out sddlLength))
                    ThrowWin32(
                        "BROKER_CONTEXT_SECURITY",
                        label + " security descriptor could not be rendered");
                try
                {
                    sddl = Marshal.PtrToStringUni(
                        sddlPointer,
                        checked((int)sddlLength - 1));
                }
                finally
                {
                    LocalFree(sddlPointer);
                }
                RawSecurityDescriptor raw = new RawSecurityDescriptor(sddl);
                ownerSid = raw.Owner == null ? "" : raw.Owner.Value;
                if (!String.Equals(ownerSid, currentSid, StringComparison.Ordinal) ||
                    (raw.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 ||
                    raw.DiscretionaryAcl == null ||
                    raw.DiscretionaryAcl.Count != 3)
                    throw new NativeFailure(
                        "BROKER_CONTEXT_SECURITY_PROFILE",
                        label + " owner or protected DACL is not exact");
                HashSet<string> principals = new HashSet<string>(StringComparer.Ordinal);
                AceFlags expectedFlags = directory
                    ? AceFlags.ContainerInherit | AceFlags.ObjectInherit
                    : AceFlags.None;
                foreach (GenericAce genericAce in raw.DiscretionaryAcl)
                {
                    CommonAce ace = genericAce as CommonAce;
                    if (ace == null ||
                        ace.IsCallback ||
                        ace.AceType != AceType.AccessAllowed ||
                        ace.AceQualifier != AceQualifier.AccessAllowed ||
                        ace.AccessMask != 0x001F01FF ||
                        genericAce.AceFlags != expectedFlags ||
                        !principals.Add(ace.SecurityIdentifier.Value))
                        throw new NativeFailure(
                            "BROKER_CONTEXT_SECURITY_PROFILE",
                            label + " DACL contains a non-exact access entry");
                }
                if (!principals.Contains(currentSid) ||
                    !principals.Contains("S-1-5-18") ||
                    !principals.Contains("S-1-5-32-544"))
                    throw new NativeFailure(
                        "BROKER_CONTEXT_SECURITY_PROFILE",
                        label + " DACL principal set is incomplete");
            }
            finally
            {
                LocalFree(descriptor);
            }
        }

        private static void ObserveProcessSession(
            out string processSid,
            out string authenticationLuid,
            out string runnerSessionIdentity)
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query))
            {
                TOKEN_STATISTICS statistics;
                int returned;
                int expected = Marshal.SizeOf(typeof(TOKEN_STATISTICS));
                if (!GetTokenInformation(
                    identity.Token,
                    TokenStatisticsInformation,
                    out statistics,
                    expected,
                    out returned) ||
                    returned < expected ||
                    identity.User == null)
                    ThrowWin32(
                        "BROKER_CONTEXT_PROCESS_IDENTITY",
                        "broker process identity is unavailable");
                int sessionId = Process.GetCurrentProcess().SessionId;
                IntPtr stateBuffer;
                uint stateBytes;
                if (!WTSQuerySessionInformationW(
                    IntPtr.Zero,
                    checked((uint)sessionId),
                    WtsConnectStateInformation,
                    out stateBuffer,
                    out stateBytes))
                    ThrowWin32(
                        "BROKER_CONTEXT_SESSION",
                        "broker runner session state is unavailable");
                try
                {
                    if (stateBuffer == IntPtr.Zero ||
                        stateBytes != sizeof(int) ||
                        Marshal.ReadInt32(stateBuffer) != WtsActive)
                        throw new NativeFailure(
                            "BROKER_CONTEXT_SESSION",
                            "broker runner session is not active and interactive");
                }
                finally
                {
                    if (stateBuffer != IntPtr.Zero) WTSFreeMemory(stateBuffer);
                }
                processSid = identity.User.Value;
                authenticationLuid =
                    unchecked((uint)statistics.AuthenticationId.HighPart).ToString("x8") +
                    statistics.AuthenticationId.LowPart.ToString("x8");
                runnerSessionIdentity = Protocol.HashFramed(
                    "enduragent.windows-host-runner-session-raw.v1",
                    processSid,
                    sessionId.ToString(CultureInfo.InvariantCulture),
                    authenticationLuid,
                    "WTSActive");
            }
        }

        private static string BootIdentity()
        {
            IntPtr module = GetModuleHandleW("ntdll.dll");
            IntPtr procedure = module == IntPtr.Zero
                ? IntPtr.Zero
                : GetProcAddress(module, "NtQuerySystemInformation");
            if (procedure == IntPtr.Zero)
                throw new NativeFailure(
                    "BROKER_CONTEXT_BOOT_IDENTITY_UNSUPPORTED",
                    "Windows boot identity is unsupported on this build");
            NtQuerySystemInformationDelegate query =
                Marshal.GetDelegateForFunctionPointer(
                    procedure,
                    typeof(NtQuerySystemInformationDelegate))
                as NtQuerySystemInformationDelegate;
            if (query == null)
                throw new NativeFailure(
                    "BROKER_CONTEXT_BOOT_IDENTITY_UNSUPPORTED",
                    "Windows boot identity is unsupported on this build");
            SYSTEM_BOOT_ENVIRONMENT_INFORMATION information =
                new SYSTEM_BOOT_ENVIRONMENT_INFORMATION();
            int returned;
            int expected = Marshal.SizeOf(typeof(SYSTEM_BOOT_ENVIRONMENT_INFORMATION));
            int status = query(
                SystemBootEnvironmentInformation,
                ref information,
                expected,
                out returned);
            if (status < 0 || returned != expected || information.BootIdentifier == Guid.Empty)
                throw new NativeFailure(
                    "BROKER_CONTEXT_BOOT_IDENTITY_UNSUPPORTED",
                    "Windows boot identity is unsupported on this build");
            return information.BootIdentifier.ToString("D");
        }

        private static string AssemblySha256(SafeFileHandle retainedAssembly)
        {
            if (retainedAssembly == null ||
                retainedAssembly.IsInvalid ||
                retainedAssembly.IsClosed)
                throw new NativeFailure(
                    "BROKER_CONTEXT_HELPER_HOLD",
                    "broker context helper identity hold was lost");
            string path = Assembly.GetExecutingAssembly().Location;
            FileInfo file = new FileInfo(path);
            if (!file.Exists || file.Length < 512 || file.Length > 16 * 1024 * 1024)
                throw new NativeFailure(
                    "BROKER_CONTEXT_HELPER_IDENTITY",
                    "broker context helper is not a bounded assembly");
            return Protocol.Sha256(File.ReadAllBytes(path));
        }

        private static void ThrowWin32(string code, string message)
        {
            throw new NativeFailure(code, message, Marshal.GetLastWin32Error());
        }
    }
}
