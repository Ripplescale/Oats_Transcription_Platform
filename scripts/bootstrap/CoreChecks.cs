// Maintainer test harness. Never starts an installer or changes active runtime.
using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using OatsSetup;
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]
public static class CoreChecks {
    static int checks;
    static void Check(bool value, string name) { if (!value) throw new Exception(name); checks++; }
    static void Reject(Action action, string name) { try { action(); } catch (IOException) { checks++; return; } throw new Exception("Accepted " + name); }
    static string Sha(byte[] data) { using (MemoryStream s = new MemoryStream(data)) return PackageCore.Hash(s); }
    sealed class Handler : HttpMessageHandler {
        public byte[] body; public int calls; public bool partial; public long? range;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken c) {
            calls++; range = r.Headers.Range == null ? null : r.Headers.Range.Ranges.Single().From;
            int offset = partial && range.HasValue ? (int)range.Value : 0;
            var response = new HttpResponseMessage(partial ? HttpStatusCode.PartialContent : HttpStatusCode.OK) { RequestMessage = r, Content = new ByteArrayContent(body.Skip(offset).ToArray()) };
            if (partial) response.Content.Headers.ContentRange = new System.Net.Http.Headers.ContentRangeHeaderValue(offset, body.Length - 1, body.Length);
            return Task.FromResult(response);
        }
    }
    static void Downloads(string folder) {
        byte[] data = Encoding.UTF8.GetBytes("a bounded download with an interrupted prefix");
        Asset a = new Asset { name="fixture.part001", size=data.Length, sha256=Sha(data), url="https://github.com/example/fixture" };
        var handler = new Handler { body=data, partial=true };
        using (HttpClient client = new HttpClient(handler)) {
            string path = Path.Combine(folder, a.name);
            File.WriteAllBytes(path + ".partial", data.Take(8).ToArray());
            Check(PackageCore.RemainingDownloadBytes(new[]{a},folder)==data.Length-8,"space estimate credits resumable bytes");
            PackageCore.Download(a, folder, client, x=>{}, CancellationToken.None).GetAwaiter().GetResult();
            Check(handler.range == 8 && PackageCore.Verified(path,a), "range resumed and verified");
            Check(PackageCore.RemainingDownloadBytes(new[]{a},folder)==0,"verified download needs no second allocation");
            PackageCore.Download(a, folder, client, x=>{}, CancellationToken.None).GetAwaiter().GetResult();
            Check(handler.calls == 1, "offline completed cache makes zero requests");
            try { PackageCore.Download(a,folder,client,x=>{},new CancellationToken(true)).GetAwaiter().GetResult(); throw new Exception("Cancelled cache check continued"); }
            catch(OperationCanceledException) { checks++; }
            File.Delete(path); File.WriteAllBytes(path + ".partial", data.Take(8).ToArray()); handler.partial=false;
            PackageCore.Download(a, folder, client, x=>{}, CancellationToken.None).GetAwaiter().GetResult();
            Check(PackageCore.Verified(path,a), "200 response safely restarts partial");
            File.Delete(path); handler.body=Encoding.UTF8.GetBytes(new string('x',data.Length));
            Reject(()=>PackageCore.Download(a,folder,client,x=>{},CancellationToken.None).GetAwaiter().GetResult(),"changed download hash");
            Check(!File.Exists(path) && !File.Exists(path+".partial"),"failed hash is never published");
            File.WriteAllText(path,"keep damaged completed file");
            Reject(()=>PackageCore.RemainingDownloadBytes(new[]{a},folder),"damaged completed download during preflight");
            Reject(()=>PackageCore.Download(a,folder,client,x=>{},CancellationToken.None).GetAwaiter().GetResult(),"changed completed file");
            Check(File.ReadAllText(path)=="keep damaged completed file","existing content preserved");
        }
    }
    static void Fixtures(string folder) {
        byte[] data = Enumerable.Range(0,256).Select(x=>(byte)x).ToArray();
        string[] paths = Enumerable.Range(0,4).Select(i=>Path.Combine(folder,"split"+i)).ToArray();
        for(int i=0;i<4;i++) File.WriteAllBytes(paths[i],data.Skip(i*64).Take(64).ToArray());
        using(SplitStream stream = new SplitStream(paths)) {
            byte[] actual = new byte[140]; stream.Seek(60,SeekOrigin.Begin);
            Check(stream.Read(actual,0,140)==140 && actual.SequenceEqual(data.Skip(60).Take(140)),"read across split boundaries");
            stream.Seek(-2,SeekOrigin.End); Check(stream.ReadByte()==254 && stream.ReadByte()==255 && stream.ReadByte()==-1,"seek from end and EOF");
            Reject(()=>stream.Seek(-1,SeekOrigin.Begin),"negative seek");
        }
        foreach(string name in new[]{"../escape","C:/escape","python/CON.txt","python/a\\b","python/trailing. ","/root","python//x"}) Reject(()=>PackageCore.Relative(name),name);
        Downloads(folder);
        Archives(folder);
        WorkingDirectories(folder);
        InstallerOverlay(folder);
        byte[] helper=Encoding.UTF8.GetBytes("print('fixture')");
        string helperPath=PackageCore.PublishConfigureHelper(folder,helper);
        Check(File.ReadAllBytes(helperPath).SequenceEqual(helper),"helper publishes complete verified content");
        Check(PackageCore.PublishConfigureHelper(folder,helper)==helperPath,"helper retries reuse exact content");
        Check(Directory.GetFiles(Path.GetDirectoryName(helperPath),"*.tmp").Length==0,"helper publication leaves no temporary files");
        File.WriteAllText(helperPath,"preserve mismatch");
        Reject(()=>PackageCore.PublishConfigureHelper(folder,helper),"conflicting helper preserved");
        Bundle b=new Bundle {schema=1,id=new string('a',20),payload_id=new string('b',20),app_version="0.8.8",installed_bytes=1,payload_manifest_sha256=new string('0',64),parts=new[]{new Asset {name="oats-runtime-"+new string('b',20)+".zip.part001",url="https://github.com/Ripplescale/Oats_Transcription_Platform/releases/download/setup-"+new string('b',20)+"/oats-runtime-"+new string('b',20)+".zip.part001",size=1,sha256=new string('0',64)}}};
        PackageCore.Validate(b); checks++;
        b.parts[0].url="https://example.com/part"; Reject(()=>PackageCore.Validate(b),"non-GitHub linked payload");
        b.payload_id="../invalid"; Reject(()=>PackageCore.Validate(b),"unsafe linked release identity");
        Console.WriteLine(checks + " transport and path checks passed");
    }
    static void WorkingDirectories(string folder) {
        string root=Path.Combine(folder,"installed"), package=Path.Combine(root,"packages",new string('e',20)); Directory.CreateDirectory(package);
        var models=new System.Collections.Generic.Dictionary<string,object> {
            {"trelis",new System.Collections.Generic.Dictionary<string,object>{{"cache_dir",Path.Combine(package,@"cache\openvino")}}},
            {"apex",new System.Collections.Generic.Dictionary<string,object>{{"work_dir",Path.Combine(package,@"cache\apex")}}}};
        var config=new System.Collections.Generic.Dictionary<string,object>{{"models",models}};
        string document=Path.Combine(root,"runtime.json"); File.WriteAllText(document,PackageCore.Json.Serialize(config)); string before=PackageCore.HashFile(document);
        Check(RuntimeDirectories.PackageFromConfig(root,config)==package,"repair finds package from installed configuration");
        string[] ready=RuntimeDirectories.Ensure(package);
        Check(ready.All(Directory.Exists),"fresh install provisions both backend directories");
        Check(ready.All(p=>Directory.GetFileSystemEntries(p).Length==0),"writability probes leave no files");
        string preserved=Path.Combine(ready[0],"existing-cache"); File.WriteAllText(preserved,"keep compiled cache");
        RuntimeDirectories.Ensure(package);
        Check(File.ReadAllText(preserved)=="keep compiled cache" && PackageCore.HashFile(document)==before,"repair preserves cache contents and exact runtime bytes");
        var apex=(System.Collections.Generic.Dictionary<string,object>)models["apex"]; apex["work_dir"]=Path.Combine(root,"recordings");
        Reject(()=>RuntimeDirectories.PackageFromConfig(root,config),"working path outside package cache");
        string blocked=Path.Combine(root,"packages",new string('d',20)); Directory.CreateDirectory(Path.Combine(blocked,"cache")); File.WriteAllText(Path.Combine(blocked,@"cache\apex"),"preserve conflicting file");
        Reject(()=>RuntimeDirectories.Ensure(blocked),"conflicting work-directory file");
        Check(!Directory.Exists(Path.Combine(blocked,@"cache\openvino")) && File.ReadAllText(Path.Combine(blocked,@"cache\apex"))=="preserve conflicting file","repair checks both paths before writing");
    }
    static void InstallerOverlay(string folder) {
        byte[] bytes = Encoding.UTF8.GetBytes("MZ synthetic signed-app fixture; never execute");
        Bundle bundle = new Bundle { app_version="0.8.10", app_installer_bytes=bytes.Length, app_installer_sha256=Sha(bytes) };
        string package=Path.Combine(folder,"overlay"); Directory.CreateDirectory(Path.Combine(package,"setup"));
        string legacy=Path.Combine(package,"setup","oats.exe"); File.WriteAllText(legacy,"immutable archived0.8.8");
        string installed;
        using (MemoryStream input=new MemoryStream(bytes)) installed=PackageCore.PublishAppInstaller(bundle,input,package);
        Check(File.ReadAllBytes(installed).SequenceEqual(bytes),"current embedded installer is hash-checked and published");
        Check(File.ReadAllText(legacy)=="immutable archived0.8.8" && installed!=legacy,"legacy archive installer is preserved and unused");
        using (MemoryStream input=new MemoryStream(bytes)) Check(PackageCore.PublishAppInstaller(bundle,input,package)==installed,"matching overlay supports retry without replacement");
        File.WriteAllText(installed,"preserve conflicting current installer");
        Reject(()=>PackageCore.PublishAppInstaller(bundle,new MemoryStream(bytes),package),"conflicting installer overlay");
        Check(File.ReadAllText(installed)=="preserve conflicting current installer","conflicting executable preserved");
        string bad=Path.Combine(folder,"bad-overlay");
        Reject(()=>PackageCore.PublishAppInstaller(bundle,new MemoryStream(Encoding.UTF8.GetBytes("MZ changed")),bad),"truncated embedded installer");
        Check(Directory.GetFiles(Path.Combine(bad,"setup")).Length==0,"failed installer leaves no executable or temporary file");
        byte[] changed=(byte[])bytes.Clone(); changed[changed.Length-1]^=1;
        Reject(()=>PackageCore.PublishAppInstaller(bundle,new MemoryStream(changed),bad),"tampered same-size installer");
        byte[] oversized=bytes.Concat(new byte[]{0}).ToArray();
        Reject(()=>PackageCore.PublishAppInstaller(bundle,new MemoryStream(oversized),bad),"oversized resource");
        bundle.app_installer_bytes=PackageCore.MaxInstaller+1;
        Reject(()=>PackageCore.ValidateAppInstaller(bundle),"installer above512MiB bound");
        bundle.app_installer_bytes=bytes.Length; bundle.app_installer_sha256="invalid";
        Reject(()=>PackageCore.ValidateAppInstaller(bundle),"invalid app installer digest");
        Reject(()=>PackageCore.ValidateAppInstaller(new Bundle {app_version="0.8.10"}),"missing current app installer");
    }
    static void Archives(string folder) {
        byte[] data=Encoding.UTF8.GetBytes("verified fixture content");
        Payload payload=new Payload {schema=1, files=new[]{new PayloadFile {path="setup/fixture.txt",size=data.Length,sha256=Sha(data)}}};
        byte[] manifest=Encoding.UTF8.GetBytes(PackageCore.Json.Serialize(payload));
        Bundle b=new Bundle {installed_bytes=data.Length,payload_manifest_sha256=Sha(manifest)};
        using(MemoryStream bytes=new MemoryStream()) {
            using(ZipArchive zip=new ZipArchive(bytes,ZipArchiveMode.Create,true)) {
                using(Stream s=zip.CreateEntry("setup/fixture.txt").Open()) s.Write(data,0,data.Length);
                using(Stream s=zip.CreateEntry("payload-manifest.json").Open()) s.Write(manifest,0,manifest.Length);
            }
            bytes.Position=0;
            using(ZipArchive zip=new ZipArchive(bytes,ZipArchiveMode.Read,true)) {
                Payload verified=PackageCore.ReadPayload(zip,b);
                string target=Path.Combine(folder,"archive");
                Check(PackageCore.RemainingExtractionBytes(verified,target)==data.Length,"fresh extraction space");
                PackageCore.Extract(zip,verified,target,x=>{},CancellationToken.None);
                Check(PackageCore.RemainingExtractionBytes(verified,target)==0,"verified extracted content needs no second allocation");
                Check(File.ReadAllBytes(Path.Combine(target,"setup/fixture.txt")).SequenceEqual(data),"archive hashes checked while extracting");
                PackageCore.Extract(zip,verified,target,x=>{},CancellationToken.None);
                checks++;
                string longer=Path.Combine(folder,new string('a',90),new string('b',90),new string('c',90));
                PackageCore.Extract(zip,verified,longer,x=>{},CancellationToken.None);
                Check(File.ReadAllBytes(PackageCore.LongPath(Path.Combine(longer,"setup/fixture.txt"))).SequenceEqual(data),"extraction supports paths longer than MAX_PATH");
                File.WriteAllText(Path.Combine(target,"setup/fixture.txt"),"preserve existing");
                Reject(()=>PackageCore.RemainingExtractionBytes(verified,target),"changed extracted content during preflight");
                Reject(()=>PackageCore.Extract(zip,verified,target,x=>{},CancellationToken.None),"changed extracted file");
                Check(File.ReadAllText(Path.Combine(target,"setup/fixture.txt"))=="preserve existing","extracted content preserved");
                b.payload_manifest_sha256=new string('0',64);
                Reject(()=>PackageCore.ReadPayload(zip,b),"changed payload manifest");
                verified.files[0].sha256=new string('0',64);
                string corrupt=Path.Combine(folder,"corrupt");
                Reject(()=>PackageCore.Extract(zip,verified,corrupt,x=>{},CancellationToken.None),"changed payload bytes");
                Check(!File.Exists(Path.Combine(corrupt,"setup/fixture.txt")),"invalid extracted bytes are never published");
            }
        }
    }
    public static void Main(string[] args) {
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false); AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
        if(args.Length==0) {
            string folder=Path.Combine(Path.GetTempPath(),"oats-setup-check-"+Guid.NewGuid().ToString("N")); Directory.CreateDirectory(folder);
            try { Fixtures(folder); } finally { Directory.Delete(PackageCore.LongPath(folder),true); } return;
        }
        if(args[0]=="embedded") {
            var assembly=System.Reflection.Assembly.LoadFrom(args[1]); Bundle embeddedBundle;
            using(Stream s=assembly.GetManifestResourceStream("bundle.json")) using(StreamReader r=new StreamReader(s)) embeddedBundle=PackageCore.Json.Deserialize<Bundle>(r.ReadToEnd());
            PackageCore.Validate(embeddedBundle);
            using(Stream s=assembly.GetManifestResourceStream("msvc-runtime.zip")) using(ZipArchive zip=new ZipArchive(s,ZipArchiveMode.Read)) {
                Payload p=PackageCore.ReadPayload(zip,new Bundle {installed_bytes=embeddedBundle.runtime_bytes,payload_manifest_sha256=embeddedBundle.runtime_manifest_sha256});
                PackageCore.Extract(zip,p,args[2],x=>{},CancellationToken.None);
                Console.WriteLine("Embedded Microsoft CRT verified and extracted: "+p.files.Length+" entries");
            } return;
        }
        Bundle b=PackageCore.Json.Deserialize<Bundle>(File.ReadAllText(args[1])); PackageCore.Validate(b);
        string cache=Path.GetDirectoryName(Path.GetFullPath(args[1]));
        if(args[0]=="download" || args[0]=="download-last") {
            using(HttpClient client=new HttpClient {Timeout=TimeSpan.FromHours(2)}) {
                client.DefaultRequestHeaders.UserAgent.ParseAdd("oats-setup-verification/1");
                foreach(Asset a in args[0]=="download-last" ? b.parts.Skip(b.parts.Length-1) : b.parts) { PackageCore.Download(a,args[2],client,x=>{},CancellationToken.None).GetAwaiter().GetResult(); Console.WriteLine("Verified "+a.name); }
            } return;
        }
        foreach(Asset a in b.parts) { if(!PackageCore.Verified(Path.Combine(cache,a.name),a)) throw new IOException("Part verification failed: "+a.name); Console.WriteLine("Verified "+a.name); }
        using(SplitStream stream=new SplitStream(b.parts.Select(a=>Path.Combine(cache,a.name))))
        using(ZipArchive zip=new ZipArchive(stream,ZipArchiveMode.Read)) {
            Payload p=PackageCore.ReadPayload(zip,b);
            if(args[0]=="extract") PackageCore.Extract(zip,p,args[2],x=>{},CancellationToken.None);
            Console.WriteLine("ZIP64 manifest checked: "+p.files.Length+" files, "+b.installed_bytes+" bytes");
        }
    }
}
