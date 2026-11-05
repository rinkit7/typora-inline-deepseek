using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ActivateDeepSeekWindow {
    private delegate bool EnumWindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint first, uint second, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] private static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool SetLayeredWindowAttributes(IntPtr window, uint color, byte alpha, uint flags);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool SetPropW(IntPtr window, string name, IntPtr value);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr GetPropW(IntPtr window, string name);
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    // The detached window is a real Typora document window. Its file name once
    // carried the session identifier, which leaked a long hexadecimal string
    // into the title bar, tab strip and taskbar. Registration instead stores
    // the identifier in a window property, so the visible title can stay clean.
    private const string WindowProperty = "TyporaInlineDeepSeekDetachedWindow";

    private static uint HashIdentifier(string text) {
        unchecked {
            uint hash = 0x811c9dc5;
            foreach (char character in text) { hash ^= character; hash *= 0x01000193; }
            return hash;
        }
    }

    private static bool OwnedByExecutable(IntPtr window, string executable) {
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        try {
            using (var process = Process.GetProcessById((int)processId)) {
                return String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase);
            }
        } catch { return false; }
    }

    private static bool SendWindowTitle(IntPtr window, string title) {
        IntPtr text = Marshal.StringToHGlobalUni(title);
        try {
            IntPtr sent;
            SendMessageTimeout(window, 0x000C, IntPtr.Zero, text, 0x0002, 1000, out sent); // WM_SETTEXT, SMTO_ABORTIFHUNG
            return sent != IntPtr.Zero;
        } finally { Marshal.FreeHGlobal(text); }
    }

    public static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--self-test") {
            Console.WriteLine("{\"compiled\":true}"); return 0;
        }
        Guid identifier;
        bool opacityMode = false, registerMode = false, queryMode = false, moveMode = false;
        int opacity = 100, moveX = 0, moveY = 0, moveW = 0, moveH = 0;
        bool topmost = false, topmostMode = false;
        string cleanTitle = null;
        if (args.Length < 2 || !Guid.TryParse(args[0], out identifier) || args[1].Length == 0) return 2;
        for (int index = 2; index < args.Length; index++) {
            if (args[index] == "--opacity" && index + 1 < args.Length) {
                opacityMode = true;
                if (!Int32.TryParse(args[++index], out opacity) || opacity < 40 || opacity > 100) return 2;
            } else if (args[index] == "--register") registerMode = true;
            else if (args[index] == "--query") queryMode = true;
            else if (args[index] == "--topmost" && index + 1 < args.Length) {
                topmostMode = true;
                topmost = args[++index] == "on";
                if (!topmost && args[index] != "off") return 2;
            }
            else if (args[index] == "--move" && index + 4 < args.Length) {
                moveMode = true;
                bool numbers = true;
                for (int offset = 1; offset <= 4; offset++) {
                    int number;
                    if (!Int32.TryParse(args[index + offset], out number)) { numbers = false; break; }
                    if (offset == 1) moveX = number; else if (offset == 2) moveY = number;
                    else if (offset == 3) moveW = number; else moveH = number;
                }
                if (!numbers) return 2;
                index += 4;
            }
            else if (args[index] == "--title" && index + 1 < args.Length) cleanTitle = args[++index];
            else return 2;
        }
        string marker = "DeepSeek-" + identifier.ToString() + ".md";
        uint expected = HashIdentifier(identifier.ToString());
        var matches = new List<IntPtr>();
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            bool registered = GetPropW(window, WindowProperty) == new IntPtr(expected);
            if (!registered) {
                var title = new StringBuilder(2048);
                GetWindowText(window, title, title.Capacity);
                if (title.ToString().IndexOf(marker, StringComparison.OrdinalIgnoreCase) < 0) return true;
            }
            if (OwnedByExecutable(window, args[1]) && !matches.Contains(window)) matches.Add(window);
            return true;
        }, IntPtr.Zero);
        // Never activate an arbitrary Typora window if the exact target is absent or ambiguous.
        if (matches.Count != 1) {
            Console.WriteLine("{\"found\":false,\"matches\":" + matches.Count + "}"); return 3;
        }
        IntPtr target = matches[0];
        if (topmostMode) {
            // Always-on-top through the OS style; Typora's own pin command was
            // observed to close the freshly opened detached window.
            bool applied = SetWindowPos(target, (IntPtr)(topmost ? -1 : -2), 0, 0, 0, 0, 0x0003); // HWND_TOPMOST/-NOTOPMOST, SWP_NOMOVE|NOSIZE|NOACTIVATE
            Console.WriteLine("{\"found\":true,\"topmost\":" + (applied && topmost ? "true" : "false") + "}");
            return applied ? 0 : 5;
        }
        if (queryMode) {
            // Report the window rect so the detached session can remember the
            // user's preferred position and size. Never moves or activates.
            RECT bounds;
            if (!GetWindowRect(target, out bounds)) { Console.WriteLine("{\"found\":false}"); return 5; }
            Console.WriteLine("{\"found\":true,\"x\":" + bounds.Left + ",\"y\":" + bounds.Top + ",\"width\":" + (bounds.Right - bounds.Left) + ",\"height\":" + (bounds.Bottom - bounds.Top) + "}");
            return 0;
        }
        if (moveMode) {
            // Restore the remembered geometry. Skipped while minimized so the
            // phantom -32000 rect is never treated as a real position.
            if (IsIconic(target)) { Console.WriteLine("{\"found\":true,\"moved\":false,\"minimized\":true}"); return 0; }
            if (moveW < 200 || moveH < 200 || moveW > 12000 || moveH > 12000) return 2;
            bool moved = SetWindowPos(target, IntPtr.Zero, moveX, moveY, moveW, moveH, 0x0004); // SWP_NOZORDER
            Console.WriteLine("{\"found\":true,\"moved\":" + (moved ? "true" : "false") + "}");
            return moved ? 0 : 5;
        }
        if (registerMode) {
            // Record the identifier as a window property so later lookups do not
            // depend on the visible title, then apply the clean display title.
            bool registered = SetPropW(target, WindowProperty, new IntPtr(expected));
            bool retitled = cleanTitle != null && SendWindowTitle(target, cleanTitle);
            Console.WriteLine("{\"found\":true,\"registered\":" + (registered ? "true" : "false") + ",\"retitled\":" + (retitled ? "true" : "false") + "}");
            return registered ? 0 : 5;
        }
        bool retitleApplied = false;
        if (cleanTitle != null) retitleApplied = SendWindowTitle(target, cleanTitle);
        if (opacityMode) {
            // This branch never restores, moves or focuses the target window.
            SetLastError(0);
            IntPtr original = GetWindowLongPtr(target, -20); // GWL_EXSTYLE
            if (original == IntPtr.Zero && Marshal.GetLastWin32Error() != 0) return 5;
            long layered = original.ToInt64() | 0x00080000; // WS_EX_LAYERED
            bool changed = layered != original.ToInt64();
            if (changed) {
                SetLastError(0);
                IntPtr previous = SetWindowLongPtr(target, -20, new IntPtr(layered));
                if (previous == IntPtr.Zero && Marshal.GetLastWin32Error() != 0) return 5;
                SetWindowPos(target, IntPtr.Zero, 0, 0, 0, 0, 0x37); // No move/size/z-order/activation; frame changed.
            }
            bool applied = SetLayeredWindowAttributes(target, 0, (byte)Math.Round(opacity * 255.0 / 100), 2);
            if (!applied && changed) {
                SetWindowLongPtr(target, -20, original);
                SetWindowPos(target, IntPtr.Zero, 0, 0, 0, 0, 0x37);
            }
            Console.WriteLine("{\"found\":true,\"opacityApplied\":" + (applied ? "true" : "false") + ",\"retitled\":" + (retitleApplied ? "true" : "false") + ",\"opacity\":" + opacity + "}");
            return applied ? 0 : 5;
        }
        if (IsIconic(target)) ShowWindowAsync(target, 9); // SW_RESTORE, only when minimized.
        else if (!IsWindowVisible(target)) ShowWindowAsync(target, 5); // SW_SHOW.
        for (int i = 0; i < 20 && IsIconic(target); i++) Thread.Sleep(50);
        uint unusedProcess, currentThread = GetCurrentThreadId();
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out unusedProcess);
        uint targetThread = GetWindowThreadProcessId(target, out unusedProcess);
        var attached = new List<uint>();
        try {
            foreach (uint thread in new uint[] {foregroundThread, targetThread}) {
                if (thread != 0 && thread != currentThread && !attached.Contains(thread) && AttachThreadInput(currentThread, thread, true)) attached.Add(thread);
            }
            BringWindowToTop(target);
            SetForegroundWindow(target);
        } finally {
            foreach (uint thread in attached) AttachThreadInput(currentThread, thread, false);
        }
        bool restored = !IsIconic(target), foreground = GetForegroundWindow() == target;
        Console.WriteLine("{\"found\":true,\"restored\":" + (restored ? "true" : "false") + ",\"foreground\":" + (foreground ? "true" : "false") + ",\"retitled\":" + (retitleApplied ? "true" : "false") + "}");
        return restored ? 0 : 4;
    }
}
