// One-click installer for Telemedia: no admin rights, no questions.
// Installs to %LOCALAPPDATA%\Programs\Telemedia, adds Start menu and desktop
// shortcuts and an entry in Windows Settings → Apps (uninstall runs
// "Telemedia.exe --uninstall"), then starts Telemedia. Running it again
// updates in place; the Telegram login (%APPDATA%\telemedia) is never touched.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TelemediaSetup
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
        }
    }

    sealed class SetupForm : Form
    {
        const string Name_ = "Telemedia";
        const string MutexName = @"Local\Telemedia.PC.Instance";
        const string QuitEventName = @"Local\Telemedia.PC.Quit";
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Telemedia";

        static readonly string Version = typeof(SetupForm).Assembly.GetName().Version.ToString(3);
        static readonly string InstallDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Telemedia");

        readonly Label label = new Label();
        readonly ProgressBar bar = new ProgressBar();

        public SetupForm()
        {
            Text = "Telemedia setup";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(420, 130);
            BackColor = ColorTranslator.FromHtml("#0E1621");
            ForeColor = ColorTranslator.FromHtml("#E9EEF3");
            Font = new Font("Segoe UI", 10f);

            label.Text = "Installing Telemedia " + Version + "…";
            label.SetBounds(24, 28, 372, 28);
            bar.SetBounds(24, 70, 372, 14);
            bar.Style = ProgressBarStyle.Continuous;
            Controls.Add(label);
            Controls.Add(bar);
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            try
            {
                var progress = new Progress<int>(p => bar.Value = Math.Max(0, Math.Min(100, p)));
                await Task.Run(() => Install(progress));
                label.Text = "Done. Starting Telemedia…";
                Process.Start(new ProcessStartInfo(Path.Combine(InstallDir, "Telemedia.exe")) { UseShellExecute = true, WorkingDirectory = InstallDir });
                await Task.Delay(800);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Telemedia could not be installed:\n\n" + ex.Message, Text,
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            Close();
        }

        static void Install(IProgress<int> progress)
        {
            StopRunningCopy();
            Directory.CreateDirectory(InstallDir);
            // Updating: remove the previous version's files first.
            if (File.Exists(Path.Combine(InstallDir, ".installed")))
            {
                foreach (var dir in Directory.GetDirectories(InstallDir)) Directory.Delete(dir, true);
                foreach (var file in Directory.GetFiles(InstallDir)) File.Delete(file);
            }

            var root = Path.GetFullPath(InstallDir) + Path.DirectorySeparatorChar;
            using (var payload = typeof(SetupForm).Assembly.GetManifestResourceStream("payload.zip"))
            {
                if (payload == null) throw new InvalidOperationException("This setup file is incomplete (no payload).");
                using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
                {
                    long total = zip.Entries.Sum(x => x.Length), done = 0;
                    foreach (var entry in zip.Entries)
                    {
                        var target = Path.GetFullPath(Path.Combine(InstallDir, entry.FullName));
                        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue; // stays inside
                        if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        entry.ExtractToFile(target, true);
                        done += entry.Length;
                        progress.Report(total == 0 ? 100 : (int)(done * 100 / total));
                    }
                }
            }
            File.WriteAllText(Path.Combine(InstallDir, ".installed"), Version);

            var exe = Path.Combine(InstallDir, "Telemedia.exe");
            CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Name_ + ".lnk"), exe);
            CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Name_ + ".lnk"), exe);

            long sizeKb = new DirectoryInfo(InstallDir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length) / 1024;
            using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                key.SetValue("DisplayName", Name_);
                key.SetValue("DisplayVersion", Version);
                key.SetValue("Publisher", Name_);
                key.SetValue("DisplayIcon", exe);
                key.SetValue("InstallLocation", InstallDir);
                key.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("EstimatedSize", (int)sizeKb, RegistryValueKind.DWord);
            }
            // An existing start-with-Windows entry follows the (same) path; a
            // first install leaves it to Telemedia, which turns it on once.
            using (var run = Registry.CurrentUser.OpenSubKey(RunKey, true))
            {
                if (run?.GetValue(Name_) != null) run.SetValue(Name_, "\"" + exe + "\" --hidden");
            }
            progress.Report(100);
        }

        // Asks a running Telemedia to quit and waits for it, then ends anything
        // still running from the install folder.
        static void StopRunningCopy()
        {
            try { using (var quit = EventWaitHandle.OpenExisting(QuitEventName)) quit.Set(); } catch { }
            for (int i = 0; i < 50; i++)
            {
                try { using (Mutex.OpenExisting(MutexName)) { } Thread.Sleep(100); }
                catch { break; }
            }
            foreach (var name in new[] { "Telemedia", "node" })
            {
                foreach (var p in Process.GetProcessesByName(name))
                {
                    try
                    {
                        if (p.MainModule.FileName.StartsWith(InstallDir + "\\", StringComparison.OrdinalIgnoreCase))
                        {
                            p.Kill();
                            p.WaitForExit(3000);
                        }
                    }
                    catch { }
                }
            }
        }

        // Windows' own shortcut maker (WScript.Shell), late-bound.
        static void CreateShortcut(string lnk, string target)
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            var shell = Activator.CreateInstance(shellType);
            try
            {
                var sc = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
                var t = sc.GetType();
                t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
                t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { Path.GetDirectoryName(target) });
                t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { target + ",0" });
                t.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { "Telegram videos in Stremio" });
                t.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
            }
            finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
        }
    }
}
