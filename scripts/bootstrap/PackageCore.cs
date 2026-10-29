using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace OatsSetup {
    public sealed class Asset { public string name; public string url; public long size; public string sha256; }
    public sealed class Bundle {
        public int schema; public string id; public string payload_id; public string app_version; public string payload_manifest_sha256;
        public string runtime_manifest_sha256; public long runtime_bytes;
        public string app_installer_sha256; public long app_installer_bytes;
        public long installed_bytes; public Asset[] parts;
    }
    public sealed class PayloadFile { public string path; public long size; public string sha256; }
    public sealed class Payload { public int schema; public PayloadFile[] files; }

    public static class PackageCore {
        public const long MaxPart = 1500L * 1024 * 1024;
        public const long MaxInstaller = 512L * 1024 * 1024;
        public static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        static readonly Regex HashPattern = new Regex("^[a-f0-9]{64}$");
        static readonly Regex Reserved = new Regex("^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$", RegexOptions.IgnoreCase);
        public static string Hash(Stream input) {
            using (SHA256 h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
        }
        public static string HashFile(string path) { using (FileStream f = File.OpenRead(path)) return Hash(f); }
        public static string LongPath(string path) {
            string full = Path.GetFullPath(path);
            if (full.StartsWith(@"\\?\")) return full;
            return full.StartsWith(@"\\") ? @"\\?\UNC\" + full.Substring(2) : @"\\?\" + full;
        }
        public static string Relative(string name) {
            if (String.IsNullOrEmpty(name) || name.Length > 220 || name.Contains("\\")) throw new IOException("Invalid package filename.");
            foreach (string part in name.Split('/')) {
                if (part.Length == 0 || part == "." || part == ".." || part.TrimEnd(' ', '.') != part || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || Reserved.IsMatch(part.Split('.')[0]))
                    throw new IOException("Unsafe package filename: " + name);
            }
            return name;
        }
        public static void NoLinks(string path) {
            for (DirectoryInfo d = new DirectoryInfo(Path.GetFullPath(path)); d != null; d = d.Parent)
                if (d.Exists && (d.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Setup cannot use linked folders: " + d.FullName);
            if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Setup cannot use linked files.");
        }
        public static void Validate(Bundle b) {
            if (b == null || b.schema != 1 || !Regex.IsMatch(b.id ?? "", "^[a-f0-9]{20}$") || !Regex.IsMatch(b.app_version ?? "", "^0\\.[0-9]+\\.[0-9]+$") || !HashPattern.IsMatch(b.payload_manifest_sha256 ?? "") || b.parts == null || b.parts.Length < 1 || b.parts.Length > 64 || b.installed_bytes < 1)
                throw new IOException("Invalid setup manifest.");
            HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string payloadId = b.payload_id ?? b.id;
            if (!Regex.IsMatch(payloadId, "^[a-f0-9]{20}$")) throw new IOException("Invalid payload release identity.");
            if (b.runtime_manifest_sha256 != null && (!HashPattern.IsMatch(b.runtime_manifest_sha256) || b.runtime_bytes < 1 || b.runtime_bytes > 32L * 1024 * 1024)) throw new IOException("Invalid Microsoft runtime manifest.");
            if (b.app_installer_sha256 != null || b.app_installer_bytes != 0) ValidateAppInstaller(b);
            for (int i = 0; i < b.parts.Length; i++) {
                Asset a = b.parts[i];
                if (a == null || a.name != "oats-runtime-" + payloadId + ".zip.part" + (i + 1).ToString("000") || !names.Add(a.name) || a.size < 1 || a.size > MaxPart || !HashPattern.IsMatch(a.sha256 ?? "")) throw new IOException("Invalid setup part.");
                string expected = "https://github.com/Ripplescale/Oats_Transcription_Platform/releases/download/setup-" + payloadId + "/" + a.name;
                if (a.url != expected) throw new IOException("Unexpected setup download address.");
            }
        }
        public static void ValidateAppInstaller(Bundle b) {
            if (b == null || b.app_version == null || b.app_version.Length > 32 || !Regex.IsMatch(b.app_version, "^0\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")
                || !HashPattern.IsMatch(b.app_installer_sha256 ?? "") || b.app_installer_bytes < 3 || b.app_installer_bytes > MaxInstaller)
                throw new IOException("Setup needs a verified current app installer. Download the current Oats-Setup.exe.");
        }
        public static string PublishAppInstaller(Bundle b, Stream input, string package) {
            ValidateAppInstaller(b);
            string directory = LongPath(Path.Combine(package, "setup")); NoLinks(directory); Directory.CreateDirectory(directory);
            string path = Path.Combine(directory, "oats-" + b.app_version + "-" + b.app_installer_sha256.Substring(0, 16) + ".exe"); NoLinks(path);
            if (File.Exists(path)) {
                if (new FileInfo(path).Length != b.app_installer_bytes || HashFile(path) != b.app_installer_sha256) throw new IOException("An existing app installer differs. It was preserved.");
                return path;
            }
            if (input == null) throw new IOException("The current app installer is missing from setup.");
            string temporary = Path.Combine(directory, ".oats-app-" + Guid.NewGuid().ToString("N") + ".tmp");
            try {
                using (FileStream output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                    byte[] block = new byte[1024 * 1024]; int count; long written = 0;
                    while ((count = input.Read(block, 0, block.Length)) > 0) {
                        written = checked(written + count);
                        if (written > b.app_installer_bytes) throw new IOException("The app installer exceeds its verified size.");
                        output.Write(block, 0, count);
                    }
                    if (written != b.app_installer_bytes) throw new IOException("The app installer resource is incomplete.");
                    output.Flush(true);
                }
                using (FileStream check = File.OpenRead(temporary)) {
                    if (check.ReadByte() != 'M' || check.ReadByte() != 'Z') throw new IOException("The app installer is not a Windows executable.");
                }
                if (HashFile(temporary) != b.app_installer_sha256) throw new IOException("The app installer failed its integrity check.");
                File.Move(temporary, path);
                return path;
            } finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        public static bool Verified(string path, Asset a) {
            NoLinks(path);
            return File.Exists(path) && new FileInfo(path).Length == a.size && HashFile(path) == a.sha256;
        }
        public static long RemainingDownloadBytes(Asset[] parts, string folder) {
            long remaining = 0;
            foreach (Asset a in parts) {
                string final = Path.Combine(folder, a.name), partial = final + ".partial";
                if (Verified(final, a)) continue;
                if (File.Exists(final)) throw new IOException("A downloaded part failed verification. It was preserved: " + a.name);
                NoLinks(partial);
                long offset = File.Exists(partial) ? new FileInfo(partial).Length : 0;
                if (offset > a.size) throw new IOException("Partial download is larger than expected.");
                remaining = checked(remaining + a.size - offset);
            }
            return remaining;
        }
        public static long RemainingExtractionBytes(Payload payload, string root) {
            root = LongPath(root); NoLinks(root); long remaining = 0;
            foreach (PayloadFile file in payload.files) {
                string path = Path.Combine(root, Relative(file.path).Replace('/', Path.DirectorySeparatorChar)); NoLinks(path);
                if (File.Exists(path)) {
                    if (new FileInfo(path).Length != file.size || HashFile(path) != file.sha256) throw new IOException("Existing setup file differs; preserved: " + file.path);
                } else remaining = checked(remaining + file.size);
            }
            return remaining;
        }
        public static string PublishConfigureHelper(string root, byte[] bytes) {
            string hash; using (MemoryStream stream = new MemoryStream(bytes)) hash = Hash(stream);
            string directory = Path.Combine(root, "setup"); NoLinks(directory); Directory.CreateDirectory(directory);
            string file = Path.Combine(directory, "configure-" + hash.Substring(0, 16) + ".py"); NoLinks(file);
            if (File.Exists(file)) {
                if (HashFile(file) != hash) throw new IOException("An existing setup helper differs. It was preserved.");
                return file;
            }
            string temporary = Path.Combine(directory, ".oats-helper-" + Guid.NewGuid().ToString("N") + ".tmp");
            try {
                using (FileStream output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { output.Write(bytes, 0, bytes.Length); output.Flush(true); }
                File.Move(temporary, file);
            } finally { if (File.Exists(temporary)) File.Delete(temporary); }
            return file;
        }
        public static async Task Download(Asset a, string folder, HttpClient http, Action<long> progress, CancellationToken cancel) {
            cancel.ThrowIfCancellationRequested();
            Directory.CreateDirectory(folder); NoLinks(folder);
            string final = Path.Combine(folder, a.name); string partial = final + ".partial";
            if (Verified(final, a)) { cancel.ThrowIfCancellationRequested(); progress(a.size); return; }
            if (File.Exists(final)) throw new IOException("A downloaded part failed verification. Move it out of this folder, then retry: " + a.name);
            NoLinks(partial);
            long offset = File.Exists(partial) ? new FileInfo(partial).Length : 0;
            if (offset > a.size) throw new IOException("Partial download is larger than expected.");
            if (offset == a.size) {
                if (HashFile(partial) != a.sha256) { File.Delete(partial); throw new IOException("A partial download is damaged. Retry downloads to fetch it again."); }
                File.Move(partial, final); progress(a.size); return;
            }
            using (HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Get, a.url)) {
                if (offset > 0) req.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(offset, null);
                using (HttpResponseMessage response = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cancel).ConfigureAwait(false)) {
                    response.EnsureSuccessStatusCode();
                    if (response.RequestMessage != null && response.RequestMessage.RequestUri.Scheme != "https") throw new IOException("Setup requires HTTPS downloads.");
                    if (response.StatusCode == HttpStatusCode.PartialContent) {
                        var range = response.Content.Headers.ContentRange;
                        if (range == null || range.From != offset || range.Length != a.size || range.To != a.size - 1) throw new IOException("The download server returned an inconsistent range.");
                    } else if (response.StatusCode == HttpStatusCode.OK) { offset = 0; }
                    else throw new IOException("Unexpected download response.");
                    if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != a.size - offset) throw new IOException("Unexpected download size.");
                    using (Stream input = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    using (FileStream output = new FileStream(partial, offset > 0 ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None)) {
                        byte[] block = new byte[1024 * 1024]; int count; long received = offset;
                        while ((count = await input.ReadAsync(block, 0, block.Length, cancel).ConfigureAwait(false)) > 0) {
                            received = checked(received + count); if (received > a.size) throw new IOException("Download exceeds the expected size.");
                            await output.WriteAsync(block, 0, count, cancel).ConfigureAwait(false); progress(received);
                        }
                        if (received != a.size) throw new IOException("Download interrupted. Retry to resume it.");
                    }
                }
            }
            cancel.ThrowIfCancellationRequested();
            if (HashFile(partial) != a.sha256) { File.Delete(partial); throw new IOException("Download integrity check failed. Retry to fetch this part again."); }
            File.Move(partial, final);
        }
        public static Payload ReadPayload(ZipArchive zip, Bundle b) {
            ZipArchiveEntry entry = zip.GetEntry("payload-manifest.json");
            if (entry == null || entry.Length > 16 * 1024 * 1024) throw new IOException("Package file manifest is missing or too large.");
            byte[] bytes;
            using (MemoryStream m = new MemoryStream()) { using (Stream s = entry.Open()) s.CopyTo(m); bytes = m.ToArray(); }
            using (MemoryStream m = new MemoryStream(bytes)) if (Hash(m) != b.payload_manifest_sha256) throw new IOException("Package manifest integrity check failed.");
            Payload p = Json.Deserialize<Payload>(System.Text.Encoding.UTF8.GetString(bytes));
            if (p == null || p.schema != 1 || p.files == null || p.files.Length > 50000) throw new IOException("Invalid package file manifest.");
            Dictionary<string, PayloadFile> expected = new Dictionary<string, PayloadFile>(StringComparer.OrdinalIgnoreCase);
            long total = 0;
            foreach (PayloadFile f in p.files) {
                Relative(f.path);
                if (!(f.path.StartsWith("python/") || f.path.StartsWith("env/") || f.path.StartsWith("models/") || f.path.StartsWith("worker/") || f.path.StartsWith("tools/") || f.path.StartsWith("setup/")) || f.size < 0 || !HashPattern.IsMatch(f.sha256 ?? "") || expected.ContainsKey(f.path)) throw new IOException("Unexpected package content.");
                expected.Add(f.path, f); total = checked(total + f.size);
            }
            if (total != b.installed_bytes || zip.Entries.Count != expected.Count + 1) throw new IOException("Package size or file count differs from its manifest.");
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (ZipArchiveEntry e in zip.Entries) {
                if (!seen.Add(e.FullName) || ((e.ExternalAttributes >> 16) & 0xF000) == 0xA000) throw new IOException("Duplicate or linked archive entry.");
                if (e.FullName == "payload-manifest.json") continue;
                PayloadFile f; if (!expected.TryGetValue(e.FullName, out f) || f.size != e.Length) throw new IOException("Archive file differs from its manifest.");
            }
            return p;
        }
        public static void Extract(ZipArchive zip, Payload p, string root, Action<long> progress, CancellationToken cancel) {
            root = LongPath(root);
            NoLinks(root); Directory.CreateDirectory(root); long done = 0;
            foreach (PayloadFile f in p.files) {
                cancel.ThrowIfCancellationRequested();
                string path = Path.Combine(root, Relative(f.path).Replace('/', Path.DirectorySeparatorChar)); NoLinks(path);
                if (File.Exists(path)) {
                    if (new FileInfo(path).Length != f.size || HashFile(path) != f.sha256) throw new IOException("Existing setup file differs; preserved: " + f.path);
                    done += f.size; progress(done); continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(path)); NoLinks(path);
                string temp = Path.Combine(Path.GetDirectoryName(path), ".oats-" + Guid.NewGuid().ToString("N") + ".tmp");
                try {
                    using (Stream input = zip.GetEntry(f.path).Open())
                    using (FileStream output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    using (SHA256 h = SHA256.Create()) {
                        byte[] block = new byte[1024 * 1024]; int count; long written = 0;
                        while ((count = input.Read(block, 0, block.Length)) > 0) {
                            cancel.ThrowIfCancellationRequested(); written += count; if (written > f.size) throw new IOException("Expanded file exceeds expected size.");
                            h.TransformBlock(block, 0, count, null, 0); output.Write(block, 0, count); progress(done + written);
                        }
                        h.TransformFinalBlock(new byte[0], 0, 0);
                        if (written != f.size || BitConverter.ToString(h.Hash).Replace("-", "").ToLowerInvariant() != f.sha256) throw new IOException("Extracted file integrity check failed: " + f.path);
                    }
                    File.Move(temp, path);
                } finally { if (File.Exists(temp)) File.Delete(temp); }
                done += f.size;
            }
        }
    }
    public static class RuntimeDirectories {
        public static string PackageFromConfig(string root, Dictionary<string, object> config) {
            object modelsValue, trelisValue, apexValue, cacheValue, workValue;
            if (!config.TryGetValue("models", out modelsValue)) throw new IOException("Speech model configuration is missing.");
            var models = modelsValue as Dictionary<string, object>;
            if (models == null || !models.TryGetValue("trelis", out trelisValue) || !models.TryGetValue("apex", out apexValue)) throw new IOException("Trelis or Apex configuration is missing.");
            var trelis = trelisValue as Dictionary<string, object>; var apex = apexValue as Dictionary<string, object>;
            if (trelis == null || apex == null || !trelis.TryGetValue("cache_dir", out cacheValue) || !apex.TryGetValue("work_dir", out workValue) || !(cacheValue is string) || !(workValue is string)) throw new IOException("This repair requires the complete-setup cache and workspace paths.");
            string cache = Path.GetFullPath((string)cacheValue), work = Path.GetFullPath((string)workValue);
            string package = Path.GetDirectoryName(Path.GetDirectoryName(cache));
            if (!String.Equals(Path.GetDirectoryName(package), Path.Combine(Path.GetFullPath(root), "packages"), StringComparison.OrdinalIgnoreCase)
                || !Regex.IsMatch(Path.GetFileName(package), "^[a-f0-9]{20}$")
                || !String.Equals(cache, Path.Combine(package, @"cache\openvino"), StringComparison.OrdinalIgnoreCase)
                || !String.Equals(work, Path.Combine(package, @"cache\apex"), StringComparison.OrdinalIgnoreCase)) throw new IOException("The configured working folders do not belong to a complete oats setup. Nothing was changed.");
            PackageCore.NoLinks(package); return package;
        }
        public static string[] Ensure(string package) {
            package = Path.GetFullPath(package); PackageCore.NoLinks(package);
            if (!Directory.Exists(package)) throw new IOException("The installed speech package is missing. Nothing was changed.");
            string[] paths = { Path.Combine(package, @"cache\openvino"), Path.Combine(package, @"cache\apex") };
            // Check both destinations before making either one. Never remove a
            // conflicting file, follow a junction or change runtime snapshots.
            foreach (string path in paths) { PackageCore.NoLinks(path); if (File.Exists(path)) throw new IOException("A file occupies a required work-folder path; it was preserved: " + path); }
            foreach (string path in paths) {
                Directory.CreateDirectory(PackageCore.LongPath(path)); PackageCore.NoLinks(path);
                string probe = PackageCore.LongPath(Path.Combine(path, ".oats-write-check-" + Guid.NewGuid().ToString("N")));
                using (FileStream owned = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose)) owned.WriteByte(0);
            }
            return paths;
        }
    }
    // ZIP64 can seek directly over the downloaded parts; no extra joined archive
    // or multi-gigabyte memory allocation is needed during offline extraction.
    public sealed class SplitStream : Stream {
        readonly List<FileStream> files = new List<FileStream>(); readonly List<long> starts = new List<long>(); long length; long position;
        public SplitStream(IEnumerable<string> paths) {
            try { foreach (string p in paths) { PackageCore.NoLinks(p); starts.Add(length); FileStream f = File.OpenRead(p); files.Add(f); length = checked(length + f.Length); } }
            catch { Dispose(); throw; }
        }
        public override int Read(byte[] buffer, int offset, int count) {
            int read = 0;
            while (count > 0 && position < length) {
                int index = starts.Count - 1; while (index > 0 && starts[index] > position) index--;
                FileStream f = files[index]; f.Position = position - starts[index];
                int n = f.Read(buffer, offset, (int)Math.Min(count, f.Length - f.Position)); if (n == 0) throw new EndOfStreamException();
                position += n; offset += n; count -= n; read += n;
            }
            return read;
        }
        public override long Seek(long offset, SeekOrigin origin) { long n = checked((origin == SeekOrigin.Begin ? 0 : origin == SeekOrigin.Current ? position : length) + offset); if (n < 0) throw new IOException("Negative archive offset."); position = n; return n; }
        public override long Position { get { return position; } set { Seek(value, SeekOrigin.Begin); } }
        public override long Length { get { return length; } }
        public override bool CanRead { get { return true; } } public override bool CanSeek { get { return true; } } public override bool CanWrite { get { return false; } }
        public override void Flush() {} public override void SetLength(long n) { throw new NotSupportedException(); } public override void Write(byte[] b, int o, int c) { throw new NotSupportedException(); }
        protected override void Dispose(bool disposing) { if (disposing) foreach (FileStream f in files) f.Dispose(); base.Dispose(disposing); }
    }
}
