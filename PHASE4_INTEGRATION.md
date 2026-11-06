# Phase 4 Integration Notes

This document records the mandatory ordering, packaging allowlist, and trust
anchor for the licensing startup gate.

## Phase 4C status — production packaging and artifact safety

Phase 4C configures the release package and adds static artifact-safety checks.
It does not build, package, sign, launch Electron, or change runtime behavior.

Exact changes:

- `package.json` `build.files` now contains the final runtime allowlist (17
  application files plus `fonts/**/*`) and the explicit exclusion patterns
  listed under **Package contents policy** below.
- `package.json` now sets `"asar": true` explicitly. Electron Builder already
  defaults to ASAR, so this is documentation rather than a behavior change.
- `test/packaging-policy.test.js` now verifies the real `package.json`, proves
  the relative runtime dependency closure, and scans simulated package
  directories for forbidden paths, files, extensions, symlinks, and private-key
  markers. It does not create a real package.
- No licensing verification logic, activation UI, production key, real license,
  or installer target changed in Phase 4C.

Phase 4B wired the offline verification into application startup:

- `main.js` resolves the protected data directory and calls
  `startup-license.js` before any data-store or window work.
- `startup-license.js` resolves the license directory against the actual
  protected data directory, builds the production registry from `trusted-keys.js`,
  and calls `loadActivatedLicense` with a device-identifier collector. The
  loader verifies the envelope before collecting the identifiers named by the
  signed binding (hardened further in Phase 5A).
- On every failure path a native activation error dialog is shown and the app
  quits without creating or modifying the protected data directory.
- No activation UI, license issuer change, production key, or real license was
  made in Phase 4B.

Phase 4A added the storage hardening, trusted-key placeholder, and the first
packaging policy tests.

## Phase 5A — License lifecycle hardening

- Startup now reads the stored envelope and verifies its signature **before**
  trusting the signed device binding. It then collects exactly the identifier
  names present in that verified binding.
- A required-only binding collects only `machineGuid` and `smbiosUuid`. The
  optional `systemVolumeSerial` is collected only when it is explicitly present
  in the signed binding, so a volume-serial change cannot fail a required-only
  license.
- Incomplete or weaker bindings (missing either required identifier, unknown
  identifiers, wrong scheme/match mode, placeholder SMBIOS UUID) are rejected
  before any identifier collection occurs.
- `writeLicenseFile` now requires a trusted `registry` and current
  `deviceIdentifiers`. It cryptographically verifies and device-matches the new
  license before creating or replacing any file. An invalid, mismatched, or
  untrusted license never replaces an existing valid license. Atomic temp-file
  plus rename replacement and temp-file cleanup are unchanged.

## H-2 — Required startup order for Phase 4B

The license gate must run before any data-store work. The only safe sequence in
`app.whenReady()` is:

1. Handle existing startup configuration errors and acquire the single-instance
   lock, exactly as today.
2. Resolve `dataDir` (including test isolation) **without creating it**:
   - `isolatedRuntime.dataDir` when test isolation is active,
   - otherwise `path.join(app.getPath("documents"), "CentreData")`.
3. Resolve `storageDir`, for example
   `path.join(app.getPath("userData"), "license")`, using
   `resolveLicenseStorage(storageDir, { protectedDataDir: dataDir })`.
4. Build the trusted registry with
   `createProductionTrustedKeyRegistry()`. If it returns
   `PRODUCTION_KEY_NOT_CONFIGURED`, show a clear activation error and quit.
5. Verify the stored license with `loadActivatedLicense({ storageDir,
   protectedDataDir: dataDir, registry, collectIdentifiers, platform, now })`.
   - `loadActivatedLicense` reads and cryptographically verifies the envelope
     first, then calls `collectIdentifiers({ identifiers, platform })` with only
     the identifier names in the verified signed binding.
   - Missing, invalid, unreadable, device-mismatched, or identifier-unavailable
     results must show a clear activation error and quit.
   - This step must not create `storageDir`, `dataDir`, or `backups/`.
6. Only after successful verification:
   - `createStore({ dir: dataDir })`,
   - `store.ensureDir()`,
   - `createSaveQueue(...)`,
   - `registerIpc()`,
   - CSP / permission handlers,
   - `createWindow()`.

Mandatory invariants:

