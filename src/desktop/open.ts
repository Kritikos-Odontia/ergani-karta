// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';

/**
 * Open `target` — a page's address, or a folder — with the system's own program (the browser, the file browser).
 * A failure is only logged: the owner can open it by hand. No shell is involved, and `target` is always this program's
 * own address or folder.
 */
export function openInBrowser(target: string, log: (line: string) => void): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['explorer.exe', [target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    spawn(command, args as string[], { detached: true, stdio: 'ignore', windowsHide: true })
      .on('error', () => log(`open ${target} by hand`))
      .unref();
  } catch {
    log(`open ${target} by hand`);
  }
}
