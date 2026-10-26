# Install on Windows

You need 64-bit Windows 10 or 11 and administrator rights for installation. [Choose the version's file](download.md): `karta-ergasias-<version>-windows-x64-setup.exe`.

1. Download it from the project's release page and open it.
2. If **“Windows protected your PC”** appears, select **More info → Run anyway**.

![SmartScreen: More info](../../images/windows-1-smartscreen.png)
![SmartScreen: Run anyway](../../images/windows-2-run-anyway.png)

3. Allow the administrator prompt, then Next → Install → Finish with “Open Work Card” selected.
4. Setup opens in your browser at `http://127.0.0.1:8881`. Continue with [users, PINs and devices](access.md).

The program has no paid Microsoft code-signing certificate. Project-signed updates are a separate check; an already installed application does not automatically verify the first installer you download.

## Allow phones to reach the page

Settings → Network & Internet → Wi-Fi or Ethernet → the practice's protected network → **Private**. The installer opens port 8880 to the local network on private/domain profiles and blocks it on public profiles. A different port needs technical configuration.

The program starts when you sign into Windows. Keep the computer running until staff leave. See [updates](updates.md) for Node.js cases and [troubleshooting](troubleshooting.md) if a phone cannot connect.