- Never call `createStore`, `store.ensureDir`, `registerIpc`, or `createWindow`
  before license verification succeeds.
- Never let the renderer perform or influence license verification.
- Never create `dataDir` or `backups/` merely to check a license.
- On every failure path, show the activation error and quit without touching
  `dataDir`.
- `loadActivatedLicense` is read-only. It must receive the real `dataDir` as
  `protectedDataDir`; it must not assume `os.homedir()/Documents/CentreData`.

Suggested Phase 4B integration test (not implemented in 4A): use a temporary
`dataDir` containing a sentinel file, run a startup-order harness with a
missing/invalid/mismatched license, and assert that `createStore`,
`store.ensureDir`, `registerIpc`, and `createWindow` were never called and that
the sentinel and directory contents are unchanged.

## H-3 — Package contents policy (Phase 4C)

`package.json` `build.files` is an explicit allowlist followed by explicit
exclusions. Electron Builder treats non-`!` entries as includes and `!` entries
as excludes.

Final positive allowlist (17 application files plus font assets):

```json
"main.js",
"preload.js",
"index.html",
"app.js",
"data-validation.js",
"data-store.js",
"security.js",
"save-queue.js",
"shutdown-coordinator.js",
"onedrive-warning.js",
"runtime-paths.js",
"startup-license.js",
"license-verification.js",
"device-fingerprint.js",
"license-activation.js",
"license-store.js",
"trusted-keys.js",
"fonts/**/*"
```

The six licensing modules are `startup-license.js`, `license-verification.js`,
`device-fingerprint.js`, `license-activation.js`, `license-store.js`, and
`trusted-keys.js`. Inspection of the runtime require graph confirmed that no
other relative module and no production `node_modules` package is required.

Explicit exclusions:

- `!tools/**`, `!test/**` — owner-side issuer tools and all tests.
- `!certs/**`, `!keys/**`, `!signing/**` — certificates, private keys, and
  signing material.
- `!.rollback/**`, `!coverage/**`, `!dist/**`, `!out/**` — development and
  build artifacts.
- `!**/*.pem`, `!**/*.key`, `!**/*.p12`, `!**/*.pfx` — key and signing
  extensions.
- `!**/*.tmp`, `!**/*.log`, `!**/*.test.js`, `!**/.env` — temporary files,
  logs, tests, and environment secrets.
- `!**/id_rsa`, `!**/id_ed25519` — SSH private keys.
- `!license.json`, `!device-binding.json` — runtime/user license material.
- `!**/license-issuer.js`, `!**/issue-license.js` — license-issuer utilities.
- `!*.bat`, `!README.txt`, `!TEST_ISOLATION.md`, `!PHASE4_INTEGRATION.md` —
  development launchers and root documentation.

Positive allowlisting is the primary control; the exclusions are defence in
depth against Electron Builder implicitly pulling in files.

## ASAR recommendation

Keep ASAR enabled and set it explicitly with `"asar": true`. Electron Builder
defaults to ASAR, so this does not change current behavior. ASAR packages the
allowlisted files into one archive, which makes accidental inclusion of stray
files less likely and is compatible with `fs`/`path` use in `main.js` and
`startup-license.js`. No obfuscation, Electron fuses, or code signing is added
in Phase 4C.

## Artifact-safety checks

`test/packaging-policy.test.js` is a static, read-only check. It:

- asserts the exact `package.json` include and exclude lists and `asar: true`,
- asserts all six licensing modules are packaged,
- walks every relative `require("./x")` and every `<script src>` to prove the
  runtime dependency closure,
- scans simulated package directories built under a temporary directory,
- flags `tools/`, `test/`, `certs/`, `keys/`, `signing/`, `.rollback/`,
  `coverage/`, `dist/`, and `out/`,
- flags `.pem`, `.key`, `.p12`, `.pfx`, `.tmp`, `.log`, `.test.js`, `.bat`,
  `.env`, `id_rsa`, `id_ed25519`, `license.json`, `device-binding.json`,
  `license-issuer.js`, `issue-license.js`, and the excluded root docs,
- flags symbolic links and files containing `BEGIN ... PRIVATE KEY` or
  `BEGIN PGP PRIVATE KEY BLOCK` markers.

It never runs `npm run dist`, `electron-builder`, or any packaging command, and
it never creates a real artifact.

