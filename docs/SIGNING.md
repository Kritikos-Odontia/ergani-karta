# Signing — what is signed, by whom, and what is not

## The updates: signed by the project, checked by the program

Every release carries `SHA256SUMS` (the sha256 of every file of the release) and `SHA256SUMS.sig`, an **Ed25519**
signature over it made by the release workflow (`.github/workflows/release.yml`, `packaging/release-files.mjs`) with
the project's update-signing key. The key's private half is a repository secret, given to that one step only; its
public half is in the program (`src/update/release.ts`, `UPDATE_KEYS`). An installed copy installs an update only when:

1. the signature verifies against a key in `UPDATE_KEYS`;
2. `manifest.json` and every downloaded file match their line in the signed list;
3. the version is newer than its own.

Anything else is refused and the reason is shown on the owner's «Ενημερώσεις» page. The workflow refuses to sign with a
key the program does not hold. To change keys: add the new public key to `UPDATE_KEYS` in a release signed with the old
one; sign with the new one from the next release on.

## The installers: not signed with a paid certificate

There is no Apple Developer ID and no Windows code-signing certificate (a cost the project does not carry for now). So:

- **macOS:** the app is signed *ad hoc* (Apple silicon needs at least that). The first open needs System Settings →
  Privacy & Security → «Open Anyway». The Node.js runtime inside keeps its own signature (Node.js Foundation).
- **Windows:** the installer and the small starter are unsigned; SmartScreen asks «More info → Run anyway» once. The
  Node.js runtime (`node.exe`) carries the Node.js project's own signature.
- **Linux:** the `.deb` is not in an archive with a signed index; install it from the project's Releases page.

Updates never bring those warnings back: they are downloaded by the program itself, not by a browser, and checked by
the signature above.

## Free signing for Windows — SignPath Foundation (not yet applied for)

SignPath Foundation signs open-source Windows programs at no cost, once the project is public, released, and known.
When the project applies, this is its code-signing policy, to publish on the project page:

> **Code signing policy.** Free code signing provided by [SignPath.io](https://signpath.io), certificate by
> [SignPath Foundation](https://signpath.org). Windows releases are built and signed only by the project's release
> workflow on GitHub-hosted runners, from a tagged commit of this repository; nothing built elsewhere is signed.
> Committers and reviewers: the repository's maintainers (listed on the repository); every release is approved by a
> maintainer. **Privacy:** this program sends nothing to anyone except, once a day, one request to GitHub's public
> releases API asking for the newest release of this repository (no identifier, version or data is sent); the practice
> can switch automatic updates off. The ΕΡΓΑΝΗ filings it makes are the employer's own, to the Ministry of Labour,
> with the employer's own restricted login.

The workflow then gains a signing step for `KartaErgasias.exe` and the installer; nothing changes for those already
installed.
