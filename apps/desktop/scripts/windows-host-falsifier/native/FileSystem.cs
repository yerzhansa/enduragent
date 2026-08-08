using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Enduragent.WindowsHostFalsifier
{
    internal static class FileSystemProbe
    {
        private const uint FileReadData = 0x0001;
        private const uint FileWriteData = 0x0002;
        private const uint FileAppendData = 0x0004;
        private const uint FileReadEa = 0x0008;
        private const uint FileWriteEa = 0x0010;
        private const uint FileTraverse = 0x0020;
        private const uint FileReadAttributes = 0x0080;
        private const uint FileWriteAttributes = 0x0100;
        private const uint Delete = 0x00010000;
        private const uint ReadControl = 0x00020000;
        private const uint WriteDac = 0x00040000;
        private const uint WriteOwner = 0x00080000;
        private const uint Synchronize = 0x00100000;
        private const uint GenericRead = 0x80000000;
        private const uint GenericWrite = 0x40000000;

        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint FileShareDelete = 0x00000004;
        private const uint ShareAll = FileShareRead | FileShareWrite | FileShareDelete;

        private const uint CreateNew = 1;
        private const uint OpenExisting = 3;
        private const uint FileFlagBackupSemantics = 0x02000000;
        private const uint FileFlagOpenReparsePoint = 0x00200000;
        private const uint FileAttributeNormal = 0x00000080;
        private const uint FileAttributeReparsePoint = 0x00000400;

        private const uint NtFileOpen = 1;
        private const uint NtFileCreate = 2;
        private const uint FileDirectoryFile = 0x00000001;
        private const uint FileSynchronousIoNonAlert = 0x00000020;
        private const uint FileNonDirectoryFile = 0x00000040;
        private const uint FileOpenReparsePoint = 0x00200000;
        private const uint ObjCaseInsensitive = 0x00000040;
        private const int FileDirectoryInformationClass = 1;
        private const int StatusNoMoreFiles = unchecked((int)0x80000006);
        private const int StatusBufferOverflow = unchecked((int)0x80000005);

        private const int FileAttributeTagInfoClass = 9;
        private const int FileIdInfoClass = 18;
        private const int FileRenameInfoExClass = 22;
        private const int FileDispositionInfoExClass = 21;
        private const uint FileRenameReplaceIfExists = 0x00000001;
        private const uint FileDispositionDelete = 0x00000001;
        private const uint FileDispositionPosixSemantics = 0x00000002;

        private const uint OwnerSecurityInformation = 0x00000001;
        private const uint DaclSecurityInformation = 0x00000004;
        private const uint ProtectedDaclSecurityInformation = 0x80000000;
        private const int SeFileObject = 1;
        private const int SecurityDescriptorRevision = 1;

        private const int ErrorFileNotFound = 2;
        private const int ErrorPathNotFound = 3;
        private const int ErrorAccessDenied = 5;
        private const int ErrorInvalidHandle = 6;
        private const int ErrorNotSupported = 50;
        private const int ErrorFileExists = 80;
        private const int ErrorInvalidParameter = 87;
        private const int ErrorAlreadyExists = 183;
        private const int ErrorSharingViolation = 32;
        private const int ErrorLockViolation = 33;

        private const uint DriveRemovable = 2;
        private const uint DriveFixed = 3;
        private const uint DriveRemote = 4;

        private static readonly Regex VolumePathPattern = new Regex(
            @"^(\\\\\?\\Volume\{[0-9A-Fa-f-]+\}\\)(.*)$",
            RegexOptions.CultureInvariant);
        private static readonly Regex ReservedNamePattern = new Regex(
            @"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly object RunRootLock = new object();
        private static SafeFileHandle retainedRunRoot;
        private static string retainedRunRootPath;
        private static string retainedRunRootIdentity;

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
        private struct BY_HANDLE_FILE_INFORMATION
        {
            internal uint FileAttributes;
            internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            internal uint VolumeSerialNumber;
            internal uint FileSizeHigh;
            internal uint FileSizeLow;
            internal uint NumberOfLinks;
            internal uint FileIndexHigh;
            internal uint FileIndexLow;
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
        private struct SECURITY_ATTRIBUTES
        {
            internal int Length;
            internal IntPtr SecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)]
            internal bool InheritHandle;
        }

        private sealed class ParentResolution : IDisposable
        {
            internal SafeFileHandle Parent;
            internal string Leaf;

            public void Dispose()
            {
                if (Parent != null)
                {
                    Parent.Dispose();
                }
            }
        }

        private sealed class SecurityDescriptorAllocation : IDisposable
        {
            internal IntPtr Descriptor;

            public void Dispose()
            {
                if (Descriptor != IntPtr.Zero)
                {
                    LocalFree(Descriptor);
                    Descriptor = IntPtr.Zero;
                }
            }
        }

        private sealed class SealState
        {
            internal int MaximumDepth;
            internal int MaximumEntries;
            internal long MaximumFileBytes;
            internal long MaximumTotalBytes;
            internal long TotalBytes;
            internal readonly List<Dictionary<string, object>> Entries =
                new List<Dictionary<string, object>>();
        }

        private sealed class FileSeal
        {
            internal long Bytes;
            internal string Sha256;
        }

        private sealed class Utf8EntryComparer : IComparer<Dictionary<string, object>>
        {
            public int Compare(Dictionary<string, object> left, Dictionary<string, object> right)
            {
                return CompareUtf8Paths((string)left["path"], (string)right["path"]);
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

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateDirectoryW(string pathName, ref SECURITY_ATTRIBUTES attributes);

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

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out BY_HANDLE_FILE_INFORMATION information);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle file,
            StringBuilder path,
            uint pathLength,
            uint flags);

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

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WriteFile(
            SafeFileHandle file,
            byte[] buffer,
            uint bytesToWrite,
            out uint bytesWritten,
            IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(
            SafeFileHandle file,
            byte[] buffer,
            uint bytesToRead,
            out uint bytesRead,
            IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFilePointerEx(
            SafeFileHandle file,
            long distance,
            out long newPointer,
            uint moveMethod);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool FlushFileBuffers(SafeFileHandle file);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileInformationByHandle(
            SafeFileHandle file,
            int informationClass,
            IntPtr information,
            uint bufferSize);

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

        [DllImport("ntdll.dll")]
        private static extern int NtQueryDirectoryFile(
            SafeFileHandle fileHandle,
            IntPtr eventHandle,
            IntPtr apcRoutine,
            IntPtr apcContext,
            out IO_STATUS_BLOCK ioStatusBlock,
            byte[] fileInformation,
            uint length,
            int fileInformationClass,
            [MarshalAs(UnmanagedType.Bool)] bool returnSingleEntry,
            IntPtr fileName,
            [MarshalAs(UnmanagedType.Bool)] bool restartScan);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string stringSecurityDescriptor,
            uint stringSdRevision,
            out IntPtr securityDescriptor,
            out uint securityDescriptorSize);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSecurityDescriptorOwner(
            IntPtr securityDescriptor,
            out IntPtr owner,
            out bool ownerDefaulted);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSecurityDescriptorDacl(
            IntPtr securityDescriptor,
            out bool daclPresent,
            out IntPtr dacl,
            out bool daclDefaulted);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern uint SetSecurityInfo(
            SafeFileHandle handle,
            int objectType,
            uint securityInformation,
            IntPtr owner,
            IntPtr group,
            IntPtr dacl,
            IntPtr sacl);

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

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
            IntPtr securityDescriptor,
            uint requestedRevision,
            uint securityInformation,
            out IntPtr stringSecurityDescriptor,
            out uint stringLength);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DuplicateHandle(
            IntPtr sourceProcessHandle,
            SafeFileHandle sourceHandle,
            IntPtr targetProcessHandle,
            out SafeFileHandle targetHandle,
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            uint options);

        internal static string InitializeRunRoot(string path)
        {
            ValidateAbsoluteLocalPath(path);
            lock (RunRootLock)
            {
                if (retainedRunRoot != null)
                    throw new NativeFailure("RUN_ROOT_INITIALIZED", "run root was initialized more than once");
                SafeFileHandle handle = OpenPath(
                    path,
                    FileTraverse | FileReadAttributes | ReadControl | Synchronize,
                    FileFlagBackupSemantics | FileFlagOpenReparsePoint,
                    ShareAll);
                try
                {
                    RequirePlainType(handle, true);
                    if (GetDriveTypeW(Path.GetPathRoot(path)) != DriveFixed)
                        throw new NativeFailure("UNSUPPORTED_STORAGE", "run root is not on supported fixed local storage");
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
                        (uint)fileSystem.Capacity) ||
                        !String.Equals(fileSystem.ToString(), "NTFS", StringComparison.OrdinalIgnoreCase))
                        throw new NativeFailure("UNSUPPORTED_FILE_SYSTEM", "run root is not on NTFS");
                    retainedRunRootIdentity = FormatObjectIdentity(GetFileId(handle));
                    retainedRunRootPath = NormalizeDirectoryPath(path);
                    retainedRunRoot = handle;
                    handle = null;
                    return retainedRunRootIdentity;
                }
                finally
                {
                    if (handle != null) handle.Dispose();
                }
            }
        }

        internal static void DisposeRunRoot()
        {
            lock (RunRootLock)
            {
                if (retainedRunRoot != null) retainedRunRoot.Dispose();
                retainedRunRoot = null;
                retainedRunRootPath = null;
                retainedRunRootIdentity = null;
            }
        }

        internal static string RunRootPath
        {
            get
            {
                lock (RunRootLock)
                {
                    if (retainedRunRootPath == null)
                        throw new NativeFailure("RUN_ROOT_UNAVAILABLE", "run root is unavailable");
                    return retainedRunRootPath;
                }
            }
        }

        internal static string RunRootSecuritySha256()
        {
            lock (RunRootLock)
            {
                if (retainedRunRoot == null)
                    throw new NativeFailure("RUN_ROOT_UNAVAILABLE", "run root is unavailable");
                Dictionary<string, object> inspected = InspectPrivateHandle(retainedRunRoot, true);
                return (string)inspected["sddlSha256"];
            }
        }

        internal static string CombineRunRelative(string relativePath)
        {
            VerifyRetainedRunRoot(RunRootPath);
            string[] segments = ValidateRelativePath(relativePath);
            string combined = RunRootPath;
            foreach (string segment in segments) combined = Path.Combine(combined, segment);
            return combined;
        }

        internal static byte[] LoadContentSource(Dictionary<string, object> source)
        {
            string kind = Protocol.RequireString(source, "kind", 1, 32);
            int bytes;
            string expected;
            byte[] content;
            if (kind == "staged-file")
            {
                Protocol.RequireExactKeys(
                    source,
                    new string[] { "kind", "relativePath", "bytes", "sha256" },
                    "content source");
                string relativePath = Protocol.RequireString(source, "relativePath", 1, 32767);
                bytes = Protocol.RequireInt(source, "bytes", 0, Protocol.MaxContentBytes);
                expected = Protocol.RequireLowerHex64(source, "sha256");
                using (ParentResolution resolution = ResolveParent(RunRootPath, relativePath))
                using (SafeFileHandle file = NtOpenRelative(
                    resolution.Parent,
                    resolution.Leaf,
                    FileReadData | FileReadAttributes | Synchronize,
                    NtFileOpen,
                    FileNonDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert))
                {
                    RequirePlainType(file, false);
                    content = ReadAll(file, Protocol.MaxContentBytes);
                }
            }
            else if (kind == "deterministic")
            {
                Protocol.RequireExactKeys(
                    source,
                    new string[] { "kind", "seedHex", "bytes", "sha256" },
                    "content source");
                string seedHex = Protocol.RequireLowerHex64(source, "seedHex");
                bytes = Protocol.RequireInt(source, "bytes", 0, Protocol.MaxContentBytes);
                expected = Protocol.RequireLowerHex64(source, "sha256");
                content = GenerateDeterministic(Protocol.ParseHex(seedHex), bytes);
            }
            else
            {
                throw new NativeFailure("PROTOCOL_ENUM", "content source kind is invalid");
            }

            if (content.Length != bytes || !String.Equals(Protocol.Sha256(content), expected, StringComparison.Ordinal))
                throw new NativeFailure("CONTENT_SOURCE_MISMATCH", "content source size or digest did not match");
            return content;
        }

        private static byte[] GenerateDeterministic(byte[] seed, int length)
        {
            byte[] output = new byte[length];
            int offset = 0;
            ulong counter = 0;
            using (System.Security.Cryptography.SHA256 hash = System.Security.Cryptography.SHA256.Create())
            {
                byte[] domain = Encoding.UTF8.GetBytes("enduragent.windows-falsifier-content.v1");
                while (offset < output.Length)
                {
                    byte[] input = new byte[domain.Length + seed.Length + 8];
                    Buffer.BlockCopy(domain, 0, input, 0, domain.Length);
                    Buffer.BlockCopy(seed, 0, input, domain.Length, seed.Length);
                    for (int index = 0; index < 8; index += 1)
                        input[input.Length - 1 - index] = (byte)(counter >> (index * 8));
                    byte[] block = hash.ComputeHash(input);
                    int count = Math.Min(block.Length, output.Length - offset);
                    Buffer.BlockCopy(block, 0, output, offset, count);
                    offset += count;
                    counter += 1;
                }
            }
            return output;
        }

        internal static Dictionary<string, object> HomeIdentity(Dictionary<string, object> request)
        {
            Protocol.RequireExactKeys(request, new string[] { "path" }, "home-identity request");
            string path = Protocol.RequireString(request, "path", 1, 32767);
            ValidateAbsoluteLocalPath(path);

            string pathRoot = Path.GetPathRoot(path);
            uint inputDriveType = GetDriveTypeW(pathRoot);
            if (inputDriveType == DriveRemote || inputDriveType == DriveRemovable)
            {
                throw new NativeFailure("UNSUPPORTED_STORAGE", "home path is not on supported fixed local storage");
            }

            using (SafeFileHandle handle = OpenPath(
                path,
                FileReadAttributes | ReadControl,
                FileFlagBackupSemantics,
                ShareAll))
            {
                FILE_ATTRIBUTE_TAG_INFO tag = GetTag(handle);
                if ((tag.FileAttributes & 0x10) == 0)
                {
                    throw new NativeFailure("HOME_NOT_DIRECTORY", "home path does not identify a directory");
                }

                string finalPath = GetFinalVolumePath(handle);
                Match volumeMatch = VolumePathPattern.Match(finalPath);
                if (!volumeMatch.Success)
                {
                    throw new NativeFailure("UNSUPPORTED_VOLUME_IDENTITY", "volume GUID identity is unavailable");
                }

                string volumeRoot = volumeMatch.Groups[1].Value;
                uint driveTypeValue = GetDriveTypeW(volumeRoot);
                string driveType = DriveTypeName(driveTypeValue);
                if (driveTypeValue != DriveFixed)
                {
                    throw new NativeFailure("UNSUPPORTED_STORAGE", "home path is not on supported fixed local storage");
                }

                StringBuilder fileSystemName = new StringBuilder(64);
                uint legacySerial;
                uint maximumComponentLength;
                uint fileSystemFlags;
                if (!GetVolumeInformationByHandleW(
                    handle,
                    null,
                    0,
                    out legacySerial,
                    out maximumComponentLength,
                    out fileSystemFlags,
                    fileSystemName,
                    (uint)fileSystemName.Capacity))
                {
                    ThrowWin32("VOLUME_INFORMATION_FAILED", "volume information is unavailable");
                }

                string fileSystem = fileSystemName.ToString();
                if (!String.Equals(fileSystem, "NTFS", StringComparison.OrdinalIgnoreCase))
                {
                    throw new NativeFailure("UNSUPPORTED_FILE_SYSTEM", "home path is not on NTFS");
                }

                FILE_ID_INFO fileId = GetFileId(handle);
                string objectIdentity = FormatObjectIdentity(fileId);
                string volumeIdentity = "volume-v1:" + Protocol.HashFramed(
                    "enduragent.windows-volume-identity.v1",
                    volumeRoot,
                    fileId.VolumeSerialNumber.ToString("x16", CultureInfo.InvariantCulture),
                    fileSystem);
                string canonicalHomeId = "win-home-v1:" + Protocol.HashFramed(
                    "enduragent.windows-home-identity.v1",
                    volumeIdentity,
                    finalPath,
                    objectIdentity);
                BY_HANDLE_FILE_INFORMATION basic = GetBasicInfo(handle);

                return Protocol.Object(
                    "canonicalHomeId", canonicalHomeId,
                    "objectIdentity", objectIdentity,
                    "volumeIdentity", volumeIdentity,
                    "finalPathSha256", Protocol.Sha256(finalPath),
                    "fileSystem", fileSystem,
                    "driveType", driveType,
                    "reparseTag", (long)tag.ReparseTag,
                    "linkCount", (long)basic.NumberOfLinks);
            }
        }

        internal static Dictionary<string, object> EnsurePrivateDirectory(Dictionary<string, object> request)
        {
            Protocol.RequireExactKeys(request, new string[] { "path", "action" }, "private-directory-ensure request");
            string path = Protocol.RequireString(request, "path", 1, 32767);
            string action = Protocol.RequireString(request, "action", 1, 16);
            ValidateAbsoluteLocalPath(path);
            if (action != "create" && action != "repair")
            {
                throw new NativeFailure("PROTOCOL_ENUM", "directory action is invalid");
            }

            if (action == "create")
            {
                using (SecurityDescriptorAllocation descriptor = CreatePrivateDescriptor(true))
                {
                    SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES
                    {
                        Length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
                        SecurityDescriptor = descriptor.Descriptor,
                        InheritHandle = false
                    };
                    if (!CreateDirectoryW(path, ref attributes))
                    {
                        int code = Marshal.GetLastWin32Error();
                        if (code == ErrorAlreadyExists)
                        {
                            throw new NativeFailure("TARGET_EXISTS", "private directory target already exists", code);
                        }

                        throw new NativeFailure("DIRECTORY_CREATE_FAILED", "private directory creation failed", code);
                    }
                }
            }

            using (SafeFileHandle handle = OpenPath(
                path,
                FileReadAttributes | ReadControl | WriteDac | WriteOwner,
                FileFlagBackupSemantics | FileFlagOpenReparsePoint,
                ShareAll))
            {
                RequirePlainType(handle, true);
                if (action == "repair")
                {
                    ApplyPrivateSecurity(handle, true);
                }

                return InspectPrivateHandle(handle, true);
            }
        }

        internal static Dictionary<string, object> EnsurePrivateDirectoryRelative(
            string relativePath,
            string action)
        {
            if (action != "create" && action != "repair")
                throw new NativeFailure("PROTOCOL_ENUM", "directory action is invalid");
            using (ParentResolution resolution = ResolveParent(RunRootPath, relativePath))
            using (SafeFileHandle handle = action == "create"
                ? CreatePrivateRelative(
                    resolution.Parent,
                    resolution.Leaf,
                    true,
                    FileTraverse | FileReadAttributes | ReadControl | WriteDac | WriteOwner | Delete | Synchronize)
                : NtOpenRelative(
                    resolution.Parent,
                    resolution.Leaf,
                    FileTraverse | FileReadAttributes | ReadControl | WriteDac | WriteOwner | Delete | Synchronize,
                    NtFileOpen,
                    FileDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert))
            {
                RequirePlainType(handle, true);
                if (action == "repair") ApplyPrivateSecurity(handle, true);
                return InspectPrivateHandle(handle, true);
            }
        }

        internal static Dictionary<string, object> InspectPrivateDirectoryRelative(string relativePath)
        {
            using (ParentResolution resolution = ResolveParent(RunRootPath, relativePath))
            using (SafeFileHandle handle = NtOpenRelative(
                resolution.Parent,
                resolution.Leaf,
                FileTraverse | FileReadAttributes | ReadControl | Synchronize,
                NtFileOpen,
                FileDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert))
            {
                RequirePlainType(handle, true);
                return InspectPrivateHandle(handle, true);
            }
        }

        internal static Dictionary<string, object> InspectPrivateDirectory(Dictionary<string, object> request)
        {
            Protocol.RequireExactKeys(request, new string[] { "path" }, "private-directory-inspect request");
            string path = Protocol.RequireString(request, "path", 1, 32767);
            ValidateAbsoluteLocalPath(path);
            using (SafeFileHandle handle = OpenPath(
                path,
                FileReadAttributes | ReadControl,
                FileFlagBackupSemantics | FileFlagOpenReparsePoint,
                ShareAll))
            {
                RequirePlainType(handle, true);
                return InspectPrivateHandle(handle, true);
            }
        }

        internal static Dictionary<string, object> CreatePrivateFile(Dictionary<string, object> request)
        {
            Protocol.RequireExactKeys(
                request,
                new string[] { "root", "relativePath", "contentBase64" },
                "private-file-create request");
            string root = Protocol.RequireString(request, "root", 1, 32767);
            string relativePath = Protocol.RequireString(request, "relativePath", 1, 32767);
            byte[] content = Protocol.RequireBase64(request, "contentBase64", Protocol.MaxContentBytes);

            using (ParentResolution resolution = ResolveParent(root, relativePath))
            using (SafeFileHandle file = CreatePrivateRelative(
                resolution.Parent,
                resolution.Leaf,
                false,
                FileReadData | FileWriteData | FileReadAttributes | ReadControl | WriteDac | WriteOwner | Delete | Synchronize))
            {
                RequirePlainType(file, false);
                ApplyPrivateSecurity(file, false);
                WriteAll(file, content);
                if (!FlushFileBuffers(file))
                {
                    ThrowWin32("FILE_FLUSH_FAILED", "private file flush failed");
                }

                Dictionary<string, object> inspected = InspectPrivateHandle(file, false);
                return Protocol.Object(
                    "objectIdentity", inspected["objectIdentity"],
                    "linkCount", inspected["linkCount"],
                    "bytesWritten", content.Length,
                    "sddlSha256", inspected["sddlSha256"]);
            }
        }

        internal static Dictionary<string, object> FileIdentity(Dictionary<string, object> request)
        {
            Protocol.RequireExactKeys(request, new string[] { "root", "relativePath" }, "file-identity request");
            string root = Protocol.RequireString(request, "root", 1, 32767);
            string relativePath = Protocol.RequireString(request, "relativePath", 1, 32767);
            using (ParentResolution resolution = ResolveParent(root, relativePath))
            using (SafeFileHandle file = NtOpenRelative(
                resolution.Parent,
                resolution.Leaf,
                FileReadAttributes | ReadControl | Synchronize,
                NtFileOpen,
                FileNonDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert))
            {
                RequirePlainType(file, false);
                FILE_ID_INFO identity = GetFileId(file);
                BY_HANDLE_FILE_INFORMATION basic = GetBasicInfo(file);
                return Protocol.Object(
                    "objectIdentity", FormatObjectIdentity(identity),
                    "linkCount", (long)basic.NumberOfLinks);
            }
        }

        internal static Dictionary<string, object> EvidenceTreeSeal(Dictionary<string, object> request)
        {
            Protocol.RequireKeys(
                request,
                new string[] { "relativePath", "maxDepth", "maxEntries", "maxFileBytes", "maxTotalBytes" },
                new string[] { "relativePath", "mode", "exactPaths", "maxDepth", "maxEntries", "maxFileBytes", "maxTotalBytes" },
                "evidence-tree-seal request");
            string relativePath = Protocol.RequireString(request, "relativePath", 1, 32767);
            string mode = request.ContainsKey("mode")
                ? Protocol.RequireString(request, "mode", 1, 16)
                : "entries";
            if (mode != "entries" && mode != "digest-only" && mode != "exact-paths")
                throw new NativeFailure("PROTOCOL_ENUM", "evidence tree seal mode is invalid");
            SealState state = new SealState
            {
                MaximumDepth = Protocol.RequireInt(request, "maxDepth", 1, 64),
                MaximumEntries = Protocol.RequireInt(request, "maxEntries", 1, 8192),
                MaximumFileBytes = Protocol.RequireInt(request, "maxFileBytes", 1, 512 * 1024 * 1024),
                MaximumTotalBytes = Protocol.RequireInt(request, "maxTotalBytes", 1, 1024 * 1024 * 1024)
            };
            string rootIdentity;
            using (ParentResolution resolution = ResolveParent(RunRootPath, relativePath))
            using (SafeFileHandle directory = NtOpenRelative(
                resolution.Parent,
                resolution.Leaf,
                FileReadData | FileTraverse | FileReadAttributes | Synchronize,
                NtFileOpen,
                FileDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert))
            {
                RequirePlainType(directory, true);
                rootIdentity = FormatObjectIdentity(GetFileId(directory));
                if (mode == "exact-paths")
                {
                    string[] exactPaths = Protocol.RequireStringArray(request, "exactPaths", 768, 32767);
                    if (exactPaths.Length == 0 || exactPaths.Length > state.MaximumEntries)
                        throw new NativeFailure("EVIDENCE_ARTIFACT_SET", "exact evidence artifact set has an invalid length");
                    string prior = null;
                    foreach (string exactPath in exactPaths)
                    {
                        if (exactPath.IndexOf('\\') >= 0)
                            throw new NativeFailure("EVIDENCE_ARTIFACT_SET", "exact evidence artifact paths must use canonical separators");
                        string[] segments = ValidateEvidenceArtifactPath(exactPath);
                        if (segments.Length > state.MaximumDepth)
                            throw new NativeFailure("EVIDENCE_DEPTH_LIMIT", "exact evidence artifact path exceeds the depth limit");
                        if (prior != null && CompareUtf8Paths(prior, exactPath) >= 0)
                            throw new NativeFailure("EVIDENCE_ARTIFACT_SET", "exact evidence artifact paths must be unique and UTF-8 sorted");
                        SealExactFile(directory, exactPath, state);
                        prior = exactPath;
                    }
                }
                else
                {
                    if (request.ContainsKey("exactPaths"))
                        throw new NativeFailure("EVIDENCE_ARTIFACT_SET", "exactPaths requires exact-paths mode");
                    SealDirectory(directory, "", 0, state);
                }
            }
            state.Entries.Sort(new Utf8EntryComparer());
            List<string> framed = new List<string>();
            framed.Add(mode == "exact-paths"
                ? "enduragent.windows-evidence-artifact-set-seal.v1"
                : "enduragent.windows-evidence-tree-seal.v1");
            framed.Add(rootIdentity);
            foreach (Dictionary<string, object> entry in state.Entries)
            {
                framed.Add((string)entry["path"]);
                framed.Add((string)entry["type"]);
                framed.Add(Convert.ToString(entry["bytes"], CultureInfo.InvariantCulture));
                framed.Add(entry["sha256"] == null ? "" : (string)entry["sha256"]);
                framed.Add((string)entry["objectIdentity"]);
            }
            string treeSha256 = Protocol.HashFramed(framed.ToArray());
            if (mode == "exact-paths")
            {
                return Protocol.Object(
                    "mode", mode,
                    "rootObjectIdentity", rootIdentity,
                    "entryCount", state.Entries.Count,
                    "entries", state.Entries.ToArray(),
                    "totalBytes", state.TotalBytes,
                    "setSha256", treeSha256);
            }
            if (mode == "digest-only")
            {
                return Protocol.Object(
                    "mode", mode,
                    "rootObjectIdentity", rootIdentity,
                    "entryCount", state.Entries.Count,
                    "totalBytes", state.TotalBytes,
                    "treeSha256", treeSha256);
            }
            if (state.Entries.Count > 768)
                throw new NativeFailure("EVIDENCE_OUTPUT_LIMIT", "entry-bearing evidence seal exceeds the response-safe entry limit");
            return Protocol.Object(
                "mode", mode,
                "rootObjectIdentity", rootIdentity,
                "entryCount", state.Entries.Count,
                "entries", state.Entries.ToArray(),
                "totalBytes", state.TotalBytes,
                "treeSha256", treeSha256);
        }

        private static void SealExactFile(
            SafeFileHandle root,
            string relativePath,
            SealState state)
        {
            using (ParentResolution resolution = ResolveParentFromHandle(root, relativePath))
            using (SafeFileHandle file = NtOpenRelative(
                resolution.Parent,
                resolution.Leaf,
                FileReadData | FileReadAttributes | Synchronize,
                NtFileOpen,
                FileNonDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert))
            {
                RequirePlainType(file, false);
                FileSeal sealedFile = SealFile(file, state.MaximumFileBytes);
                state.TotalBytes += sealedFile.Bytes;
                if (state.TotalBytes > state.MaximumTotalBytes)
                    throw new NativeFailure("EVIDENCE_BYTE_LIMIT", "exact evidence artifact set exceeds the total byte limit");
                state.Entries.Add(Protocol.Object(
                    "path", relativePath,
                    "type", "file",
                    "bytes", sealedFile.Bytes,
                    "sha256", sealedFile.Sha256,
                    "objectIdentity", FormatObjectIdentity(GetFileId(file))));
            }
        }

        private static void SealDirectory(
            SafeFileHandle directory,
            string prefix,
            int depth,
            SealState state)
        {
            if (depth > state.MaximumDepth)
                throw new NativeFailure("EVIDENCE_DEPTH_LIMIT", "evidence tree exceeds the depth limit");
            List<KeyValuePair<string, uint>> children = QueryDirectoryEntries(directory);
            children.Sort(delegate(KeyValuePair<string, uint> left, KeyValuePair<string, uint> right)
            {
                return CompareUtf8Paths(left.Key, right.Key);
            });
            foreach (KeyValuePair<string, uint> entry in children)
            {
                string name = entry.Key;
                ValidateEvidenceArtifactPath(name);
                string path = prefix.Length == 0 ? name : prefix + "/" + name;
                if (state.Entries.Count >= state.MaximumEntries)
                    throw new NativeFailure("EVIDENCE_ENTRY_LIMIT", "evidence tree exceeds the entry limit");

                bool directoryHint = (entry.Value & 0x10) != 0;
                if (directoryHint)
                {
                    using (SafeFileHandle child = NtOpenRelative(
                        directory,
                        name,
                        FileReadData | FileTraverse | FileReadAttributes | Synchronize,
                        NtFileOpen,
                        FileDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert))
                    {
                        RequirePlainType(child, true);
                        state.Entries.Add(Protocol.Object(
                            "path", path,
                            "type", "directory",
                            "bytes", 0,
                            "sha256", null,
                            "objectIdentity", FormatObjectIdentity(GetFileId(child))));
                        SealDirectory(child, path, depth + 1, state);
                    }
                }
                else
                {
                    using (SafeFileHandle child = NtOpenRelative(
                        directory,
                        name,
                        FileReadData | FileReadAttributes | Synchronize,
                        NtFileOpen,
                        FileNonDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert))
                    {
                        RequirePlainType(child, false);
                        FileSeal sealedFile = SealFile(child, state.MaximumFileBytes);
                        state.TotalBytes += sealedFile.Bytes;
                        if (state.TotalBytes > state.MaximumTotalBytes)
                            throw new NativeFailure("EVIDENCE_BYTE_LIMIT", "evidence tree exceeds the total byte limit");
                        state.Entries.Add(Protocol.Object(
                            "path", path,
                            "type", "file",
                            "bytes", sealedFile.Bytes,
                            "sha256", sealedFile.Sha256,
                            "objectIdentity", FormatObjectIdentity(GetFileId(child))));
                    }
                }
            }
        }

        private static int CompareUtf8Paths(string left, string right)
        {
            byte[] leftBytes = Encoding.UTF8.GetBytes(left);
            byte[] rightBytes = Encoding.UTF8.GetBytes(right);
            int common = Math.Min(leftBytes.Length, rightBytes.Length);
            for (int index = 0; index < common; index += 1)
            {
                int difference = leftBytes[index].CompareTo(rightBytes[index]);
                if (difference != 0) return difference;
            }
            return leftBytes.Length.CompareTo(rightBytes.Length);
        }

        private static FileSeal SealFile(SafeFileHandle file, long maximumBytes)
        {
            RequireSingleLinkEvidenceFile(file);
            long ignored;
            if (!SetFilePointerEx(file, 0, out ignored, 0))
                ThrowWin32("FILE_SEEK_FAILED", "evidence file seek failed");
            long total = 0;
            byte[] buffer = new byte[64 * 1024];
            using (SHA256 hash = SHA256.Create())
            {
                while (true)
                {
                    uint read;
                    if (!ReadFile(file, buffer, (uint)buffer.Length, out read, IntPtr.Zero))
                        ThrowWin32("FILE_READ_FAILED", "evidence file read failed");
                    if (read == 0) break;
                    total += read;
                    if (total > maximumBytes)
                        throw new NativeFailure("FILE_TOO_LARGE", "evidence file exceeds the bounded seal limit");
                    hash.TransformBlock(buffer, 0, (int)read, buffer, 0);
                }
                hash.TransformFinalBlock(new byte[0], 0, 0);
                RequireSingleLinkEvidenceFile(file);
                return new FileSeal { Bytes = total, Sha256 = Protocol.Hex(hash.Hash) };
            }
        }

        private static void RequireSingleLinkEvidenceFile(SafeFileHandle file)
        {
            if (GetBasicInfo(file).NumberOfLinks != 1)
            {
                throw new NativeFailure(
                    "EVIDENCE_HARD_LINK",
                    "evidence artifacts must have exactly one filesystem link");
            }
        }

        private static List<KeyValuePair<string, uint>> QueryDirectoryEntries(SafeFileHandle directory)
        {
            List<KeyValuePair<string, uint>> entries = new List<KeyValuePair<string, uint>>();
            bool restart = true;
            while (true)
            {
                byte[] buffer = new byte[64 * 1024];
                IO_STATUS_BLOCK statusBlock;
                int status = NtQueryDirectoryFile(
                    directory,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    out statusBlock,
                    buffer,
                    (uint)buffer.Length,
                    FileDirectoryInformationClass,
                    false,
                    IntPtr.Zero,
                    restart);
                restart = false;
                if (status == StatusNoMoreFiles) break;
                if (status < 0 && status != StatusBufferOverflow)
                    throw new NativeFailure(
                        "EVIDENCE_ENUMERATION_FAILED",
                        "handle-relative evidence enumeration failed",
                        unchecked((int)RtlNtStatusToDosError(status)));
                int used = checked((int)statusBlock.Information.ToUInt64());
                if (used <= 0 || used > buffer.Length)
                    throw new NativeFailure("EVIDENCE_ENUMERATION_FAILED", "evidence enumeration returned an invalid buffer");
                int offset = 0;
                while (offset < used)
                {
                    if (offset + 64 > used)
                        throw new NativeFailure("EVIDENCE_ENUMERATION_FAILED", "evidence enumeration record is truncated");
                    uint nextOffset = BitConverter.ToUInt32(buffer, offset);
                    uint attributes = BitConverter.ToUInt32(buffer, offset + 56);
                    uint nameBytes = BitConverter.ToUInt32(buffer, offset + 60);
                    if ((nameBytes & 1) != 0 || nameBytes > 32766 || offset + 64 + nameBytes > used)
                        throw new NativeFailure("EVIDENCE_ENUMERATION_FAILED", "evidence enumeration name is invalid");
                    string name = Encoding.Unicode.GetString(buffer, offset + 64, (int)nameBytes);
                    if (name != "." && name != "..")
                    {
                        if ((attributes & FileAttributeReparsePoint) != 0)
                            throw new NativeFailure("REPARSE_POINT", "evidence tree contains a reparse point");
                        entries.Add(new KeyValuePair<string, uint>(name, attributes));
                    }
                    if (nextOffset == 0) break;
                    if (nextOffset < 64 || offset + nextOffset > used)
                        throw new NativeFailure("EVIDENCE_ENUMERATION_FAILED", "evidence enumeration offset is invalid");
                    offset += checked((int)nextOffset);
                }
            }
            return entries;
        }

        internal static Dictionary<string, object> SecurePathOperation(Dictionary<string, object> request)
        {
            string operation = Protocol.RequireString(request, "operation", 1, 16);
            string[] required;
            string[] permitted;
            if (operation == "read" || operation == "delete")
            {
                required = new string[] { "root", "relativePath", "operation" };
                permitted = new string[] { "root", "relativePath", "operation", "expectedIdentity" };
            }
            else if (operation == "create" || operation == "replace")
            {
                required = new string[] { "root", "relativePath", "operation", "contentBase64" };
                permitted = operation == "replace"
                    ? new string[] { "root", "relativePath", "operation", "contentBase64", "expectedIdentity" }
                    : required;
            }
            else if (operation == "quarantine")
            {
                required = new string[] { "root", "relativePath", "operation", "destinationRelativePath" };
                permitted = new string[] { "root", "relativePath", "operation", "destinationRelativePath", "expectedIdentity" };
            }
            else
            {
                throw new NativeFailure("PROTOCOL_ENUM", "secure path operation is invalid");
            }

            Protocol.RequireKeys(request, required, permitted, "secure-path-operation request");
            string root = Protocol.RequireString(request, "root", 1, 32767);
            string relativePath = Protocol.RequireString(request, "relativePath", 1, 32767);
            string expectedIdentity = OptionalString(request, "expectedIdentity", 128);

            try
            {
                if (operation == "create")
                {
                    byte[] content = Protocol.RequireBase64(request, "contentBase64", Protocol.MaxContentBytes);
                    using (ParentResolution resolution = ResolveParent(root, relativePath))
                    using (SafeFileHandle created = CreatePrivateRelative(
                        resolution.Parent,
                        resolution.Leaf,
                        false,
                        FileReadData | FileWriteData | FileReadAttributes | ReadControl | WriteDac | WriteOwner | Delete | Synchronize))
                    {
                        RequirePlainType(created, false);
                        ApplyPrivateSecurity(created, false);
                        WriteAll(created, content);
                        FILE_ID_INFO identity = GetFileId(created);
                        return Completed(FormatObjectIdentity(identity), Protocol.Sha256(content));
                    }
                }

                using (ParentResolution source = ResolveParent(root, relativePath))
                using (SafeFileHandle file = NtOpenRelative(
                    source.Parent,
                    source.Leaf,
                    FileReadData | FileWriteData | FileReadAttributes | ReadControl | Delete | Synchronize,
                    NtFileOpen,
                    FileNonDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert))
                {
                    RequirePlainType(file, false);
                    string objectIdentity = FormatObjectIdentity(GetFileId(file));
                    if (expectedIdentity != null && !String.Equals(expectedIdentity, objectIdentity, StringComparison.Ordinal))
                    {
                        return Refused("IDENTITY_MISMATCH", null);
                    }

                    if (operation == "read")
                    {
                        return Completed(objectIdentity, Protocol.Sha256(ReadAll(file, Protocol.MaxContentBytes)));
                    }

                    if (operation == "delete")
                    {
                        SetDisposition(file);
                        return Completed(objectIdentity, null);
                    }

                    if (operation == "quarantine")
                    {
                        string destination = Protocol.RequireString(request, "destinationRelativePath", 1, 32767);
                        using (ParentResolution target = ResolveParent(root, destination))
                        {
                            SetRename(file, target.Parent, target.Leaf, false);
                        }

                        return Completed(objectIdentity, null);
                    }

                    byte[] replacement = Protocol.RequireBase64(request, "contentBase64", Protocol.MaxContentBytes);
                    string temporaryName = ".native-replace-" + Guid.NewGuid().ToString("N") + ".tmp";
                    using (SafeFileHandle temporary = CreatePrivateRelative(
                        source.Parent,
                        temporaryName,
                        false,
                        FileReadData | FileWriteData | FileReadAttributes | ReadControl | WriteDac | WriteOwner | Delete | Synchronize))
                    {
                        bool renamed = false;
                        try
                        {
                            ApplyPrivateSecurity(temporary, false);
                            WriteAll(temporary, replacement);
                            if (!FlushFileBuffers(temporary))
                            {
                                ThrowWin32("FILE_FLUSH_FAILED", "replacement file flush failed");
                            }

                            SetRename(temporary, source.Parent, source.Leaf, true);
                            renamed = true;
                            return Completed(FormatObjectIdentity(GetFileId(temporary)), Protocol.Sha256(replacement));
                        }
                        finally
                        {
                            if (!renamed)
                            {
                                TryDisposeOwnedFile(temporary);
                            }
                        }
                    }
                }
            }
            catch (NativeFailure failure)
            {
                if (failure.NativeCode == ErrorSharingViolation || failure.NativeCode == ErrorLockViolation)
                {
                    return NotCommitted("SHARING_VIOLATION", failure.NativeCode);
                }

                if (failure.Code == "REPARSE_POINT" ||
                    failure.Code == "TARGET_EXISTS" ||
                    failure.Code == "PATH_NOT_FOUND" ||
                    failure.Code == "IDENTITY_MISMATCH")
                {
                    return Refused(failure.Code, failure.NativeCode);
                }

                throw;
            }
        }

        internal static Dictionary<string, object> DurableReplace(Dictionary<string, object> request)
        {
            Protocol.RequireExactKeys(
                request,
                new string[] { "root", "relativePath", "tempRelativePath", "contentBase64", "checkpoint", "retry" },
                "durable-replace request");
            string root = Protocol.RequireString(request, "root", 1, 32767);
            string relativePath = Protocol.RequireString(request, "relativePath", 1, 32767);
            string tempRelativePath = Protocol.RequireString(request, "tempRelativePath", 1, 32767);
            byte[] content = Protocol.RequireBase64(request, "contentBase64", Protocol.MaxContentBytes);
            string checkpoint = Protocol.RequireString(request, "checkpoint", 1, 32);
            HashSet<string> checkpoints = new HashSet<string>(new string[] {
                "before-temp", "during-write", "after-file-flush", "before-rename", "during-rename", "after-rename"
            }, StringComparer.Ordinal);
            if (!checkpoints.Contains(checkpoint))
            {
                throw new NativeFailure("PROTOCOL_ENUM", "durable replacement checkpoint is invalid");
            }

            Dictionary<string, object> retry = Protocol.RequireObject(request, "retry");
            Protocol.RequireExactKeys(
                retry,
                new string[] { "maxAttempts", "baseDelayMs", "maxDelayMs", "deadlineMs" },
                "durable replacement retry policy");
            int maxAttempts = Protocol.RequireInt(retry, "maxAttempts", 1, 32);
            int baseDelayMs = Protocol.RequireInt(retry, "baseDelayMs", 0, 10000);
            int maxDelayMs = Protocol.RequireInt(retry, "maxDelayMs", 0, 30000);
            int deadlineMs = Protocol.RequireInt(retry, "deadlineMs", 1, 120000);
            if (baseDelayMs > maxDelayMs)
            {
                throw new NativeFailure("PROTOCOL_RETRY", "retry base delay exceeds maximum delay");
            }

            using (ParentResolution target = ResolveParent(root, relativePath))
            using (ParentResolution temporaryPath = ResolveParent(root, tempRelativePath))
            {
                if (!String.Equals(
                    FormatObjectIdentity(GetFileId(target.Parent)),
                    FormatObjectIdentity(GetFileId(temporaryPath.Parent)),
                    StringComparison.Ordinal))
                {
                    throw new NativeFailure("REPLACE_CROSS_DIRECTORY", "replacement temporary must share the target directory");
                }

                string oldDigest;
                using (SafeFileHandle old = NtOpenRelative(
                    target.Parent,
                    target.Leaf,
                    FileReadData | FileReadAttributes | Synchronize,
                    NtFileOpen,
                    FileNonDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert))
                {
                    RequirePlainType(old, false);
                    oldDigest = Protocol.Sha256(ReadAll(old, Protocol.MaxContentBytes));
                }

                if (checkpoint == "before-temp")
                {
                    return DurableResult("not-committed", 0, "INJECTED_BEFORE_TEMP", oldDigest);
                }

                using (SafeFileHandle temporary = CreatePrivateRelative(
                    temporaryPath.Parent,
                    temporaryPath.Leaf,
                    false,
                    FileReadData | FileWriteData | FileReadAttributes | ReadControl | WriteDac | WriteOwner | Delete | Synchronize))
                {
                    bool renamed = false;
                    try
                    {
                        ApplyPrivateSecurity(temporary, false);
                        if (checkpoint == "during-write")
                        {
                            int partialLength = content.Length == 0 ? 0 : Math.Max(1, content.Length / 2);
                            byte[] partial = new byte[partialLength];
                            Buffer.BlockCopy(content, 0, partial, 0, partialLength);
                            WriteAll(temporary, partial);
                            return DurableResult("not-committed", 0, "INJECTED_DURING_WRITE", oldDigest);
                        }

                        WriteAll(temporary, content);
                        if (!FlushFileBuffers(temporary))
                        {
                            ThrowWin32("FILE_FLUSH_FAILED", "replacement file flush failed");
                        }

                        if (checkpoint == "after-file-flush" || checkpoint == "before-rename")
                        {
                            return DurableResult(
                                "not-committed",
                                0,
                                checkpoint == "after-file-flush" ? "INJECTED_AFTER_FILE_FLUSH" : "INJECTED_BEFORE_RENAME",
                                oldDigest);
                        }

                        Stopwatch elapsed = Stopwatch.StartNew();
                        int retries = 0;
                        while (true)
                        {
                            try
                            {
                                SetRename(temporary, target.Parent, target.Leaf, true);
                                renamed = true;
                                break;
                            }
                            catch (NativeFailure failure)
                            {
                                bool retryable = failure.NativeCode == ErrorSharingViolation || failure.NativeCode == ErrorLockViolation;
                                int attempts = retries + 1;
                                if (!retryable || attempts >= maxAttempts || elapsed.ElapsedMilliseconds >= deadlineMs)
                                {
                                    if (retryable)
                                    {
                                        return DurableResult("not-committed", retries, "SHARING_VIOLATION", oldDigest);
                                    }

                                    throw;
                                }

                                int delay = BoundedBackoff(baseDelayMs, maxDelayMs, retries);
                                if (elapsed.ElapsedMilliseconds + delay > deadlineMs)
                                {
                                    return DurableResult("not-committed", retries, "SHARING_VIOLATION", oldDigest);
                                }

                                Thread.Sleep(delay);
                                retries += 1;
                            }
                        }

                        if (!FlushFileBuffers(temporary))
                        {
                            int flushCode = Marshal.GetLastWin32Error();
                            return DurableResult("commit-uncertain", retries, "POST_RENAME_FILE_FLUSH_FAILED_" + flushCode.ToString(CultureInfo.InvariantCulture), Protocol.Sha256(content));
                        }

                        return DurableResult(
                            "commit-uncertain",
                            retries,
                            checkpoint == "during-rename" ? "INJECTED_DURING_RENAME" : "DIRECTORY_DURABILITY_UNPROVEN",
                            Protocol.Sha256(content));
                    }
                    finally
                    {
                        if (!renamed)
                        {
                            TryDisposeOwnedFile(temporary);
                        }
                    }
                }
            }
        }

        private static int BoundedBackoff(int baseDelay, int maximumDelay, int retry)
        {
            long multiplier = 1L << Math.Min(retry, 20);
            return (int)Math.Min((long)maximumDelay, (long)baseDelay * multiplier);
        }

        private static Dictionary<string, object> DurableResult(
            string outcome,
            int retries,
            string errorCode,
            string digest)
        {
            return Protocol.Object(
                "outcome", outcome,
                "retries", retries,
                "errorCode", errorCode,
                "oldOrNewDigest", digest);
        }

        private static Dictionary<string, object> Completed(string identity, string contentDigest)
        {
            return Protocol.Object(
                "outcome", "completed",
                "objectIdentity", identity,
                "contentSha256", contentDigest,
                "win32Code", null,
                "reasonCode", null);
        }

        private static Dictionary<string, object> Refused(string reason, int? code)
        {
            return Protocol.Object(
                "outcome", "refused",
                "objectIdentity", null,
                "contentSha256", null,
                "win32Code", code.HasValue ? (object)code.Value : null,
                "reasonCode", reason);
        }

        private static Dictionary<string, object> NotCommitted(string reason, int? code)
        {
            return Protocol.Object(
                "outcome", "not-committed",
                "objectIdentity", null,
                "contentSha256", null,
                "win32Code", code.HasValue ? (object)code.Value : null,
                "reasonCode", reason);
        }

        private static string OptionalString(Dictionary<string, object> request, string key, int maximumLength)
        {
            if (!request.ContainsKey(key))
            {
                return null;
            }

            return Protocol.RequireString(request, key, 1, maximumLength);
        }

        private static Dictionary<string, object> InspectPrivateHandle(SafeFileHandle handle, bool directory)
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
            {
                throw new NativeFailure("SECURITY_INSPECTION_FAILED", "security descriptor inspection failed", (int)result);
            }

            try
            {
                IntPtr stringPointer;
                uint stringLength;
                if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SecurityDescriptorRevision,
                    OwnerSecurityInformation | DaclSecurityInformation,
                    out stringPointer,
                    out stringLength))
                {
                    ThrowWin32("SECURITY_INSPECTION_FAILED", "security descriptor rendering failed");
                }

                string sddl;
                try
                {
                    sddl = Marshal.PtrToStringUni(stringPointer, checked((int)stringLength - 1));
                }
                finally
                {
                    LocalFree(stringPointer);
                }

                RawSecurityDescriptor raw = new RawSecurityDescriptor(sddl);
                string currentSid = CurrentSid();
                string ownerSid = raw.Owner == null ? "" : raw.Owner.Value;
                bool protectedAcl = (raw.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0;
                HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
                HashSet<string> canonicalPrincipals = new HashSet<string>(StringComparer.Ordinal);
                List<object> principals = new List<object>();
                int unexpected = 0;
                if (!protectedAcl)
                {
                    unexpected += 1;
                }

                if (raw.DiscretionaryAcl == null)
                {
                    unexpected += 1;
                }
                else
                {
                    foreach (GenericAce genericAce in raw.DiscretionaryAcl)
                    {
                        CommonAce ace = genericAce as CommonAce;
                        string token = ace == null ? null : PrincipalToken(ace.SecurityIdentifier.Value, currentSid);
                        bool inherited = (genericAce.AceFlags & AceFlags.Inherited) != 0;
                        bool correctQualifier = ace != null && ace.AceQualifier == AceQualifier.AccessAllowed;
                        bool correctType = ace != null && ace.AceType == AceType.AccessAllowed && !ace.IsCallback;
                        bool correctMask = ace != null && ace.AccessMask == 0x001F01FF;
                        AceFlags expectedInheritance = directory
                            ? AceFlags.ContainerInherit | AceFlags.ObjectInherit
                            : AceFlags.None;
                        bool correctInheritance = (genericAce.AceFlags & ~AceFlags.Inherited) == expectedInheritance;
                        bool firstOccurrence = token != null && seen.Add(token);
                        bool canonical = token != null &&
                            !inherited &&
                            correctQualifier &&
                            correctType &&
                            correctMask &&
                            correctInheritance;
                        if (!canonical || !canonicalPrincipals.Add(token))
                        {
                            unexpected += 1;
                        }

                        if (firstOccurrence)
                        {
                            principals.Add(token);
                        }
                    }
                }

                foreach (string required in new string[] { "current-user", "System", "Administrators" })
                {
                    if (!seen.Contains(required))
                    {
                        unexpected += 1;
                    }
                }

                if (!String.Equals(ownerSid, currentSid, StringComparison.Ordinal))
                {
                    unexpected += 1;
                }

                FILE_ID_INFO identity = GetFileId(handle);
                BY_HANDLE_FILE_INFORMATION basic = GetBasicInfo(handle);
                return Protocol.Object(
                    "objectIdentity", FormatObjectIdentity(identity),
                    "ownerSidSha256", Protocol.Sha256(ownerSid),
                    "protectedAcl", protectedAcl,
                    "principals", principals.ToArray(),
                    "unexpectedAceCount", unexpected,
                    "sddlSha256", Protocol.Sha256(sddl),
                    "linkCount", (long)basic.NumberOfLinks);
            }
            finally
            {
                LocalFree(descriptor);
            }
        }

        private static string PrincipalToken(string sid, string currentSid)
        {
            if (String.Equals(sid, currentSid, StringComparison.Ordinal)) return "current-user";
            if (String.Equals(sid, "S-1-5-18", StringComparison.Ordinal)) return "System";
            if (String.Equals(sid, "S-1-5-32-544", StringComparison.Ordinal)) return "Administrators";
            return null;
        }

        private static SecurityDescriptorAllocation CreatePrivateDescriptor(bool directory)
        {
            string inheritance = directory ? "OICI" : "";
            string sid = CurrentSid();
            string sddl = "O:" + sid + "D:P" +
                "(A;" + inheritance + ";FA;;;" + sid + ")" +
                "(A;" + inheritance + ";FA;;;SY)" +
                "(A;" + inheritance + ";FA;;;BA)";
            IntPtr descriptor;
            uint descriptorSize;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl,
                SecurityDescriptorRevision,
                out descriptor,
                out descriptorSize))
            {
                ThrowWin32("SECURITY_DESCRIPTOR_FAILED", "private security descriptor creation failed");
            }

            return new SecurityDescriptorAllocation { Descriptor = descriptor };
        }

        private static void ApplyPrivateSecurity(SafeFileHandle handle, bool directory)
        {
            using (SecurityDescriptorAllocation descriptor = CreatePrivateDescriptor(directory))
            {
                IntPtr owner = IntPtr.Zero;
                bool ownerDefaulted;
                bool daclPresent;
                IntPtr dacl = IntPtr.Zero;
                bool daclDefaulted;
                if (!GetSecurityDescriptorOwner(descriptor.Descriptor, out owner, out ownerDefaulted) ||
                    !GetSecurityDescriptorDacl(descriptor.Descriptor, out daclPresent, out dacl, out daclDefaulted) ||
                    !daclPresent || dacl == IntPtr.Zero)
                {
                    ThrowWin32("SECURITY_DESCRIPTOR_FAILED", "private security descriptor is invalid");
                }

                uint result = SetSecurityInfo(
                    handle,
                    SeFileObject,
                    OwnerSecurityInformation | DaclSecurityInformation | ProtectedDaclSecurityInformation,
                    owner,
                    IntPtr.Zero,
                    dacl,
                    IntPtr.Zero);
                if (result != 0)
                {
                    throw new NativeFailure("SECURITY_REPAIR_FAILED", "private security descriptor application failed", (int)result);
                }
            }
        }

        private static string CurrentSid()
        {
            WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query);
            try
            {
                if (identity.User == null)
                {
                    throw new NativeFailure("CURRENT_SID_UNAVAILABLE", "current user SID is unavailable");
                }

                return identity.User.Value;
            }
            finally
            {
                identity.Dispose();
            }
        }

        private static ParentResolution ResolveParent(string root, string relativePath)
        {
            ValidateAbsoluteLocalPath(root);
            VerifyRetainedRunRoot(root);
            string[] segments = ValidateRelativePath(relativePath);
            SafeFileHandle current = DuplicateRetainedRunRoot();
            try
            {
                RequirePlainType(current, true);
                for (int index = 0; index < segments.Length - 1; index += 1)
                {
                    SafeFileHandle next = NtOpenRelative(
                        current,
                        segments[index],
                        FileTraverse | FileReadAttributes | ReadControl | Synchronize,
                        NtFileOpen,
                        FileDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert);
                    try
                    {
                        RequirePlainType(next, true);
                    }
                    catch
                    {
                        next.Dispose();
                        throw;
                    }

                    current.Dispose();
                    current = next;
                }

                ParentResolution result = new ParentResolution { Parent = current, Leaf = segments[segments.Length - 1] };
                current = null;
                return result;
            }
            finally
            {
                if (current != null)
                {
                    current.Dispose();
                }
            }
        }

        private static ParentResolution ResolveParentFromHandle(
            SafeFileHandle root,
            string relativePath)
        {
            string[] segments = ValidateRelativePath(relativePath);
            IntPtr process = GetCurrentProcess();
            SafeFileHandle current;
            if (!DuplicateHandle(process, root, process, out current, 0, false, 0x00000002))
                ThrowWin32("EVIDENCE_ROOT_DUPLICATE_FAILED", "evidence root handle could not be duplicated");
            try
            {
                RequirePlainType(current, true);
                for (int index = 0; index < segments.Length - 1; index += 1)
                {
                    SafeFileHandle next = NtOpenRelative(
                        current,
                        segments[index],
                        FileTraverse | FileReadAttributes | Synchronize,
                        NtFileOpen,
                        FileDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert);
                    try
                    {
                        RequirePlainType(next, true);
                    }
                    catch
                    {
                        next.Dispose();
                        throw;
                    }
                    current.Dispose();
                    current = next;
                }
                ParentResolution result = new ParentResolution
                {
                    Parent = current,
                    Leaf = segments[segments.Length - 1]
                };
                current = null;
                return result;
            }
            finally
            {
                if (current != null) current.Dispose();
            }
        }

        private static void VerifyRetainedRunRoot(string root)
        {
            lock (RunRootLock)
            {
                if (retainedRunRoot == null || retainedRunRoot.IsClosed)
                    throw new NativeFailure("RUN_ROOT_UNAVAILABLE", "retained run root handle is unavailable");
                string normalized = NormalizeDirectoryPath(root);
                if (!String.Equals(normalized, retainedRunRootPath, StringComparison.OrdinalIgnoreCase))
                    throw new NativeFailure("RUN_ROOT_MISMATCH", "operation root does not match the retained run root");
                RequirePlainType(retainedRunRoot, true);
                if (!String.Equals(FormatObjectIdentity(GetFileId(retainedRunRoot)), retainedRunRootIdentity, StringComparison.Ordinal))
                    throw new NativeFailure("RUN_ROOT_SWAPPED", "retained run root handle identity changed");
            }
        }

        private static string NormalizeDirectoryPath(string path)
        {
            string fullPath = Path.GetFullPath(path);
            string root = Path.GetPathRoot(fullPath);
            if (String.Equals(fullPath, root, StringComparison.OrdinalIgnoreCase)) return root;
            return fullPath.TrimEnd('\\');
        }

        private static SafeFileHandle DuplicateRetainedRunRoot()
        {
            lock (RunRootLock)
            {
                if (retainedRunRoot == null || retainedRunRoot.IsClosed)
                    throw new NativeFailure("RUN_ROOT_UNAVAILABLE", "retained run root handle is unavailable");
                IntPtr process = GetCurrentProcess();
                SafeFileHandle duplicate;
                if (!DuplicateHandle(process, retainedRunRoot, process, out duplicate, 0, false, 0x00000002))
                    ThrowWin32("RUN_ROOT_DUPLICATE_FAILED", "retained run root handle could not be duplicated");
                return duplicate;
            }
        }

        private static string[] ValidateRelativePath(string value)
        {
            if (String.IsNullOrEmpty(value) || value.Length > 32767 || value.IndexOf('\0') >= 0 ||
                value.StartsWith("\\", StringComparison.Ordinal) || value.StartsWith("/", StringComparison.Ordinal) ||
                Path.IsPathRooted(value) || value.IndexOf(':') >= 0)
            {
                throw new NativeFailure("PATH_RELATIVE", "relative path is invalid");
            }

            string[] segments = value.Split(new char[] { '\\', '/' }, StringSplitOptions.None);
            if (segments.Length == 0 || segments.Length > 128)
            {
                throw new NativeFailure("PATH_RELATIVE", "relative path has an invalid component count");
            }

            foreach (string segment in segments)
            {
                if (segment.Length == 0 || segment == "." || segment == ".." ||
                    segment.EndsWith(".", StringComparison.Ordinal) || segment.EndsWith(" ", StringComparison.Ordinal) ||
                    ReservedNamePattern.IsMatch(segment) ||
                    !String.Equals(segment, segment.Normalize(NormalizationForm.FormC), StringComparison.Ordinal) ||
                    ContainsUnsafeWin32Character(segment))
                {
                    throw new NativeFailure("PATH_COMPONENT", "relative path contains an unsafe component");
                }
            }

            return segments;
        }

        private static string[] ValidateEvidenceArtifactPath(string value)
        {
            string[] segments = ValidateRelativePath(value);
            foreach (string segment in segments)
            {
                foreach (char character in segment)
                {
                    if (character < 0x20 || character > 0x7e)
                    {
                        throw new NativeFailure(
                            "EVIDENCE_PATH_COMPONENT",
                            "evidence artifact path components must use printable ASCII");
                    }
                }
            }

            return segments;
        }

        private static void ValidateAbsoluteLocalPath(string value)
        {
            bool normalDrive = Regex.IsMatch(value, @"^[A-Za-z]:\\", RegexOptions.CultureInvariant);
            bool longDrive = Regex.IsMatch(value, @"^\\\\\?\\[A-Za-z]:\\", RegexOptions.CultureInvariant);
            if (String.IsNullOrEmpty(value) || value.Length > 32767 || value.IndexOf('\0') >= 0 ||
                !String.Equals(value, value.Normalize(NormalizationForm.FormC), StringComparison.Ordinal) ||
                (!normalDrive && !longDrive) || !Path.IsPathRooted(value) ||
                value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase) ||
                value.StartsWith("\\\\.\\", StringComparison.OrdinalIgnoreCase) ||
                value.IndexOf("GLOBALROOT", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                throw new NativeFailure("PATH_ABSOLUTE", "path must be an absolute local path");
            }

            string root = Path.GetPathRoot(value);
            if (String.IsNullOrEmpty(root) || GetDriveTypeW(root) == DriveRemote)
            {
                throw new NativeFailure("PATH_REMOTE", "remote paths are unsupported");
            }
        }

        private static bool ContainsUnsafeWin32Character(string value)
        {
            foreach (char character in value)
            {
                if (character < 0x20 || character == '<' || character == '>' || character == '"' ||
                    character == '|' || character == '?' || character == '*' || character == ':')
                    return true;
            }
            return false;
        }

        private static SafeFileHandle OpenPath(string path, uint access, uint flags, uint share)
        {
            SafeFileHandle handle = CreateFileW(path, access, share, IntPtr.Zero, OpenExisting, flags, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                handle.Dispose();
                if (code == ErrorFileNotFound || code == ErrorPathNotFound)
                {
                    throw new NativeFailure("PATH_NOT_FOUND", "path was not found", code);
                }

                throw new NativeFailure("PATH_OPEN_FAILED", "path could not be opened", code);
            }

            return handle;
        }

        private static SafeFileHandle NtOpenRelative(
            SafeFileHandle parent,
            string component,
            uint access,
            uint disposition,
            uint options)
        {
            return NtOpenRelativeCore(parent, component, access, disposition, options, IntPtr.Zero);
        }

        private static SafeFileHandle CreatePrivateRelative(
            SafeFileHandle parent,
            string component,
            bool directory,
            uint access)
        {
            using (SecurityDescriptorAllocation descriptor = CreatePrivateDescriptor(directory))
            {
                return NtOpenRelativeCore(
                    parent,
                    component,
                    access,
                    NtFileCreate,
                    (directory ? FileDirectoryFile : FileNonDirectoryFile) |
                        FileOpenReparsePoint | FileSynchronousIoNonAlert,
                    descriptor.Descriptor);
            }
        }

        private static SafeFileHandle NtOpenRelativeCore(
            SafeFileHandle parent,
            string component,
            uint access,
            uint disposition,
            uint options,
            IntPtr securityDescriptor)
        {
            IntPtr nameBuffer = IntPtr.Zero;
            IntPtr unicodePointer = IntPtr.Zero;
            try
            {
                nameBuffer = Marshal.StringToHGlobalUni(component);
                int byteLength = checked(component.Length * 2);
                UNICODE_STRING unicode = new UNICODE_STRING
                {
                    Length = checked((ushort)byteLength),
                    MaximumLength = checked((ushort)(byteLength + 2)),
                    Buffer = nameBuffer
                };
                unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
                Marshal.StructureToPtr(unicode, unicodePointer, false);
                OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES
                {
                    Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
                    RootDirectory = parent.DangerousGetHandle(),
                    ObjectName = unicodePointer,
                    Attributes = ObjCaseInsensitive,
                    SecurityDescriptor = securityDescriptor,
                    SecurityQualityOfService = IntPtr.Zero
                };
                IO_STATUS_BLOCK statusBlock;
                IntPtr rawHandle;
                int status = NtCreateFile(
                    out rawHandle,
                    access,
                    ref attributes,
                    out statusBlock,
                    IntPtr.Zero,
                    FileAttributeNormal,
                    ShareAll,
                    disposition,
                    options,
                    IntPtr.Zero,
                    0);
                if (status < 0)
                {
                    int code = unchecked((int)RtlNtStatusToDosError(status));
                    if (code == ErrorFileExists || code == ErrorAlreadyExists)
                    {
                        throw new NativeFailure("TARGET_EXISTS", "target already exists", code);
                    }

                    if (code == ErrorFileNotFound || code == ErrorPathNotFound)
                    {
                        throw new NativeFailure("PATH_NOT_FOUND", "path component was not found", code);
                    }

                    throw new NativeFailure("NT_OPEN_FAILED", "handle-relative path open failed", code);
                }

                return new SafeFileHandle(rawHandle, true);
            }
            finally
            {
                if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
                if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
            }
        }

        private static FILE_ATTRIBUTE_TAG_INFO GetTag(SafeFileHandle handle)
        {
            FILE_ATTRIBUTE_TAG_INFO information;
            if (!GetFileInformationByHandleEx(
                handle,
                FileAttributeTagInfoClass,
                out information,
                (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))))
            {
                ThrowWin32("FILE_TAG_FAILED", "file attribute tag information is unavailable");
            }

            return information;
        }

        private static void RequirePlainType(SafeFileHandle handle, bool directory)
        {
            FILE_ATTRIBUTE_TAG_INFO tag = GetTag(handle);
            if ((tag.FileAttributes & FileAttributeReparsePoint) != 0 || tag.ReparseTag != 0)
            {
                throw new NativeFailure("REPARSE_POINT", "reparse point was refused");
            }

            bool isDirectory = (tag.FileAttributes & 0x10) != 0;
            if (isDirectory != directory)
            {
                throw new NativeFailure("UNEXPECTED_FILE_TYPE", "path object type was refused");
            }
        }

        private static FILE_ID_INFO GetFileId(SafeFileHandle handle)
        {
            FILE_ID_INFO information;
            if (!GetFileInformationByHandleEx(
                handle,
                FileIdInfoClass,
                out information,
                (uint)Marshal.SizeOf(typeof(FILE_ID_INFO))))
            {
                int code = Marshal.GetLastWin32Error();
                if (code == ErrorInvalidParameter || code == ErrorNotSupported)
                {
                    throw new NativeFailure("NATIVE_UNSUPPORTED", "FILE_ID_INFO is unavailable", code);
                }

                throw new NativeFailure("FILE_ID_FAILED", "file identity is unavailable", code);
            }

            return information;
        }

        private static BY_HANDLE_FILE_INFORMATION GetBasicInfo(SafeFileHandle handle)
        {
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
            {
                ThrowWin32("FILE_INFORMATION_FAILED", "basic file information is unavailable");
            }

            return information;
        }

        private static string FormatObjectIdentity(FILE_ID_INFO identity)
        {
            return "file-v1:" + Protocol.HashFramed(
                "enduragent.windows-file-identity.v1",
                identity.VolumeSerialNumber.ToString("x16", CultureInfo.InvariantCulture),
                Protocol.Hex(identity.FileId.Identifier));
        }

        private static string GetFinalVolumePath(SafeFileHandle handle)
        {
            StringBuilder initial = new StringBuilder(512);
            uint length = GetFinalPathNameByHandleW(handle, initial, (uint)initial.Capacity, 1);
            if (length == 0)
            {
                ThrowWin32("FINAL_PATH_FAILED", "final path identity is unavailable");
            }

            if (length < initial.Capacity)
            {
                return initial.ToString();
            }

            if (length > 32767)
            {
                throw new NativeFailure("FINAL_PATH_TOO_LONG", "final path identity exceeds the supported limit");
            }

            StringBuilder expanded = new StringBuilder(checked((int)length + 1));
            uint second = GetFinalPathNameByHandleW(handle, expanded, (uint)expanded.Capacity, 1);
            if (second == 0 || second >= expanded.Capacity)
            {
                ThrowWin32("FINAL_PATH_FAILED", "final path identity is unstable");
            }

            return expanded.ToString();
        }

        private static string DriveTypeName(uint value)
        {
            if (value == DriveFixed) return "fixed";
            if (value == DriveRemote) return "remote";
            if (value == DriveRemovable) return "removable";
            if (value == 5) return "optical";
            if (value == 6) return "ramdisk";
            if (value == 1) return "no-root";
            return "unknown";
        }

        private static void WriteAll(SafeFileHandle handle, byte[] content)
        {
            int offset = 0;
            while (offset < content.Length)
            {
                int count = Math.Min(64 * 1024, content.Length - offset);
                byte[] chunk = new byte[count];
                Buffer.BlockCopy(content, offset, chunk, 0, count);
                uint written;
                if (!WriteFile(handle, chunk, (uint)count, out written, IntPtr.Zero))
                {
                    ThrowWin32("FILE_WRITE_FAILED", "file write failed");
                }

                if (written == 0 || written > count)
                {
                    throw new NativeFailure("FILE_WRITE_SHORT", "file write made no progress");
                }

                offset += (int)written;
            }
        }

        private static byte[] ReadAll(SafeFileHandle handle, int maximumBytes)
        {
            long ignored;
            if (!SetFilePointerEx(handle, 0, out ignored, 0))
            {
                ThrowWin32("FILE_SEEK_FAILED", "file seek failed");
            }

            using (MemoryStream result = new MemoryStream())
            {
                byte[] buffer = new byte[64 * 1024];
                while (true)
                {
                    uint read;
                    if (!ReadFile(handle, buffer, (uint)buffer.Length, out read, IntPtr.Zero))
                    {
                        ThrowWin32("FILE_READ_FAILED", "file read failed");
                    }

                    if (read == 0) break;
                    if (result.Length + read > maximumBytes)
                    {
                        throw new NativeFailure("FILE_TOO_LARGE", "file exceeds the bounded read limit");
                    }

                    result.Write(buffer, 0, (int)read);
                }

                return result.ToArray();
            }
        }

        private static void SetRename(
            SafeFileHandle source,
            SafeFileHandle destinationParent,
            string destinationName,
            bool replace)
        {
            byte[] name = Encoding.Unicode.GetBytes(destinationName);
            int nameOffset = IntPtr.Size == 8 ? 20 : 12;
            int rootOffset = IntPtr.Size == 8 ? 8 : 4;
            int lengthOffset = IntPtr.Size == 8 ? 16 : 8;
            IntPtr buffer = Marshal.AllocHGlobal(nameOffset + name.Length);
            try
            {
                for (int index = 0; index < nameOffset + name.Length; index += 1)
                {
                    Marshal.WriteByte(buffer, index, 0);
                }

                Marshal.WriteInt32(buffer, 0, replace ? (int)FileRenameReplaceIfExists : 0);
                Marshal.WriteIntPtr(buffer, rootOffset, destinationParent.DangerousGetHandle());
                Marshal.WriteInt32(buffer, lengthOffset, name.Length);
                Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
                if (!SetFileInformationByHandle(
                    source,
                    FileRenameInfoExClass,
                    buffer,
                    (uint)(nameOffset + name.Length)))
                {
                    int code = Marshal.GetLastWin32Error();
                    if (code == ErrorInvalidParameter || code == ErrorNotSupported)
                    {
                        throw new NativeFailure("NATIVE_UNSUPPORTED", "FileRenameInfoEx is unavailable", code);
                    }

                    throw new NativeFailure("RENAME_FAILED", "handle-bound rename failed", code);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static void SetDisposition(SafeFileHandle file)
        {
            IntPtr buffer = Marshal.AllocHGlobal(4);
            try
            {
                Marshal.WriteInt32(buffer, unchecked((int)(FileDispositionDelete | FileDispositionPosixSemantics)));
                if (!SetFileInformationByHandle(file, FileDispositionInfoExClass, buffer, 4))
                {
                    int code = Marshal.GetLastWin32Error();
                    if (code == ErrorInvalidParameter || code == ErrorNotSupported)
                    {
                        throw new NativeFailure("NATIVE_UNSUPPORTED", "FileDispositionInfoEx is unavailable", code);
                    }

                    throw new NativeFailure("DISPOSITION_FAILED", "handle-bound disposition failed", code);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static void TryDisposeOwnedFile(SafeFileHandle file)
        {
            try
            {
                SetDisposition(file);
            }
            catch
            {
            }
        }

        private static void ThrowWin32(string code, string safeMessage)
        {
            throw new NativeFailure(code, safeMessage, Marshal.GetLastWin32Error());
        }
    }
}
