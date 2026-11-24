using System;
using System.IO;
using System.Diagnostics;
using System.Drawing;
using System.Threading.Tasks;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher {
    private static string Root = AppDomain.CurrentDomain.BaseDirectory;
    private static string Node = Path.Combine(Root, "runtime", "node.exe");
    [STAThread]
    private static void Main() {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var form = new Form()) {
            form.Text = "TCL 广告投放工作台";
            form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            form.Size = new Size(460, 160);
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false; form.MinimizeBox = false;
            form.StartPosition = FormStartPosition.CenterScreen;
            var label = new Label { Text = "正在检查运行环境并打开工作台…", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Microsoft YaHei UI", 11) };
            form.Controls.Add(label);
            bool finished = false;
            form.FormClosing += (s, e) => { if (!finished) e.Cancel = true; };
            form.Shown += async (s, e) => {
                try {
                    await Task.Run(() => {
                        if (!File.Exists(Node) || !File.Exists(Path.Combine(Root, "node_modules", "tronweb", "package.json"))) Repair();
                        var check = Run(Node, "--disable-warning=ExperimentalWarning scripts/check.js --quick", true);
                        if (check != 0) throw new Exception("运行环境检查未通过。请双击“修复运行环境.cmd”后重试。\n详情见 launcher.log。");
                        var start = new ProcessStartInfo(Node, "--disable-warning=ExperimentalWarning src/server.js --open") {
                            WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true,
                            WindowStyle = ProcessWindowStyle.Hidden
                        };
                        var area = Screen.PrimaryScreen.WorkingArea;
                        start.EnvironmentVariables["TCL_WINDOW_WIDTH"] = Math.Min(1360, Math.Max(800, area.Width - 40)).ToString();
                        start.EnvironmentVariables["TCL_WINDOW_HEIGHT"] = Math.Min(900, Math.Max(600, area.Height - 50)).ToString();
                        string statusFile = Path.Combine(Path.GetTempPath(), "tcl-startup-" + Guid.NewGuid().ToString("N") + ".status");
                        start.EnvironmentVariables["TCL_STARTUP_STATUS"] = statusFile;
                        try {
                            using (var process = Process.Start(start)) {
                                var timer = Stopwatch.StartNew();
                                while (timer.ElapsedMilliseconds < 180000) {
                                    if (File.Exists(statusFile)) {
                                        string status;
                                        try { status = File.ReadAllText(statusFile); } catch (IOException) { Thread.Sleep(100); continue; }
                                        if (status == "ready") return;
                                        if (status.StartsWith("error\n")) throw new Exception(status.Substring(6));
                                    }
                                    if (process.HasExited) {
                                        // A shared-instance launch may report readiness and exit
                                        // between the status probe above and this process check.
                                        if (File.Exists(statusFile)) {
                                            string finalStatus = File.ReadAllText(statusFile);
                                            if (finalStatus == "ready") return;
                                            if (finalStatus.StartsWith("error\n")) throw new Exception(finalStatus.Substring(6));
                                        }
                                        throw new Exception("工作台启动失败，请查看 startup-error.log 或运行“检查运行环境.cmd”。");
                                    }
                                    Thread.Sleep(100);
                                }
                                throw new Exception("工作台启动超时，请检查已有工具窗口和 startup-error.log。程序没有自动开始投放。");
                            }
                        } finally {
                            try { if (File.Exists(statusFile)) File.Delete(statusFile); } catch (IOException) { }
                        }
                    });
                } catch (Exception error) {
                    MessageBox.Show(error.Message, "TCL 启动提示", MessageBoxButtons.OK, MessageBoxIcon.Error);
                } finally { finished = true; form.Close(); }
            };
            Application.Run(form);
        }
    }
    private static void Repair() {
        string script = Path.Combine(Root, "scripts", "repair-runtime.ps1");
        if (!File.Exists(script)) throw new Exception("工具文件不完整，请完整解压便携包后再运行。");
        string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        int code = Run(powershell, "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"", true);
        if (code != 0) throw new Exception("运行环境准备失败，请检查网络后运行“修复运行环境.cmd”。详情见 launcher.log。");
    }
    private static int Run(string executable, string args, bool wait) {
        var info = new ProcessStartInfo(executable, args) {
            WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true
        };
        using (var process = Process.Start(info)) {
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            process.WaitForExit(); Task.WaitAll(stdout, stderr);
            File.AppendAllText(Path.Combine(Root, "launcher.log"), DateTime.Now.ToString("s") + "\r\n" + stdout.Result + stderr.Result + "\r\n");
            return process.ExitCode;
        }
    }
}
