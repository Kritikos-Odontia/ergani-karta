// SPDX-License-Identifier: EUPL-1.2
import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';

/**
 * WHAT A RELEASE CARRIES, AND THE ONE CHECK THAT LETS IT IN.
 *
 * Every release on GitHub carries, beside the installers (.github/workflows/release.yml):
 *   · `manifest.json` — the version, the app's one file, and for each system the Node.js runtime (the one binary,
 *     gzipped) with Node's version;
 *   · `SHA256SUMS` — `<sha256>  <file>` for every file of the release, manifest.json included;
 *   · `SHA256SUMS.sig` — an Ed25519 signature over the exact bytes of SHA256SUMS (base64), made in CI with the
 *     project's update-signing key, whose private half is the repository's one secret.
 * ⛔ Nothing of a release is trusted before `verifiedRelease` has checked that signature against a key in
 * `UPDATE_KEYS`; after it, every file used must match its line in SHA256SUMS. A release signed with any other key, a
 * file changed after signing, a release that is not newer than this program — refused, whatever is serving it.
 */
export const UPDATE_KEYS: readonly string[] = [
  // The project's update-signing key, public half (SPKI, DER, base64). A new key is ADDED here one release before the
  // old one stops signing, so every installed copy can follow.
  'MCowBQYDK2VwAyEANG10zuKG2519EVgxq+YGHj5kps03J8ifK65s6EEgkYQ=',
];

/** The systems a release carries a runtime for — `<process.platform>-<process.arch>`. */
export const SYSTEMS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'] as const;
export type System = (typeof SYSTEMS)[number];

const Version = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
/** A plain file name of the release: no folder, nothing hidden. */
const FileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

export const Manifest = z
  .object({
    format: z.literal(1),
    version: Version,
    /** The app: ONE JavaScript file (the bundle). */
    app: FileName,
    /** The Node.js version of the runtimes below. */
    node: Version,
    runtimes: z.record(z.enum(SYSTEMS), FileName),
  })
  .strict();
export type Manifest = z.infer<typeof Manifest>;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `x.y.z` newer than `than`. */
export function newer(version: string, than: string): boolean {
  const [a, b] = [version, than].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i += 1) {
    if (a![i]! !== b![i]!) return a![i]! > b![i]!;
  }
  return false;
}

/** SHA256SUMS → file name → sha256. Strict: exactly `<64 hex>  <file name>` per line, no name twice. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (match === null || !FileName.safeParse(match[2]).success || sums.has(match[2]!)) {
      throw new Error('ο κατάλογος ελέγχου της έκδοσης δεν είναι έγκυρος');
    }
    sums.set(match[2]!, match[1]!);
  }
  return sums;
}

/** Whether `signature` (base64) is an Ed25519 signature of `sums` by one of `keys`. */
export function signedByUs(sums: Uint8Array, signature: string, keys: readonly string[] = UPDATE_KEYS): boolean {
  const raw = Buffer.from(signature.trim(), 'base64');
  if (raw.length !== 64) return false;
  return keys.some((key) => {
    try {
      return verify(null, sums, createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }), raw);
    } catch {
      return false;
    }
  });
}

export interface VerifiedRelease {
  manifest: Manifest;
  /** File name → sha256, from the signed list: what every downloaded file must match. */
  sums: Map<string, string>;
}

/**
 * The three small files of a release → its manifest, or a refusal. The order is the point: the signature first, then
 * the manifest's checksum against the signed list, then what the manifest names must be in that list too.
 */
export function verifiedRelease(
  files: { sums: Uint8Array; signature: string; manifest: Uint8Array },
  keys: readonly string[] = UPDATE_KEYS,
): VerifiedRelease {
  if (!signedByUs(files.sums, files.signature, keys)) throw new Error('η υπογραφή της έκδοσης δεν είναι δική μας — δεν εγκαθίσταται');
  const sums = parseSums(Buffer.from(files.sums).toString('utf8'));
  if (sums.get('manifest.json') !== sha256(files.manifest)) throw new Error('το manifest.json της έκδοσης δεν ταιριάζει με την υπογραφή');
  const manifest = Manifest.parse(JSON.parse(Buffer.from(files.manifest).toString('utf8')));
  for (const name of [manifest.app, ...Object.values(manifest.runtimes)]) {
    if (!sums.has(name)) throw new Error(`το αρχείο ${name} λείπει από τον υπογεγραμμένο κατάλογο`);
  }
  return { manifest, sums };
}

/** This computer's system, if releases carry a runtime for it. */
export function thisSystem(platform: string = process.platform, arch: string = process.arch): System | undefined {
  const key = `${platform}-${arch}`;
  return (SYSTEMS as readonly string[]).includes(key) ? (key as System) : undefined;
}
