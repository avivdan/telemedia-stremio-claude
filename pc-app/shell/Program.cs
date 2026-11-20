// Telemedia for Windows: a small window (WebView2) and tray icon around the
// TV app's Node bootstrap (tv-app/node-bootstrap/main.js), which runs as
// node.exe next to this file. The bootstrap does the Telegram setup, pairs
// the Stremio account and serves the addon on 127.0.0.1:7000; it reports its
// state on a local control server, which this app polls and passes to the
// page (ui/).
//
// Install layout (pc-app/scripts/build.mjs, Setup.exe):
//   Telemedia.exe, Microsoft.Web.WebView2.*.dll, WebView2Loader.dll
//   node\node.exe, node\main.js, node\defaults.json, node\dist\src\index.js
//   ui\index.html, ui\style.css, ui\app.js
//   .installed   (written by Setup.exe: enables start-with-Windows and uninstall)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace Telemedia
{
    static class App
    {
        public const string Name = "Telemedia";
        public static readonly string Version = typeof(App).Assembly.GetName().Version.ToString(3);
        public static readonly string ExePath = Application.ExecutablePath;
        public static readonly string InstallDir = Path.GetDirectoryName(ExePath);
        public static readonly string NodeDir = Path.Combine(InstallDir, "node");
        public static readonly string UiDir = Path.Combine(InstallDir, "ui");
        public static readonly bool Installed = File.Exists(Path.Combine(InstallDir, ".installed"));

        static readonly string AppData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        // Shared with the command-line addon (addon/src/userConfig.ts).
        public static readonly string ConfigPath = Path.Combine(AppData, "telemedia", "config.json");
        public static readonly string AppDir = Path.Combine(AppData, "telemedia", Installed ? "app" : "app-dev");
        public static readonly string SettingsPath = Path.Combine(AppDir, "settings.json");
        public static readonly string LogPath = Path.Combine(AppDir, "logs", "telemedia.log");
        public static readonly string WebViewDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "telemedia", "webview");

        public const string MutexName = @"Local\Telemedia.PC.Instance";
        public const string ShowEventName = @"Local\Telemedia.PC.Show";
        public const string QuitEventName = @"Local\Telemedia.PC.Quit";
        public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Telemedia";

        public static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        public static Icon LoadIcon(Size size)
        {
            using (var s = typeof(App).Assembly.GetManifestResourceStream("icon.ico"))
                return new Icon(s, size);
        }

        public static Dictionary<string, object> ReadJson(string path)
        {
            try { return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path)) ?? new Dictionary<string, object>(); }
            catch { return new Dictionary<string, object>(); }
        }

        public static void WriteJson(string path, Dictionary<string, object> value)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, Json.Serialize(value));
        }

        public static void Open(string target)
        {
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
            catch (Exception e) { Debug.WriteLine(e); }
        }

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args.Contains("--uninstall")) { Uninstaller.Run(); return; }

            using (var mutex = new Mutex(true, MutexName, out bool first))
            {
                if (!first)
                {
                    // Already running: bring that window up instead.
                    try { using (var show = EventWaitHandle.OpenExisting(ShowEventName)) show.Set(); } catch { }
                    return;
                }
                Application.Run(new MainForm(args.Contains("--hidden")));
                GC.KeepAlive(mutex);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Start with Windows (installed app only: a run from a build folder would
    // register that folder)
    // -------------------------------------------------------------------------
    static class Autostart
    {
        public static bool Enabled
        {
            get
            {
                using (var key = Registry.CurrentUser.OpenSubKey(App.RunKey))
                {
                    var value = key?.GetValue(App.Name) as string;
                    return value != null && value.IndexOf(App.ExePath, StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
        }

        public static void Set(bool on)
        {
            if (!App.Installed) return;
            using (var key = Registry.CurrentUser.CreateSubKey(App.RunKey))
            {
                if (on) key.SetValue(App.Name, "\"" + App.ExePath + "\" --hidden");
                else key.DeleteValue(App.Name, false);
            }
            var settings = App.ReadJson(App.SettingsPath);
            settings["autostartChosen"] = true;
            App.WriteJson(App.SettingsPath, settings);
        }
    }

    // -------------------------------------------------------------------------
    // The Node part: node.exe main.js, its log, its control server
    // -------------------------------------------------------------------------
    sealed class NodeHost
    {
        readonly Action<string> onStatus;   // raw /status JSON, from a worker thread
        readonly object gate = new object();
        readonly IntPtr job = JobObject.CreateKillOnClose();
        Process proc;
        StreamWriter log;
        System.Threading.Timer poller;
        int controlPort;
        int polling;
        int crashes;
        bool stopping;
        bool restartNow;

        public NodeHost(Action<string> onStatus) { this.onStatus = onStatus; }

        public void Start()
        {
            controlPort = ChooseControlPort();
            StartProcess();
            poller = new System.Threading.Timer(_ => Poll(), null, 1000, 1000);
        }

        // 7001 like the TV, else the next free one (7002 is the setup page).
        static int ChooseControlPort()
        {
            foreach (var port in new[] { 7001, 7003, 7004, 7005, 7006, 7007, 7008, 7009 })
            {
                try
                {
                    var probe = new TcpListener(IPAddress.Loopback, port);
                    probe.Start();
                    probe.Stop();
                    return port;
                }
                catch (SocketException) { }
            }
            throw new InvalidOperationException("No free local port for Telemedia (7001-7009 are all taken).");
        }

        void OpenLog()
        {
            log?.Dispose();
            log = null;
            Directory.CreateDirectory(Path.GetDirectoryName(App.LogPath));
            try
            {
                // Keep one older log; start fresh past 5 MB.
                if (File.Exists(App.LogPath) && new FileInfo(App.LogPath).Length > 5 * 1024 * 1024)
                {
                    File.Copy(App.LogPath, App.LogPath + ".old", true);
                    File.WriteAllText(App.LogPath, "");
                }
            }
            catch { }
            var stream = new FileStream(App.LogPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            log = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
            WriteLog($"\n[app] {DateTime.UtcNow:yyyy-MM-ddTHH:mm:ssZ} Telemedia {App.Version} starting the addon");
        }

        void WriteLog(string line)
        {
            if (line == null) return;
            lock (gate)
            {
                try { log?.WriteLine(line); } catch { }
            }
        }

        void StartProcess()
        {
            lock (gate)
            {
                if (stopping || proc != null) return;
                OpenLog();
                var psi = new ProcessStartInfo(Path.Combine(App.NodeDir, "node.exe"), "main.js")
                {
                    WorkingDirectory = App.NodeDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                var env = psi.EnvironmentVariables;
                env["TELEMEDIA_CONFIG_PATH"] = App.ConfigPath;
                env["TELEMEDIA_CONTROL_PORT"] = controlPort.ToString();
                env["TELEMEDIA_SETUP_HOST"] = "127.0.0.1";
                // A PC has the memory for a bigger read-ahead than a TV box.
                if (string.IsNullOrEmpty(env["STREAM_PREFETCH_KB"])) env["STREAM_PREFETCH_KB"] = "4096";

                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                p.OutputDataReceived += (s, e) => WriteLog(e.Data);
                p.ErrorDataReceived += (s, e) => WriteLog(e.Data);
                p.Exited += OnExited;
                try
                {
                    p.Start();
                }
                catch (Exception e)
                {
                    WriteLog("[app] could not start node.exe: " + e.Message);
                    onStatus("{\"state\":\"error\",\"error\":\"Could not start Telemedia's addon (node.exe). Reinstall Telemedia.\"}");
                    return;
                }
                JobObject.Assign(job, p); // node.exe ends with this app, even on a crash
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                proc = p;
            }
        }

        void OnExited(object sender, EventArgs e)
        {
            int code = -1;
            try { code = ((Process)sender).ExitCode; } catch { }
            WriteLog($"[app] addon process exited ({code})");
            int delay;
            lock (gate)
            {
                proc = null;
                if (stopping) return;
                // A restart asked for is immediate; crashes back off up to 30 s.
                delay = restartNow ? 0 : Math.Min(30000, 1000 << Math.Min(crashes++, 5));
                restartNow = false;
            }
            onStatus("{\"state\":\"offline\"}");
            Task.Delay(delay).ContinueWith(_ => StartProcess());
        }

        public void Restart()
        {
            lock (gate)
            {
                if (proc != null)
                {
                    restartNow = true;
                    try { proc.Kill(); } catch { }
                    return;
                }
            }
            StartProcess();
        }

        public void Stop()
        {
            lock (gate)
            {
                stopping = true;
                poller?.Dispose();
                if (proc != null) try { proc.Kill(); } catch { }
            }
        }

        void Poll()
        {
            if (Interlocked.Exchange(ref polling, 1) == 1) return;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create($"http://127.0.0.1:{controlPort}/status");
                req.Timeout = 1500;
                req.Proxy = null; // never through a system proxy
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    var body = reader.ReadToEnd();
                    if (body.Contains("\"state\":\"running\"")) crashes = 0;
                    onStatus(body);
                }
            }
            catch
            {
                bool alive;
                lock (gate) alive = proc != null;
                onStatus(alive ? "{\"state\":\"starting\"}" : "{\"state\":\"offline\"}");
            }
            finally
            {
                Interlocked.Exchange(ref polling, 0);
            }
        }

        public bool Post(string path, string body, int timeoutMs)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create($"http://127.0.0.1:{controlPort}{path}");
                req.Method = "POST";
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.Proxy = null;
                var bytes = Encoding.UTF8.GetBytes(body ?? "");
                req.ContentLength = bytes.Length;
                using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
                using (var resp = (HttpWebResponse)req.GetResponse())
                    return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 300;
            }
            catch { return false; }
        }

        // The end of the log, for the log view. Colour codes (gramjs) are
        // stripped; the bootstrap never logs keys or sessions.
        public static string LogTail(int maxBytes, int maxLines)
        {
            try
            {
                using (var fs = new FileStream(App.LogPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    long start = Math.Max(0, fs.Length - maxBytes);
                    fs.Seek(start, SeekOrigin.Begin);
                    var text = new StreamReader(fs, Encoding.UTF8).ReadToEnd();
                    if (start > 0)
                    {
                        int nl = text.IndexOf('\n');
                        if (nl >= 0) text = text.Substring(nl + 1);
                    }
                    text = Regex.Replace(text, "\u001b\\[[0-9;]*m", "");
                    var lines = text.Replace("\r\n", "\n").Split('\n');
                    return string.Join("\n", lines.Skip(Math.Max(0, lines.Length - maxLines))).Trim();
                }
            }
            catch { return ""; }
        }
    }

    // Child processes in this job end when the app ends, however it ends.
    static class JobObject
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll")]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters { public ulong R, W, O, RB, WB, OB; }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        const uint KillOnJobClose = 0x2000;
        const int ExtendedLimitInformation = 9;

        public static IntPtr CreateKillOnClose()
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return job;
            var info = new ExtendedLimits();
            info.Basic.LimitFlags = KillOnJobClose;
            int length = Marshal.SizeOf(typeof(ExtendedLimits));
            var ptr = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                SetInformationJobObject(job, ExtendedLimitInformation, ptr, (uint)length);
            }
            finally { Marshal.FreeHGlobal(ptr); }
            return job;
        }

        public static void Assign(IntPtr job, Process p)
        {
            if (job != IntPtr.Zero) try { AssignProcessToJobObject(job, p.Handle); } catch { }
        }
    }

    // -------------------------------------------------------------------------
    // Window + tray
    // -------------------------------------------------------------------------
    sealed class MainForm : Form
    {
        const string Origin = "https://telemedia.example"; // reserved name, never a real site
        static readonly HashSet<string> NeedsUser = new HashSet<string> { "qr", "need_password", "need_config", "error" };

        readonly bool startHidden;
        readonly WebView2 web = new WebView2();
        readonly NotifyIcon tray = new NotifyIcon();
        readonly NodeHost node;
        EventWaitHandle showEvent, quitEvent;
        bool allowShow, quitting, pageReady, shownForSetup, stremioInstalled;
        string lastStatus = "{\"state\":\"starting\"}";
        string lastSent;

        public MainForm(bool hidden)
        {
            startHidden = hidden;
            allowShow = !hidden;
            Text = App.Name;
            using (var s = typeof(App).Assembly.GetManifestResourceStream("icon.ico")) Icon = new Icon(s);
            BackColor = ColorTranslator.FromHtml("#0E1621");
            StartPosition = FormStartPosition.CenterScreen;
            // WinForms on .NET Framework reports 96 DPI here; ask Windows.
            float scale = GetDpiForSystem() / 96f;
            ClientSize = new Size((int)(980 * scale), (int)(680 * scale));
            MinimumSize = new Size((int)(780 * scale), (int)(660 * scale));
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = BackColor;
            Controls.Add(web);

            node = new NodeHost(raw => { try { BeginInvoke((Action)(() => OnStatus(raw))); } catch { } });
            CreateHandle(); // needed before BeginInvoke, also while hidden in the tray
            SetupTray();
            ListenForOtherInstances();

            // Start with Windows by default, like the TV app starts with the TV.
            if (App.Installed && !(App.ReadJson(App.SettingsPath).TryGetValue("autostartChosen", out var chosen) && chosen is bool b && b))
                Autostart.Set(true);

            CheckStremio();
            var stremioTimer = new System.Windows.Forms.Timer { Interval = 30000 };
            stremioTimer.Tick += (s, e) => { if (!stremioInstalled) CheckStremio(); };
            stremioTimer.Start();

            try { node.Start(); }
            catch (Exception e) { OnStatus("{\"state\":\"error\",\"error\":" + App.Json.Serialize(e.Message) + "}"); }
            InitWeb();
        }

        // Started with Windows: stay in the tray until something needs the user.
        protected override void SetVisibleCore(bool value) => base.SetVisibleCore(value && allowShow);

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            int dark = 1; // dark title bar
            DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
        }

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        [DllImport("user32.dll")]
        static extern uint GetDpiForSystem();

        void ShowWindow()
        {
            allowShow = true;
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        void Quit()
        {
            if (quitting) return;
            quitting = true;
            node.Stop();
            tray.Visible = false;
            Application.Exit();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!quitting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true; // closing the window keeps the addon running
                Hide();
                var settings = App.ReadJson(App.SettingsPath);
                if (!settings.ContainsKey("trayHintShown"))
                {
                    settings["trayHintShown"] = true;
                    App.WriteJson(App.SettingsPath, settings);
                    tray.ShowBalloonTip(5000, "Telemedia keeps running",
                        "Stremio still gets Telemedia streams. Right-click the tray icon to quit.", ToolTipIcon.Info);
                }
                return;
            }
            if (!quitting) { quitting = true; node.Stop(); tray.Visible = false; }
            base.OnFormClosing(e);
        }

        void SetupTray()
        {
            tray.Icon = App.LoadIcon(SystemInformation.SmallIconSize);
            tray.Text = "Telemedia is starting";
            tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowWindow(); };
            var menu = new ContextMenuStrip();
            menu.Items.Add("Open Telemedia", null, (s, e) => ShowWindow());
            menu.Items.Add("Open Stremio", null, (s, e) => OpenStremio());
            menu.Items.Add("Restart addon", null, (s, e) => node.Restart());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit Telemedia", null, (s, e) => Quit());
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
        }

        // A second start shows this window; Setup and the uninstaller ask us to quit.
        void ListenForOtherInstances()
        {
            showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, App.ShowEventName);
            quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, App.QuitEventName);
            var thread = new Thread(() =>
            {
                var handles = new WaitHandle[] { showEvent, quitEvent };
                while (true)
                {
                    int which = WaitHandle.WaitAny(handles);
                    try { BeginInvoke(which == 0 ? (Action)ShowWindow : Quit); } catch { return; }
                    if (which == 1) return;
                }
            }) { IsBackground = true };
            thread.Start();
        }

        // Stremio for Windows registers the stremio:// link type.
        void CheckStremio()
        {
            bool installed;
            using (var key = Registry.ClassesRoot.OpenSubKey("stremio")) installed = key != null;
            if (installed == stremioInstalled) return;
            stremioInstalled = installed;
            PushStatus();
        }

        void OpenStremio() => App.Open(stremioInstalled ? "stremio:///" : "https://www.stremio.com/downloads");

        // ---- status ------------------------------------------------------------
        void OnStatus(string raw)
        {
            try { App.Json.DeserializeObject(raw); } catch { return; } // half-written answer
            lastStatus = raw;
            var state = Regex.Match(raw, "\"state\"\\s*:\\s*\"(\\w+)\"").Groups[1].Value;
            tray.Text = state == "running" ? "Telemedia is running"
                : NeedsUser.Contains(state) ? "Telemedia needs you: open it to finish"
                : "Telemedia is starting";
            if (NeedsUser.Contains(state) && !shownForSetup && !Visible)
            {
                shownForSetup = true;
                ShowWindow();
            }
            PushStatus();
        }

        void PushStatus(bool force = false)
        {
            if (!pageReady || web.CoreWebView2 == null) return;
            var app = App.Json.Serialize(new Dictionary<string, object>
            {
                ["stremioInstalled"] = stremioInstalled,
                ["autostart"] = Autostart.Enabled,
                ["canAutostart"] = App.Installed,
                ["version"] = App.Version,
            });
            var message = "{\"type\":\"status\",\"status\":" + lastStatus + ",\"app\":" + app + "}";
            if (!force && message == lastSent) return;
            lastSent = message;
            try { web.CoreWebView2.PostWebMessageAsJson(message); } catch { }
        }

        void Reply(Dictionary<string, object> message)
        {
            try { web.CoreWebView2?.PostWebMessageAsJson(App.Json.Serialize(message)); } catch { }
        }

        // ---- the page ------------------------------------------------------------
        async void InitWeb()
        {
            bool debug = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("TELEMEDIA_DEBUG_PORT"));
            try
            {
                var options = new CoreWebView2EnvironmentOptions();
                if (debug) options.AdditionalBrowserArguments = "--remote-debugging-port=" + Environment.GetEnvironmentVariable("TELEMEDIA_DEBUG_PORT");
                var env = await CoreWebView2Environment.CreateAsync(null, App.WebViewDir, options);
                await web.EnsureCoreWebView2Async(env);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                ShowWindow();
                MessageBox.Show(this,
                    "Telemedia needs Microsoft Edge WebView2, which is part of Windows 11 and most Windows 10 PCs.\n\n" +
                    "The download page opens now. Install it, then start Telemedia again.",
                    App.Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
                App.Open("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                Quit();
                return;
            }
            catch (Exception e)
            {
                ShowWindow();
                MessageBox.Show(this, "Telemedia's window could not open:\n" + e.Message, App.Name,
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            var core = web.CoreWebView2;
            var settings = core.Settings;
            settings.AreDevToolsEnabled = debug;
            settings.AreDefaultContextMenusEnabled = debug;
            settings.AreBrowserAcceleratorKeysEnabled = debug;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            core.SetVirtualHostNameToFolderMapping("telemedia.example", App.UiDir, CoreWebView2HostResourceAccessKind.Deny);
            // The window only shows our own page; links open in the browser via us.
            core.NavigationStarting += (s, e) => { if (!e.Uri.StartsWith(Origin + "/")) e.Cancel = true; };
            core.NewWindowRequested += (s, e) => e.Handled = true;
            core.WebMessageReceived += OnWebMessage;
            core.Navigate(Origin + "/index.html");
        }

        static string Str(Dictionary<string, object> m, string key) => m.TryGetValue(key, out var v) && v != null ? v.ToString() : "";

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!e.Source.StartsWith(Origin + "/")) return;
            Dictionary<string, object> m;
            try { m = App.Json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); }
            catch { return; }
            switch (Str(m, "action"))
            {
                case "ready":
                    pageReady = true;
                    PushStatus(true);
                    break;
                case "password":
                    var password = Str(m, "value");
                    Task.Run(() => node.Post("/password", password, 3000));
                    break;
                case "restart":
                    node.Restart();
                    break;
                case "logout":
                    Logout();
                    break;
                case "connect-stremio":
                    var link = Str(m, "link");
                    if (link.StartsWith("https://link.stremio.com/")) App.Open(link);
                    break;
                case "open-stremio":
                    OpenStremio();
                    break;
                case "copy-address":
                    var url = Str(m, "url");
                    if (Regex.IsMatch(url, @"^http://127\.0\.0\.1:\d{2,5}/manifest\.json$")) Clipboard.SetText(url);
                    break;
                case "open-setup":
                    App.Open("http://127.0.0.1:7002/");
                    break;
                case "set-autostart":
                    Autostart.Set(m.TryGetValue("value", out var on) && on is bool b && b);
                    PushStatus(true);
                    break;
                case "get-log":
                    Reply(new Dictionary<string, object> { ["type"] = "log", ["text"] = NodeHost.LogTail(96 * 1024, 400) });
                    break;
                case "copy-log":
                    var text = NodeHost.LogTail(512 * 1024, 5000);
                    if (text.Length > 0) Clipboard.SetText(text);
                    break;
                case "open-log":
                    if (File.Exists(App.LogPath)) App.Open(App.LogPath);
                    break;
            }
        }

        async void Logout()
        {
            var answer = MessageBox.Show(this,
                "Log this PC out of Telegram?\n\nStremio stops getting Telemedia streams until you scan a new Telegram code. " +
                "You can then log in with any account.",
                "Log out of Telegram", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
            // The bootstrap ends the session at Telegram and forgets the keys;
            // if it doesn't answer, forget them here.
            if (!await Task.Run(() => node.Post("/logout", "", 15000)))
            {
                var cfg = App.ReadJson(App.ConfigPath);
                cfg.Remove("session");
                cfg.Remove("apiId");
                cfg.Remove("apiHash");
                App.WriteJson(App.ConfigPath, cfg);
            }
            node.Restart();
        }
    }

    // -------------------------------------------------------------------------
    // Telemedia.exe --uninstall (Windows Settings → Apps → Telemedia)
    // -------------------------------------------------------------------------
    static class Uninstaller
    {
        public static void Run()
        {
            if (!App.Installed)
            {
                MessageBox.Show("This copy of Telemedia was not installed with Setup, so there is nothing to uninstall.", App.Name);
                return;
            }
            var answer = MessageBox.Show(
                "Remove Telemedia from this PC?\n\nYour Telegram login stays in %APPDATA%\\telemedia. " +
                "Delete that folder too if you want it gone.",
                "Uninstall Telemedia", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return;

            StopRunningCopy(App.InstallDir);
            using (var key = Registry.CurrentUser.OpenSubKey(App.RunKey, true)) key?.DeleteValue(App.Name, false);
            Registry.CurrentUser.DeleteSubKeyTree(App.UninstallKey, false);
            foreach (var folder in new[] { Environment.SpecialFolder.Programs, Environment.SpecialFolder.DesktopDirectory })
            {
                try { File.Delete(Path.Combine(Environment.GetFolderPath(folder), App.Name + ".lnk")); } catch { }
            }
            // This exe lives in the folder: remove it once we have exited.
            Process.Start(new ProcessStartInfo("cmd.exe",
                "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + App.InstallDir + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetTempPath(),
            });
            MessageBox.Show("Telemedia was removed.", App.Name);
        }

        // Asks a running Telemedia to quit, then makes sure nothing from the
        // install folder is still running.
        public static void StopRunningCopy(string installDir)
        {
            try { using (var quit = EventWaitHandle.OpenExisting(App.QuitEventName)) quit.Set(); } catch { }
            for (int i = 0; i < 50; i++)
            {
                try { using (Mutex.OpenExisting(App.MutexName)) { } Thread.Sleep(100); }
                catch (WaitHandleCannotBeOpenedException) { break; }
                catch { break; }
            }
            foreach (var name in new[] { "Telemedia", "node" })
            {
                foreach (var p in Process.GetProcessesByName(name))
                {
                    try
                    {
                        if (p.Id != Process.GetCurrentProcess().Id &&
                            p.MainModule.FileName.StartsWith(installDir + "\\", StringComparison.OrdinalIgnoreCase))
                            p.Kill();
                    }
                    catch { }
                }
            }
        }
    }
}
