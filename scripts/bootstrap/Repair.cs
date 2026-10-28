// Standalone repair for already installed complete setups. No downloads,
// installers, model changes, process termination or recording access.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]
namespace OatsSetup {
    public sealed class RepairWindow : Form {
        readonly TextBox report = new TextBox(); readonly Label status = new Label();
        public RepairWindow() {
            Text="oats transcription repair"; ClientSize=new Size(690,500); MinimumSize=new Size(600,460); StartPosition=FormStartPosition.CenterScreen;
            Font=new Font("Segoe UI",10); BackColor=Color.FromArgb(255,252,248);
            Label heading=new Label {Text="Repair transcription working folders",Font=new Font("Segoe UI",16,FontStyle.Bold)}; heading.SetBounds(20,18,650,35);
            Label info=new Label {Text="Creates the missing Trelis cache and Apex workspace. No model download or app reinstallation is needed."}; info.SetBounds(20,62,650,48);
            status.SetBounds(20,117,650,45); status.Text="You can leave oats open. After repairing, retry the saved transcription in oats.";
            report.SetBounds(20,170,650,255); report.Multiline=true; report.ReadOnly=true; report.ScrollBars=ScrollBars.Both; report.Anchor=AnchorStyles.Top|AnchorStyles.Bottom|AnchorStyles.Left|AnchorStyles.Right;
            Button repair=new Button {Text="Check / repair folders"}; repair.SetBounds(20,444,190,36); repair.Anchor=AnchorStyles.Bottom|AnchorStyles.Left;
            Button copy=new Button {Text="Copy report"}; copy.SetBounds(225,444,130,36); copy.Anchor=AnchorStyles.Bottom|AnchorStyles.Left;
            Button close=new Button {Text="Close"}; close.SetBounds(565,444,105,36); close.Anchor=AnchorStyles.Bottom|AnchorStyles.Right;
            repair.Click+=delegate { RunRepair(); }; copy.Click+=delegate { if(report.TextLength>0) Clipboard.SetText(report.Text); }; close.Click+=delegate {Close();};
            Controls.AddRange(new Control[]{heading,info,status,report,repair,copy,close});
        }
        static Dictionary<string,object> ReadObject(string path) {
            PackageCore.NoLinks(path);
            if(!File.Exists(path) || new FileInfo(path).Length>4*1024*1024) throw new IOException("Missing or oversized setup document: "+Path.GetFileName(path));
            return PackageCore.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path));
        }
        void RunRepair() {
            StringBuilder text=new StringBuilder("oats working-folder repair\r\n");
            try {
                string root=Environment.GetEnvironmentVariable("STTAPP_DATA_DIR");
                if(String.IsNullOrWhiteSpace(root)) {
                    root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"STTApp");
                    string location=Path.Combine(root,"data-location.json");
                    if(File.Exists(location)) { object saved; var value=ReadObject(location); if(!value.TryGetValue("data_root",out saved) || !(saved is string)) throw new IOException("The saved oats data location is invalid."); root=(string)saved; }
                }
                if(!Path.IsPathRooted(root)) throw new IOException("The oats data location must be an absolute local folder.");
                root=Path.GetFullPath(root); PackageCore.NoLinks(root); text.AppendLine("Data folder: "+root);
                string path=Path.Combine(root,"runtime.json"); var config=ReadObject(path); string before=PackageCore.HashFile(path);
                string package=RuntimeDirectories.PackageFromConfig(root,config);
                foreach(string folder in RuntimeDirectories.Ensure(package)) text.AppendLine("Ready and writable: "+folder);
                if(before!=PackageCore.HashFile(path)) throw new IOException("The runtime configuration changed concurrently; this repair did not rewrite it.");
                status.Text="Folders are ready. In oats, open Tools → Transcription & versions, then resume or retry the failed transcription.";
                text.AppendLine("Repair completed. Models, recordings, notes and runtime configuration were not replaced.");
                try { RecentErrors(root,text); } catch(Exception error) { text.AppendLine("Saved error details unavailable: "+error.Message); }
            } catch(Exception error) { status.Text="Repair could not finish. Copy the report below so we can diagnose it."; text.AppendLine("Repair error: "+error.Message); }
            report.Text=text.ToString();
        }
        static void RecentErrors(string root,StringBuilder text) {
            string jobs=Path.Combine(root,"jobs"); if(!Directory.Exists(jobs)) return;
            text.AppendLine("\r\nRecent saved worker errors (these may predate this repair):");
            foreach(DirectoryInfo dir in new DirectoryInfo(jobs).GetDirectories().OrderByDescending(d=>d.LastWriteTimeUtc).Take(6)) {
                string path=Path.Combine(dir.FullName,"status.json"); if(!File.Exists(path)) continue;
                try { var saved=ReadObject(path); object error, state; saved.TryGetValue("state",out state);
                    if(saved.TryGetValue("error",out error) && error is string) text.AppendLine(dir.Name+" ["+state+"]: "+(string)error);
                } catch(IOException) { text.AppendLine(dir.Name+": saved status unavailable"); }
            }
        }
    }
    public static class RepairProgram {
        [STAThread] public static void Main() {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false); AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new RepairWindow());
        }
    }
}
