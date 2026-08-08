using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace Enduragent.WindowsHostFalsifier
{
    internal sealed class NativeFailure : Exception
    {
        internal readonly string Code;
        internal readonly int? NativeCode;

        internal NativeFailure(string code, string safeMessage)
            : this(code, safeMessage, null)
        {
        }

        internal NativeFailure(string code, string safeMessage, int? nativeCode)
            : base(safeMessage)
        {
            Code = code;
            NativeCode = nativeCode;
        }
    }

    internal sealed class RequestFrame
    {
        internal int ProtocolVersion;
        internal string RequestId;
        internal string Command;
        internal string RequestFrameSha256;
        internal Dictionary<string, object> Context;
        internal Dictionary<string, object> Request;
    }

    internal static class Protocol
    {
        internal const int Version = 1;
        internal const int MaxInputFrameBytes = 64 * 1024;
        internal const int MaxOutputFrameBytes = 256 * 1024;
        internal const int MaxContentBytes = 4 * 1024 * 1024;

        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static readonly JavaScriptSerializer Json = CreateSerializer();
        private static readonly object OutputLock = new object();
        private static readonly Regex RequestIdPattern =
            new Regex(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", RegexOptions.CultureInvariant);
        private static readonly Regex LowerHex64 =
            new Regex(@"^[a-f0-9]{64}$", RegexOptions.CultureInvariant);

        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = MaxOutputFrameBytes;
            serializer.RecursionLimit = 24;
            return serializer;
        }

        internal static RequestFrame ReadRequest(Stream input)
        {
            byte[] bytes = ReadLine(input);
            if (bytes == null)
            {
                return null;
            }

            string text;
            try
            {
                text = StrictUtf8.GetString(bytes);
            }
            catch (DecoderFallbackException)
            {
                throw new NativeFailure("PROTOCOL_UTF8", "request frame is not valid UTF-8");
            }

            Dictionary<string, object> value;
            try
            {
                value = Json.DeserializeObject(text) as Dictionary<string, object>;
            }
            catch
            {
                throw new NativeFailure("PROTOCOL_JSON", "request frame is not valid JSON");
            }

            if (value == null)
            {
                throw new NativeFailure("PROTOCOL_OBJECT", "request frame must be an object");
            }

            RequireExactKeys(
                value,
                new string[] { "protocolVersion", "requestId", "command", "context", "request" },
                "request frame");
            int protocolVersion = RequireInt(value, "protocolVersion", 1, 1);
            if (protocolVersion != Version)
            {
                throw new NativeFailure("PROTOCOL_VERSION", "unsupported protocol version");
            }

            string requestId = RequireString(value, "requestId", 1, 64);
            if (!RequestIdPattern.IsMatch(requestId))
            {
                throw new NativeFailure("PROTOCOL_REQUEST_ID", "request id is invalid");
            }

            string command = RequireString(value, "command", 1, 64);
            Dictionary<string, object> context = RequireObject(value, "context");
            RequireExactKeys(
                context,
                new string[] {
                    "campaignRunId", "candidateSha256", "preflightSha256",
                    "executionBundleManifestSha256", "nativeCandidateDigest",
                    "nativeManifestSha256",
                    "nativeHelperSha256", "evidenceRootObjectIdentitySha256",
                    "nativeSessionId", "operationId"
                },
                "request context");
            RequireString(context, "campaignRunId", 2, 128);
            RequireLowerHex64(context, "candidateSha256");
            RequireLowerHex64(context, "preflightSha256");
            RequireLowerHex64(context, "executionBundleManifestSha256");
            RequireLowerHex64(context, "nativeCandidateDigest");
            RequireLowerHex64(context, "nativeManifestSha256");
            RequireLowerHex64(context, "nativeHelperSha256");
            RequireLowerHex64(context, "evidenceRootObjectIdentitySha256");
            string nativeSessionId = RequireString(context, "nativeSessionId", 2, 64);
            string operationId = RequireString(context, "operationId", 2, 64);
            if (!RequestIdPattern.IsMatch(nativeSessionId) || !RequestIdPattern.IsMatch(operationId))
                throw new NativeFailure("PROTOCOL_CONTEXT", "request context identifier is invalid");
            Dictionary<string, object> request = RequireObject(value, "request");
            return new RequestFrame
            {
                ProtocolVersion = protocolVersion,
                RequestId = requestId,
                Command = command,
                RequestFrameSha256 = Sha256(bytes),
                Context = context,
                Request = request
            };
        }

        internal static Dictionary<string, object> ReadStandaloneObject(Stream input, string label)
        {
            byte[] bytes = ReadLine(input);
            if (bytes == null)
            {
                return null;
            }

            string text;
            try
            {
                text = StrictUtf8.GetString(bytes);
            }
            catch (DecoderFallbackException)
            {
                throw new NativeFailure("PROTOCOL_UTF8", label + " is not valid UTF-8");
            }

            try
            {
                Dictionary<string, object> value =
                    Json.DeserializeObject(text) as Dictionary<string, object>;
                if (value == null)
                {
                    throw new NativeFailure("PROTOCOL_OBJECT", label + " must be an object");
                }
                SortedDictionary<string, object> sorted =
                    new SortedDictionary<string, object>(StringComparer.Ordinal);
                foreach (KeyValuePair<string, object> entry in value)
                {
                    sorted.Add(entry.Key, entry.Value);
                }
                if (!String.Equals(Json.Serialize(sorted), text, StringComparison.Ordinal))
                {
                    throw new NativeFailure(
                        "PROTOCOL_CANONICAL",
                        label + " must be exact canonical JSON");
                }
                return value;
            }
            catch (NativeFailure)
            {
                throw;
            }
            catch
            {
                throw new NativeFailure("PROTOCOL_JSON", label + " is not valid JSON");
            }
        }

        private static byte[] ReadLine(Stream input)
        {
            MemoryStream buffer = new MemoryStream();
            while (true)
            {
                int next = input.ReadByte();
                if (next < 0)
                {
                    if (buffer.Length == 0)
                    {
                        return null;
                    }

                    throw new NativeFailure("PROTOCOL_TERMINATOR", "request frame is missing a line terminator");
                }

                if (next == 0)
                {
                    throw new NativeFailure("PROTOCOL_NUL", "request frame contains a NUL byte");
                }

                if (next == (byte)'\n')
                {
                    byte[] result = buffer.ToArray();
                    if (result.Length > 0 && result[result.Length - 1] == (byte)'\r')
                    {
                        Array.Resize(ref result, result.Length - 1);
                    }

                    if (result.Length == 0)
                    {
                        throw new NativeFailure("PROTOCOL_EMPTY", "request frame is empty");
                    }

                    return result;
                }

                buffer.WriteByte((byte)next);
                if (buffer.Length > MaxInputFrameBytes)
                {
                    throw new NativeFailure("PROTOCOL_FRAME_TOO_LARGE", "request frame exceeds the byte limit");
                }
            }
        }

        internal static void WriteSuccess(RequestFrame request, Dictionary<string, object> result)
        {
            Dictionary<string, object> frame = Object(
                "protocolVersion", Version,
                "kind", "response",
                "requestId", request.RequestId,
                "command", request.Command,
                "context", ResponseContext(request),
                "ok", true,
                "result", result);
            WriteFrame(frame);
        }

        internal static void WriteFailure(RequestFrame request, NativeFailure failure)
        {
            Dictionary<string, object> error = Object(
                "code", failure.Code,
                "message", failure.Message,
                "win32Code", failure.NativeCode.HasValue ? (object)failure.NativeCode.Value : null);
            Dictionary<string, object> frame = Object(
                "protocolVersion", Version,
                "kind", "response",
                "requestId", request.RequestId,
                "command", request.Command,
                "context", ResponseContext(request),
                "ok", false,
                "error", error);
            WriteFrame(frame);
        }

        internal static void WriteEvent(
            string sessionId,
            string operationId,
            long sequence,
            string eventName,
            Dictionary<string, object> data)
        {
            Dictionary<string, object> frame = Object(
                "protocolVersion", Version,
                "kind", "event",
                "sessionId", sessionId,
                "context", Object(
                    "campaignRunId", RuntimeBinding.CampaignRunId,
                    "candidateSha256", RuntimeBinding.CandidateSha256,
                    "preflightSha256", RuntimeBinding.PreflightSha256,
                    "executionBundleManifestSha256", RuntimeBinding.ExecutionBundleManifestSha256,
                    "nativeCandidateDigest", RuntimeBinding.NativeCandidateDigest,
                    "nativeManifestSha256", RuntimeBinding.NativeManifestSha256,
                    "nativeHelperSha256", RuntimeBinding.NativeHelperSha256,
                    "evidenceRootObjectIdentitySha256", RuntimeBinding.EvidenceRootObjectIdentitySha256,
                    "nativeSessionId", RuntimeBinding.NativeSessionId,
                    "operationId", operationId,
                    "runRootIdentity", RuntimeBinding.RunRootIdentity),
                "sequence", sequence,
                "event", eventName,
                "data", data);
            WriteFrame(frame);
        }

        internal static void WriteStandalone(Dictionary<string, object> value)
        {
            SortedDictionary<string, object> sorted =
                new SortedDictionary<string, object>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, object> entry in value)
            {
                sorted.Add(entry.Key, entry.Value);
            }

            string text;
            try
            {
                text = Json.Serialize(sorted);
            }
            catch
            {
                throw new NativeFailure("PROTOCOL_SERIALIZE", "standalone response could not be serialized");
            }

            byte[] bytes = StrictUtf8.GetBytes(text + "\n");
            if (bytes.Length > MaxOutputFrameBytes)
            {
                throw new NativeFailure("PROTOCOL_OUTPUT_TOO_LARGE", "standalone response exceeds the byte limit");
            }

            Stream output = Console.OpenStandardOutput();
            output.Write(bytes, 0, bytes.Length);
            output.Flush();
        }

        private static Dictionary<string, object> ResponseContext(RequestFrame request)
        {
            Dictionary<string, object> requestContext = request.Context;
            return Object(
                "campaignRunId", requestContext["campaignRunId"],
                "candidateSha256", requestContext["candidateSha256"],
                "preflightSha256", requestContext["preflightSha256"],
                "executionBundleManifestSha256", requestContext["executionBundleManifestSha256"],
                "nativeCandidateDigest", requestContext["nativeCandidateDigest"],
                "nativeManifestSha256", requestContext["nativeManifestSha256"],
                "nativeHelperSha256", requestContext["nativeHelperSha256"],
                "evidenceRootObjectIdentitySha256", requestContext["evidenceRootObjectIdentitySha256"],
                "nativeSessionId", requestContext["nativeSessionId"],
                "operationId", requestContext["operationId"],
                "requestFrameSha256", request.RequestFrameSha256,
                "runRootIdentity", RuntimeBinding.RunRootIdentity);
        }

        private static void WriteFrame(Dictionary<string, object> value)
        {
            string text;
            try
            {
                text = Json.Serialize(value);
            }
            catch
            {
                throw new NativeFailure("PROTOCOL_SERIALIZE", "response could not be serialized");
            }

            byte[] bytes = StrictUtf8.GetBytes(text + "\n");
            if (bytes.Length > MaxOutputFrameBytes)
            {
                throw new NativeFailure("PROTOCOL_OUTPUT_TOO_LARGE", "response frame exceeds the byte limit");
            }

            lock (OutputLock)
            {
                Stream output = Console.OpenStandardOutput();
                output.Write(bytes, 0, bytes.Length);
                output.Flush();
            }
        }

        internal static NativeFailure Sanitize(Exception error)
        {
            NativeFailure known = error as NativeFailure;
            if (known != null)
            {
                return known;
            }

            return new NativeFailure("NATIVE_INTERNAL", "native helper operation failed");
        }

        internal static Dictionary<string, object> Object(params object[] pairs)
        {
            if (pairs.Length % 2 != 0)
            {
                throw new InvalidOperationException("object pairs must be even");
            }

            Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.Ordinal);
            for (int index = 0; index < pairs.Length; index += 2)
            {
                result.Add((string)pairs[index], pairs[index + 1]);
            }

            return result;
        }

        internal static void RequireExactKeys(
            Dictionary<string, object> value,
            string[] required,
            string label)
        {
            RequireKeys(value, required, required, label);
        }

        internal static void RequireKeys(
            Dictionary<string, object> value,
            string[] required,
            string[] permittedKeys,
            string label)
        {
            HashSet<string> permitted = new HashSet<string>(permittedKeys, StringComparer.Ordinal);
            foreach (string key in value.Keys)
            {
                if (!permitted.Contains(key))
                {
                    throw new NativeFailure("PROTOCOL_UNKNOWN_KEY", label + " contains an unexpected key");
                }
            }

            foreach (string key in required)
            {
                if (!value.ContainsKey(key))
                {
                    throw new NativeFailure("PROTOCOL_MISSING_KEY", label + " is missing a required key");
                }
            }
        }

        internal static string RequireString(
            Dictionary<string, object> value,
            string key,
            int minimumLength,
            int maximumLength)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || !(raw is string))
            {
                throw new NativeFailure("PROTOCOL_STRING", key + " must be a string");
            }

            string result = (string)raw;
            if (result.Length < minimumLength || result.Length > maximumLength || result.IndexOf('\0') >= 0)
            {
                throw new NativeFailure("PROTOCOL_STRING", key + " has an invalid length");
            }

            return result;
        }

        internal static int RequireInt(
            Dictionary<string, object> value,
            string key,
            int minimum,
            int maximum)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || raw is bool)
            {
                throw new NativeFailure("PROTOCOL_INTEGER", key + " must be an integer");
            }

            long result;
            if (raw is int)
            {
                result = (int)raw;
            }
            else if (raw is long)
            {
                result = (long)raw;
            }
            else if (raw is decimal && decimal.Truncate((decimal)raw) == (decimal)raw)
            {
                result = decimal.ToInt64((decimal)raw);
            }
            else
            {
                throw new NativeFailure("PROTOCOL_INTEGER", key + " must be an integer");
            }

            if (result < minimum || result > maximum)
            {
                throw new NativeFailure("PROTOCOL_INTEGER", key + " is outside the allowed range");
            }

            return (int)result;
        }

        internal static Dictionary<string, object> RequireObject(
            Dictionary<string, object> value,
            string key)
        {
            object raw;
            Dictionary<string, object> result;
            if (!value.TryGetValue(key, out raw) || (result = raw as Dictionary<string, object>) == null)
            {
                throw new NativeFailure("PROTOCOL_OBJECT", key + " must be an object");
            }

            return result;
        }

        internal static string[] RequireStringArray(
            Dictionary<string, object> value,
            string key,
            int maximumEntries,
            int maximumEntryLength)
        {
            object raw;
            if (!value.TryGetValue(key, out raw))
            {
                throw new NativeFailure("PROTOCOL_ARRAY", key + " must be an array");
            }

            object[] array = raw as object[];
            if (array == null)
            {
                ArrayList list = raw as ArrayList;
                if (list != null)
                {
                    array = list.ToArray();
                }
            }

            if (array == null || array.Length > maximumEntries)
            {
                throw new NativeFailure("PROTOCOL_ARRAY", key + " has an invalid length");
            }

            string[] result = new string[array.Length];
            for (int index = 0; index < array.Length; index += 1)
            {
                string entry = array[index] as string;
                if (entry == null || entry.Length > maximumEntryLength || entry.IndexOf('\0') >= 0)
                {
                    throw new NativeFailure("PROTOCOL_ARRAY", key + " contains an invalid entry");
                }

                result[index] = entry;
            }

            return result;
        }

        internal static byte[] RequireBase64(
            Dictionary<string, object> value,
            string key,
            int maximumBytes)
        {
            string encoded = RequireString(value, key, 0, ((maximumBytes + 2) / 3) * 4);
            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(encoded);
            }
            catch
            {
                throw new NativeFailure("PROTOCOL_BASE64", key + " is not canonical base64");
            }

            if (bytes.Length > maximumBytes || Convert.ToBase64String(bytes) != encoded)
            {
                throw new NativeFailure("PROTOCOL_BASE64", key + " is not canonical bounded base64");
            }

            return bytes;
        }

        internal static string RequireLowerHex64(Dictionary<string, object> value, string key)
        {
            string result = RequireString(value, key, 64, 64);
            if (!LowerHex64.IsMatch(result))
            {
                throw new NativeFailure("PROTOCOL_HEX", key + " must be 64 lowercase hexadecimal characters");
            }

            return result;
        }

        internal static string Sha256(byte[] bytes)
        {
            using (SHA256 hash = SHA256.Create())
            {
                return Hex(hash.ComputeHash(bytes));
            }
        }

        internal static string Sha256(string value)
        {
            return Sha256(StrictUtf8.GetBytes(value));
        }

        internal static string HashFramed(params string[] fields)
        {
            using (SHA256 hash = SHA256.Create())
            {
                foreach (string field in fields)
                {
                    byte[] bytes = StrictUtf8.GetBytes(field);
                    if (bytes.LongLength > UInt32.MaxValue)
                    {
                        throw new NativeFailure("HASH_FIELD_TOO_LARGE", "identity field exceeds framing limit");
                    }

                    uint length = (uint)bytes.Length;
                    byte[] lengthBytes = new byte[] {
                        (byte)(length >> 24),
                        (byte)(length >> 16),
                        (byte)(length >> 8),
                        (byte)length
                    };
                    hash.TransformBlock(lengthBytes, 0, lengthBytes.Length, lengthBytes, 0);
                    if (bytes.Length != 0)
                        hash.TransformBlock(bytes, 0, bytes.Length, bytes, 0);
                }
                hash.TransformFinalBlock(new byte[0], 0, 0);
                return Hex(hash.Hash);
            }
        }

        internal static string Hex(byte[] bytes)
        {
            StringBuilder value = new StringBuilder(bytes.Length * 2);
            foreach (byte entry in bytes)
            {
                value.Append(entry.ToString("x2", CultureInfo.InvariantCulture));
            }

            return value.ToString();
        }

        internal static byte[] ParseHex(string value)
        {
            if (value == null || value.Length % 2 != 0)
            {
                throw new NativeFailure("PROTOCOL_HEX", "hexadecimal value is invalid");
            }

            byte[] result = new byte[value.Length / 2];
            for (int index = 0; index < result.Length; index += 1)
            {
                int high = HexValue(value[index * 2]);
                int low = HexValue(value[index * 2 + 1]);
                if (high < 0 || low < 0)
                {
                    throw new NativeFailure("PROTOCOL_HEX", "hexadecimal value is invalid");
                }

                result[index] = (byte)((high << 4) | low);
            }

            return result;
        }

        internal static bool FixedTimeEquals(byte[] left, byte[] right)
        {
            int length = Math.Max(left == null ? 0 : left.Length, right == null ? 0 : right.Length);
            int difference = (left == null ? 0 : left.Length) ^ (right == null ? 0 : right.Length);
            for (int index = 0; index < length; index += 1)
            {
                byte leftByte = left != null && index < left.Length ? left[index] : (byte)0;
                byte rightByte = right != null && index < right.Length ? right[index] : (byte)0;
                difference |= leftByte ^ rightByte;
            }

            return difference == 0;
        }

        private static int HexValue(char value)
        {
            if (value >= '0' && value <= '9') return value - '0';
            if (value >= 'a' && value <= 'f') return value - 'a' + 10;
            return -1;
        }
    }
}
