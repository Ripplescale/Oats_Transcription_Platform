using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]

namespace OatsSetup {
    public sealed class SetupWindow : Form {
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);
        static bool NativeX64() { ushort process, native; return IsWow64Process2(Process.GetCurrentProcess().Handle, out process, out native) && native == 0x8664; }
        readonly Bundle bundle;
        readonly Label title = new Label(); readonly Label status = new Label(); readonly Label detail = new Label();
        readonly TextBox folder = new TextBox(); readonly Button browse = new Button();
        readonly Button install = new Button(); readonly Button save = new Button(); readonly Button cancel = new Button(); readonly ProgressBar bar = new ProgressBar();
        CancellationTokenSource cancellation; bool busy; bool handoff;
        long lastReport;
        public SetupWindow(Bundle b) {
            bundle = b; Text = "oats setup"; ClientSize = new Size(560, 340); FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(255, 252, 248); Font = new Font("Segoe UI", 10);
            title.SetBounds(24, 20, 510, 32); title.Text = "Set up oats on this PC"; title.Font = new Font("Segoe UI", 17, FontStyle.Bold);
            detail.SetBounds(24, 61, 510, 72); detail.Text = "Recording, notes, Trelis dictation and transcription, and Apex fallback.\nDownload once from GitHub. Keep this entire folder for offline setup.\nOptional speaker identification is not included in this package.";
            folder.SetBounds(24, 141, 418, 26); folder.Text = AppDomain.CurrentDomain.BaseDirectory;
            browse.SetBounds(452, 140, 84, 28); browse.Text = "Browse…";
            status.SetBounds(24, 183, 512, 43); status.Text = "App " + b.app_version + " · " + GiB(b.parts.Sum(x => x.size)) + " download · " + GiB(b.installed_bytes) + " installed.\nChoose a folder with enough free space for all downloaded parts.";
            bar.SetBounds(24, 231, 512, 12);
            install.SetBounds(24, 271, 182, 38); install.Text = "Download and install";
            save.SetBounds(216, 271, 192, 38); save.Text = "Save for offline setup";
            cancel.SetBounds(420, 271, 116, 38); cancel.Text = "Close";
            Controls.AddRange(new Control[] { title, detail, folder, browse, status, bar, install, save, cancel });
            browse.Click += delegate { using (FolderBrowserDialog d = new FolderBrowserDialog()) { d.Description = "Keep the setup program and all its downloaded parts together"; d.SelectedPath = folder.Text; if (d.ShowDialog(this) == DialogResult.OK) folder.Text = d.SelectedPath; } };
            install.Click += async delegate { await Run(true); }; save.Click += async delegate { await Run(false); };
            cancel.Click += delegate { if (busy && !handoff) cancellation.Cancel(); else if (!busy) Close(); };
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) { e.Cancel = true; if (!handoff) cancellation.Cancel(); } };
        }
        static string GiB(long bytes) { return (bytes / 1073741824.0).ToString("0.0") + " GiB"; }
        void Report(string text, long done, long total) {
            if (InvokeRequired) {
                long now = Stopwatch.GetTimestamp();
                if (done != total && now - Interlocked.Read(ref lastReport) < Stopwatch.Frequency / 10) return;
                Interlocked.Exchange(ref lastReport, now);
                BeginInvoke(new Action<string, long, long>(Report), text, done, total); return;
            }
            status.Text = text; bar.Value = total <= 0 ? 0 : Math.Min(100, (int)(100.0 * done / total));
        }
        static void Space(string directory, long required) {
            DriveInfo drive = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(directory)));
            if (drive.AvailableFreeSpace < required + 512L * 1024 * 1024) throw new IOException("Not enough free space on " + drive.Name + ". Need approximately " + GiB(required) + " plus some working space.");
        }
        static int Child(string exe, string args, string working) {
            ProcessStartInfo start = new ProcessStartInfo(exe, args) { WorkingDirectory = working, UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true };
            using (Process p = Process.Start(start)) {
                Task<string> stdout = p.StandardOutput.ReadToEndAsync(); Task<string> stderr = p.StandardError.ReadToEndAsync();
                if (!p.WaitForExit(15 * 60 * 1000)) { p.Kill(); throw new IOException("A setup component timed out. Your recordings and notes were not changed."); }
                Task.WaitAll(stdout, stderr);
                if (p.ExitCode != 0 && p.ExitCode != 3010) throw new IOException("A setup component could not finish (code " + p.ExitCode + "). " + (stderr.Result.Length > 1500 ? stderr.Result.Substring(stderr.Result.Length - 1500) : stderr.Result));
                return p.ExitCode;
            }
        }
        static bool WebViewInstalled() {
            foreach (RegistryHive hive in new RegistryHive[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
            foreach (RegistryView view in new RegistryView[] { RegistryView.Registry32, RegistryView.Registry64 })
                using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
                using (RegistryKey key = root.OpenSubKey(@"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}")) {
                    string version = key == null ? null : key.GetValue("pv") as string; if (!String.IsNullOrEmpty(version) && version != "0.0.0.0") return true;
                }
            return false;
        }
        static string Quote(string value) { if (value.Contains("\"")) throw new IOException("Invalid setup path."); return "\"" + value + "\""; }
        async Task Run(bool doInstall) {
            if (busy) return; cancellation = new CancellationTokenSource(); busy = true;
            install.Enabled = save.Enabled = browse.Enabled = folder.Enabled = false; cancel.Text = "Cancel";
            try {
                if (!Environment.Is64BitOperatingSystem || !NativeX64()) throw new IOException("This package supports Windows x64 PCs. Windows ARM and macOS need a different package.");
                string cache = Path.GetFullPath(folder.Text); PackageCore.NoLinks(cache); Directory.CreateDirectory(cache);
                Report("Checking previously downloaded parts…", 0, 1);
                // Estimate disk space from lengths; Download performs the full
                // hash check once, including for offline parts.
                long remaining = bundle.parts.Where(a => !File.Exists(Path.Combine(cache, a.name)) || new FileInfo(Path.Combine(cache, a.name)).Length != a.size).Sum(a => a.size);
                Space(cache, remaining);
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                using (HttpClient http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = true, MaxAutomaticRedirections = 10 }) { Timeout = TimeSpan.FromHours(2) }) {
                    http.DefaultRequestHeaders.UserAgent.ParseAdd("oats-setup/1.0");
                    for (int i = 0; i < bundle.parts.Length; i++) {
                        Asset a = bundle.parts[i]; int n = i + 1;
                        await Task.Run(() => PackageCore.Download(a, cache, http, x => Report("Downloading and verifying part " + n + " of " + bundle.parts.Length + "\n" + GiB(x) + " of " + GiB(a.size), x, a.size), cancellation.Token));
                    }
                }
                string self = Assembly.GetExecutingAssembly().Location; string saved = Path.Combine(cache, "Oats-Setup.exe");
                PackageCore.NoLinks(saved);
                if (!String.Equals(self, saved, StringComparison.OrdinalIgnoreCase)) {
                    if (File.Exists(saved)) { if (PackageCore.HashFile(saved) != PackageCore.HashFile(self)) throw new IOException("A different setup program already exists in this folder. Choose a separate folder."); }
                    else File.Copy(self, saved);
                }
                if (!doInstall) { Report("Download complete. Copy this entire folder to the offline PC, then open Oats-Setup.exe there. No installation was performed.", 1, 1); return; }
                if (Process.GetProcessesByName("xx").Length > 0) throw new IOException("Save your work and close oats, including its tray icon, before installing on this PC.");
                string data = Environment.GetEnvironmentVariable("STTAPP_DATA_DIR");
                if (String.IsNullOrWhiteSpace(data)) data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "STTApp");
                data = Path.GetFullPath(data); PackageCore.NoLinks(data);
                if (File.Exists(Path.Combine(data, "runtime.json")) || File.Exists(Path.Combine(data, "data-location.json"))) throw new IOException("This PC already has an oats configuration. It was preserved. Use About → Check for updates for this installation; use this complete setup on the new PC.");
                Space(data, bundle.installed_bytes + bundle.runtime_bytes);
                string target = Path.Combine(data, "packages", bundle.id); PackageCore.NoLinks(target);
                await Task.Run(delegate {
                    using (SplitStream stream = new SplitStream(bundle.parts.Select(a => Path.Combine(cache, a.name))))
                    using (ZipArchive zip = new ZipArchive(stream, ZipArchiveMode.Read)) {
                        Payload p = PackageCore.ReadPayload(zip, bundle);
                        PackageCore.Extract(zip, p, target, x => Report("Preparing verified local speech components…\n" + GiB(x) + " of " + GiB(bundle.installed_bytes), x, bundle.installed_bytes), cancellation.Token);
                    }
                    using (Stream runtime = Assembly.GetExecutingAssembly().GetManifestResourceStream("msvc-runtime.zip"))
                    using (ZipArchive zip = new ZipArchive(runtime, ZipArchiveMode.Read)) {
                        Bundle embedded = new Bundle { installed_bytes = bundle.runtime_bytes, payload_manifest_sha256 = bundle.runtime_manifest_sha256 };
                        Payload p = PackageCore.ReadPayload(zip, embedded);
                        if (p.files.Any(f => !(f.path.StartsWith("python/") || f.path.StartsWith("tools/whisper-cpu/")) || !f.path.EndsWith(".dll"))) throw new IOException("Unexpected Microsoft runtime content.");
                        PackageCore.Extract(zip, p, target, x => Report("Preparing included Microsoft speech-runtime dependencies…", x, bundle.runtime_bytes), cancellation.Token);
                    }
                });
                // These empty writable directories are not archive files.
                // Both actual adapters refuse to start if setup omits them.
                RuntimeDirectories.Ensure(target);
                cancellation.Token.ThrowIfCancellationRequested(); handoff = true; cancel.Enabled = false;
                string python = Path.Combine(target, @"python\python.exe"); string configure = Path.Combine(target, @"setup\configure.py");
                Report("Checking Python, speech libraries, and available hardware…", 0, 1);
                await Task.Run(() => Child(python, "-I -B " + Quote(configure) + " --root " + Quote(data) + " --probe", target));
                var probe = PackageCore.Json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(File.ReadAllText(Path.Combine(target, "probe.json")));
                bool gpu = (bool)probe["gpu_available"];
                if (!gpu && MessageBox.Show(this, "No supported Intel GPU was found. CPU mode can transcribe saved recordings, but may be slow for dictation. Live Trelis meeting transcription needs a supported Intel GPU and driver.\n\nContinue with CPU mode?", "oats hardware check", MessageBoxButtons.YesNo, MessageBoxIcon.Information) != DialogResult.Yes) throw new IOException("Setup stopped before installation. Downloaded components are retained.");
                Report("Checking the speech models and preparing local configuration…", 0, 1);
                string configArgs = "-I -B " + Quote(configure) + " --root " + Quote(data) + " --prepare --device " + (gpu ? "GPU" : "CPU");
                await Task.Run(() => Child(python, configArgs, target));
                if (!WebViewInstalled()) { Report("Installing the included Microsoft WebView2 runtime…", 0, 1); await Task.Run(() => Child(Path.Combine(target, @"setup\WebView2.exe"), "/silent /install", target)); }
                Report("Installing oats " + bundle.app_version + "…", 0, 1);
                await Task.Run(() => Child(Path.Combine(target, @"setup\oats.exe"), "/S", target));
                await Task.Run(() => Child(python, "-I -B " + Quote(configure) + " --root " + Quote(data) + " --activate", target));
                Report("oats is ready. Open oats from Start. Your downloaded folder can set up another compatible PC offline.", 1, 1);
            } catch (OperationCanceledException) { Report("Cancelled. Downloaded parts are retained; choose the same folder to resume.", 0, 1); }
            catch (Exception error) { Report(error.Message, 0, 1); MessageBox.Show(this, error.Message, "oats setup", MessageBoxButtons.OK, MessageBoxIcon.Information); }
            finally { handoff = false; busy = false; install.Enabled = save.Enabled = browse.Enabled = folder.Enabled = cancel.Enabled = true; cancel.Text = "Close"; cancellation.Dispose(); }
        }
    }
    public static class Program {
        [STAThread] public static void Main() {
            try {
                AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
                AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
                bool first;
                using (Mutex owner = new Mutex(true, @"Local\oats-complete-setup", out first)) {
                if (!first) { MessageBox.Show("oats setup is already open.", "oats setup"); return; }
                Bundle b; using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("bundle.json")) using (StreamReader reader = new StreamReader(stream)) b = PackageCore.Json.Deserialize<Bundle>(reader.ReadToEnd());
                PackageCore.Validate(b);
                if (b.runtime_manifest_sha256 == null || b.runtime_bytes < 1) throw new IOException("The complete setup is missing its app-local Microsoft runtime.");
                Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new SetupWindow(b));
                owner.ReleaseMutex();
                }
            } catch (Exception error) { MessageBox.Show(error.Message, "oats setup", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }
    }
}