## Remaining release blockers

1. **Production public key is not configured.** `trusted-keys.js` still returns
   `PRODUCTION_KEY_NOT_CONFIGURED`, so the packaged app fails closed until the
   owner inserts the real Ed25519 public key. No key was generated or inserted.
2. **No real license or activation flow.** There is no activation UI and no
   provisioning path for users; issuing a real license still requires the
   offline production private key.
3. **No code signing or NSIS signing is configured.** `win.target` remains
   `nsis` with no signing certificate, so Windows SmartScreen/trust warnings are
   expected until signing is configured.
4. **No package has been built or scanned.** Phase 4C only provides the
   configuration and the simulated static scanner. A real build must be scanned
   with the same rules before release.
5. **Owner tools must stay out of the package.** `tools/license-issuer.js` and
   any related issuer utilities contain private-key handling and must never be
   shipped.

## H-4 — Trusted production key registry

`trusted-keys.js` is the only runtime trust anchor:

- It contains `PRODUCTION_PUBLIC_KEYS`, hardcoded and currently empty.
- It must contain only Ed25519 **public** keys.
- `createProductionTrustedKeyRegistry()` fails with
  `PRODUCTION_KEY_NOT_CONFIGURED` until the owner inserts a real public key.
- It never reads keys from the filesystem, environment, license, renderer, or
  network.
- `createTrustedKeyRegistry()` brands registries internally. Only registries it
  created are accepted by `verifyActivatedLicense()`; arbitrary objects with
  `has`/`get` methods are rejected.

Owner action before real issuance: insert the public key that corresponds to
the offline private key, keep the private key off this machine and out of the
repository, and verify the key fingerprint through a separate channel.

## H-1 — Storage contract

`resolveLicenseStorage(storageDir, { protectedDataDir })`,
`readLicenseFile(storageDir, options)`,
`writeLicenseFile(storageDir, envelope, options)`, and
`loadActivatedLicense(options)` now require `protectedDataDir`.

`writeLicenseFile` additionally requires `registry` and `deviceIdentifiers`;
`loadActivatedLicense` requires either `deviceIdentifiers` or a
`collectIdentifiers` function.

- Both the license directory and the protected data directory are canonicalized
  through the nearest existing ancestor.
- Symlinks, junctions, and reparse points are resolved before the overlap check,
  and the final storage component is rejected if it is a link.
- Windows trailing-dot/space aliases and existing 8.3 short-name aliases are
  resolved or rejected.
- The storage path is re-checked after directory creation.
- Overlap is compared in both directions on canonical paths.
- `protectedDataDir` must be the actual data directory used by the app, not a
  hardcoded home-directory guess.

## M-1 / M-2 — Safe verified replacement

`writeLicenseFile` first validates the envelope shape, then verifies the
signature against the trusted registry and matches the signed device binding
against the supplied current identifiers. Only a fully verified license may
reach the filesystem.

After verification it writes a temporary sibling, syncs it, then performs one
rename. It never deletes the existing license first. If verification fails,
nothing is written. If the rename fails (for example because the file is locked
on Windows), the write fails with `LICENSE_WRITE_FAILED`, the temporary file is
removed, and the old license remains in place and loadable.

## M-6 / M-9 / M-12 — Device binding

- Standard bindings require both `machineGuid` and `smbiosUuid`.
  `systemVolumeSerial` is optional and may only be added to that pair.
- Known placeholder SMBIOS UUIDs are rejected as raw values and as pre-hashed
  binding entries during issuance and activation.
- `collectWindowsIdentifiers()` returns `IDENTIFIER_UNAVAILABLE` with the full
  `unavailable` list and no partial `data` if any selected identifier is
  missing.
- Identifier reads use own-property checks, so a polluted `Object.prototype`
  cannot supply `machineGuid` or `smbiosUuid`.

## Deferred findings

These review findings are intentionally left for later phases: M-3 (issuer key
pinning), M-4 (CLI output overwrite protection), M-5 (absolute Windows command
paths), M-7 (unsigned envelope metadata policy), M-8 (authenticated
device-binding transfer), M-10 (Windows collection reliability), M-11 (store read
TOCTOU, partially mitigated by opening once with `O_NOFOLLOW`), and the Low
findings.
