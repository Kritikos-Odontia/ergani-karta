// SPDX-License-Identifier: EUPL-1.2
import pkg from '../package.json' with { type: 'json' };

/**
 * WHICH PROGRAM THIS IS — its version, and the repository its updates come from. Both from `package.json` (the bundle
 * carries them inlined), so a release is named in one file. A test holds `repository.url` to `name`: renaming the
 * project is those two lines.
 */
export const VERSION: string = pkg.version;

/** `owner/name` on GitHub — the one place the updater asks (update/updater.ts). */
export const REPOSITORY: string = new URL(pkg.repository.url).pathname.replace(/^\//, '').replace(/\.git$/, '');

/** Where a person downloads the newest installer — the release page of that repository. */
export const RELEASES_PAGE: string = `${pkg.repository.url.replace(/\.git$/, '')}/releases/latest`;
