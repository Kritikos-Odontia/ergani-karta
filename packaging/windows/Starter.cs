// SPDX-License-Identifier: EUPL-1.2
// THE WINDOWS STARTER — KartaErgasias.exe, the one Windows program of the install (compiled in the release workflow
// with the C# compiler every Windows has; no window of its own). It only starts the launcher (launcher.mjs, on the
// node.exe beside it) and keeps it running; the launcher does everything else.
//   KartaErgasias.exe                 the icon: make sure it runs, and open the owner's page
//   KartaErgasias.exe --background    at sign-in (the Run entry): only make sure it runs
// One per signed-in user (a named mutex): a second start only opens the page.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

static class Starter
{
    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        bool background = Array.IndexOf(args, "--background") >= 0;
        bool first;
        using (var running = new Mutex(true, @"Local\KartaErgasias", out first))
        {
            if (!background) Start(dir, "open");
            if (!first) return 0;
            while (true)
            {
                Process launcher = Start(dir, "run");
                launcher.WaitForExit();
                if (launcher.ExitCode == 0) return 0;
                Thread.Sleep(5000);
            }
        }
    }

    static Process Start(string dir, string command)
    {
        var info = new ProcessStartInfo(Path.Combine(dir, "node.exe"), "\"" + Path.Combine(dir, "launcher.mjs") + "\" " + command)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = dir,
        };
        return Process.Start(info);
    }
}
