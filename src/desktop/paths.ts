// SPDX-License-Identifier: EUPL-1.2
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * WHERE THE DESKTOP PROGRAM KEEPS EVERYTHING on this computer — the settings, the two stores (the five-year record),
 * the exports, the versions it runs. One folder, the user's own, never a code folder:
 *   Windows  %LOCALAPPDATA%\Karta Ergasias
 *   Mac      ~/Library/Application Support/Karta Ergasias
 *   Linux    $XDG_DATA_HOME/karta-ergasias (default ~/.local/share/karta-ergasias)
 * `KARTA_DATA_DIR` (absolute) puts it elsewhere — for the tests, and for a practice that wants it on another disk.
 * ⛔ Uninstalling never deletes it: it IS the employer's record.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env, system: NodeJS.Platform = process.platform, home = homedir()): string {
  const chosen = env['KARTA_DATA_DIR']?.trim();
  if (chosen !== undefined && chosen !== '') {
    if (!isAbsolute(chosen)) throw new Error('KARTA_DATA_DIR must be an absolute path.');
    return chosen;
  }
  if (system === 'win32') return join(env['LOCALAPPDATA'] || join(home, 'AppData', 'Local'), 'Karta Ergasias');
  if (system === 'darwin') return join(home, 'Library', 'Application Support', 'Karta Ergasias');
  return join(env['XDG_DATA_HOME'] || join(home, '.local', 'share'), 'karta-ergasias');
}

export interface DesktopPaths {
  root: string;
  /** The employer's settings, in the same format `ergani setup` writes for Docker (setup/settings.ts). 0600. */
  settings: string;
  /** What only the desktop program keeps: the owner's password hash, the backup folder, the update switch. 0600. */
  desktop: string;
  stampDb: string;
  recordsDb: string;
  exports: string;
  /** Each version of the program, in its own folder (the updater's; update/). */
  versions: string;
  /** The program's own log, for the owner's «τι έγινε» page and for support. */
  log: string;
}

export function desktopPaths(root: string): DesktopPaths {
  return {
    root,
    settings: join(root, 'settings.env'),
    desktop: join(root, 'desktop.json'),
    stampDb: join(root, 'stamp', 'stamp.sqlite'),
    recordsDb: join(root, 'records', 'records.sqlite'),
    exports: join(root, 'exports'),
    versions: join(root, 'versions'),
    log: join(root, 'karta.log'),
  };
}

/** The owner pages' port, on 127.0.0.1 (desktop/main.ts). */
export const OWNER_PORT = 8881;

/** The owner pages' port: 8881, or `KARTA_OWNER_PORT` (another program has 8881; the tests). */
export function ownerPort(env: NodeJS.ProcessEnv): number {
  const port = Number(env['KARTA_OWNER_PORT'] ?? OWNER_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('KARTA_OWNER_PORT must be a port number, 1024–65535.');
  return port;
}
