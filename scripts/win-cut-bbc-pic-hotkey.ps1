param(
    [int]$Port = 3333,
    [string]$PidFile = '',
    [string]$StatusFile = '',
    [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'

function Write-HotkeyLog([string]$Line) {
    if ($LogFile -ne '') {
        $ts = (Get-Date).ToString('o')
        [System.IO.File]::AppendAllText($LogFile, "[$ts] $Line`n", [System.Text.Encoding]::UTF8)
    }
}

$mutex = New-Object System.Threading.Mutex($false, 'Global\AnkiHelper_BbcPicHotkey')
if (-not $mutex.WaitOne(0)) {
    Write-HotkeyLog 'SKIP already running'
    exit 0
}

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class AnkiHelperHotkeyWindow : NativeWindow, IDisposable {
    private const int WM_HOTKEY = 0x0312;
    private const int HWND_MESSAGE = -3;
    private readonly int _hotkeyId;
    private readonly uint _mods;
    private readonly uint _vk;
    private readonly string _callbackUrl;
    private bool _registered;

    public string Label { get; private set; }

    public AnkiHelperHotkeyWindow(int hotkeyId, uint mods, uint vk, string label, string callbackUrl) {
        _hotkeyId = hotkeyId;
        _mods = mods;
        _vk = vk;
        Label = label;
        _callbackUrl = callbackUrl;
        var cp = new CreateParams();
        cp.Parent = (IntPtr)HWND_MESSAGE;
        CreateHandle(cp);
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    public void RegisterHotkey() {
        if (_registered) return;
        if (!RegisterHotKey(Handle, _hotkeyId, _mods, _vk)) {
            int err = Marshal.GetLastWin32Error();
            throw new InvalidOperationException("RegisterHotKey failed win32=" + err);
        }
        _registered = true;
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == _hotkeyId) {
            try {
                var req = (HttpWebRequest)WebRequest.Create(_callbackUrl);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Timeout = 30000;
                var body = "{}";
                var bytes = System.Text.Encoding.UTF8.GetBytes(body);
                req.ContentLength = bytes.Length;
                using (var stream = req.GetRequestStream()) {
                    stream.Write(bytes, 0, bytes.Length);
                }
                using (var resp = (HttpWebResponse)req.GetResponse()) {
                    Console.WriteLine("TRIGGER_OK " + (int)resp.StatusCode);
                }
            } catch (Exception ex) {
                Console.Error.WriteLine("TRIGGER_FAIL " + ex.Message);
            }
            Console.Out.Flush();
            Console.Error.Flush();
        }
        base.WndProc(ref m);
    }

    public void Dispose() {
        if (_registered) {
            UnregisterHotKey(Handle, _hotkeyId);
            _registered = false;
        }
        DestroyHandle();
    }
}
"@ -ReferencedAssemblies System.Windows.Forms

function Write-StatusLine([string]$Line) {
    if ($StatusFile -ne '') {
        [System.IO.File]::WriteAllText($StatusFile, $Line, [System.Text.Encoding]::UTF8)
    }
}

$candidates = @(
    @{ Label = 'Ctrl+Alt+Shift+F6'; Mods = [uint32]7; Vk = [uint32]0x75 },
    @{ Label = 'Ctrl+Alt+Shift+F7'; Mods = [uint32]7; Vk = [uint32]0x76 },
    @{ Label = 'Ctrl+Shift+F12'; Mods = [uint32]6; Vk = [uint32]0x7B },
    @{ Label = 'Ctrl+Shift+F9'; Mods = [uint32]6; Vk = [uint32]0x78 }
)

$callbackUrl = "http://127.0.0.1:$Port/api/anki/cut-bbcnews-pic"
$window = $null
$registered = $false

try {
    if ($PidFile -ne '') {
        [System.IO.File]::WriteAllText($PidFile, $PID.ToString(), [System.Text.Encoding]::UTF8)
    }

    $rand = New-Object System.Random
    foreach ($item in $candidates) {
        $hotkeyId = $rand.Next(1, 0xB000)
        try {
            $window = New-Object AnkiHelperHotkeyWindow($hotkeyId, $item.Mods, $item.Vk, $item.Label, $callbackUrl)
            $window.RegisterHotkey()
            $registered = $true
            $readyLine = "READY combo=$($item.Label) hotkeyId=$hotkeyId port=$Port"
            Write-StatusLine $readyLine
            Write-HotkeyLog $readyLine
            [Console]::WriteLine($readyLine)
            [Console]::Out.Flush()
            break
        } catch {
            if ($window -ne $null) {
                $window.Dispose()
                $window = $null
            }
            $failLine = "TRY_FAIL $($item.Label) win32=$($_.Exception.Message)"
            Write-HotkeyLog $failLine
            [Console]::Error.WriteLine($failLine)
            [Console]::Error.Flush()
        }
    }

    if (-not $registered) {
        Write-StatusLine 'ERROR all RegisterHotKey candidates failed'
        Write-HotkeyLog 'ERROR all RegisterHotKey candidates failed'
        exit 1
    }

    [System.Windows.Forms.Application]::EnableVisualStyles()
    [void][System.Windows.Forms.Application]::Run()
}
catch {
    $msg = $_.Exception.Message
    Write-StatusLine "ERROR $msg"
    Write-HotkeyLog "ERROR $msg"
    [Console]::Error.WriteLine($msg)
    exit 1
}
finally {
    if ($window -ne $null) {
        $window.Dispose()
    }
    if ($mutex -ne $null) {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }
}
