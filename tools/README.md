# Centre Offline License Workflow (Phase 3B)

This directory contains **owner-side** tooling. It must stay on the owner's
offline signing machine and must not be shipped with the application or
embedded in Electron. No production private key is included in this repository.

## Security Model

- Licenses are signed offline with Ed25519.
- The target application only ever contains trusted **public** keys.
- The production private key must remain offline, access-controlled, and
  outside this repository.
- Device binding uses only hashed identifiers produced by
  `device-fingerprint.js`. Raw hardware identifiers are never included in a
  license.
- There is no online activation, no license server, and no revocation service.
- Device binding is a deterrent, not an impossible-to-bypass protection.

## Owner Workflow

### 1. Collect the device binding on the target Windows PC

Run the Phase 2 collector on the target PC, from a directory that is **not**
`~/Documents/CentreData`:

```js
const fs = require("node:fs");
const { createWindowsDeviceBinding } = require("./device-fingerprint");

createWindowsDeviceBinding().then((result) => {
  if (!result.ok) {
    console.error(result.code, result.error);
    process.exit(1);
  }
  fs.writeFileSync("device-binding.json", JSON.stringify(result.data, null, 2));
});
```

The resulting file contains only domain-separated SHA-256 hashes, for example:

```json
{
  "scheme": "centre-device/1",
  "match": "all",
  "identifiers": {
    "machineGuid": "sha256:...",
    "smbiosUuid": "sha256:..."
  }
}
```

It does not contain raw MachineGuid or SMBIOS UUID values.

### 2. Transfer the binding to the owner

Copy `device-binding.json` to the owner's offline machine by USB or another
controlled transfer method. The file contains public hashes, but treat it as
licensing metadata and do not publish it.

### 3. Issue the signed license on the owner machine

```bash
node tools/issue-license.js \
  --private-key /secure/offline/centre-signing-key.pem \
  --key-id centre-2026-01 \
  --device /media/usb/device-binding.json \
  --license-id lic-2026-0001 \
  --licensee "Centre de soutien" \
  --issued-at 2026-11-04 \
  --not-before 2026-11-04 \
  --out /media/usb/license.json
```

Required options:

| Option | Meaning |
|---|---|
| `--private-key` | Ed25519 private key file, kept only on the owner machine |
| `--key-id` | Key ID the target app uses to select the matching public key |
| `--device` | Public device-binding JSON collected from the target PC |
| `--license-id` | Unique owner-assigned license ID |
| `--licensee` | Licensee name |
| `--out` | Output path for the signed envelope |

Optional: `--issued-at` defaults to today, and `--not-before` may be omitted.

The issuer:

- rejects raw identifiers, unsupported identifier names, non-`all` matching,
  malformed hashes, and missing bindings;
- requires both `machineGuid` and `smbiosUuid`; `systemVolumeSerial` is optional
  and may only be added to that pair;
- rejects known placeholder SMBIOS UUIDs, including pre-hashed placeholder
  bindings;
- drops extra binding metadata so only known fields are signed;
- self-verifies the finished envelope against the public key derived from the
  supplied private key;
- never writes the private key or prints license contents.

### 4. Transfer the signed license back by USB

Copy the generated `license.json` to the target Windows PC. It is a signed
envelope compatible with `license-verification.js` and
`license-activation.js`.

### 5. Store and load the license safely in a future phase

The application must use a **dedicated license directory** that does not
overlap `~/Documents/CentreData`. A suitable future location is:

```js
const path = require("node:path");
// app.getPath("userData") is provided by Electron in the future integration.
const storageDir = path.join(app.getPath("userData"), "license");
```

The storage module is deliberately Electron-free. It requires the actual
protected data directory from the application:

```js
const { loadActivatedLicense } = require("./license-store");

const result = await loadActivatedLicense({
  storageDir,
  protectedDataDir: dataDir,         // the real Documents/CentreData path
  registry,                          // registry from trusted-keys.js
  deviceIdentifiers,                 // collected on the current PC
  now: new Date(),
});
```

`license-store.js` provides:

- `resolveLicenseStorage(storageDir, { protectedDataDir })`
- `validateLicenseEnvelope(input)`
- `readLicenseFile(storageDir, { protectedDataDir })`
- `writeLicenseFile(storageDir, envelope, { protectedDataDir })`
- `loadActivatedLicense(options)`

Storage behavior:

- Only `<storageDir>/license.json` and a temporary sibling are written.
- The storage path must be absolute, dedicated, and must not overlap the actual
  protected data directory in either direction.
- Both paths are canonicalized through their nearest existing ancestor, so
  symlinks, junctions, and reparse points cannot hide an overlap. Windows
  trailing-dot/space aliases are rejected, and the path is re-checked after
  directory creation.
- Writes use a temporary file and a single rename. The existing license is
  never deleted first; if replacement fails, the write fails closed and the old
  license remains loadable.
- Reading rejects symbolic-link license files and enforces the Phase 1 size
  limit.
- Activation failure never deletes, resets, overwrites, migrates, or otherwise
  modifies user data.

## Error Codes

License-file layer:

| Code | Meaning |
|---|---|
| `LICENSE_MISSING` | No stored license file was found |
| `LICENSE_UNREADABLE` | File exists but cannot be read or is a symlink |
| `LICENSE_TOO_LARGE` | File or envelope exceeds the size limit |
| `LICENSE_INVALID` | File is not valid JSON, has an invalid envelope shape, or fails cryptographic verification (`cause` carries the detailed code) |
| `UNSAFE_LICENSE_STORAGE` | Storage directory is missing, relative, or overlaps Centre user data |
| `DEVICE_REQUIRED` | Signed license has `device: null` |
| `DEVICE_MISMATCH` | A bound identifier differs from the current PC |
| `IDENTIFIER_UNAVAILABLE` | A required identifier could not be collected |
| `MALFORMED_DEVICE_BINDING` | Signed binding is structurally invalid |

Issuer layer:

| Code | Meaning |
|---|---|
| `INVALID_PRIVATE_KEY` | Key is missing, not Ed25519, or is not a private key |
| `INVALID_KEY_ID` | Key ID is missing or malformed |
| `INVALID_DEVICE_BINDING` | Binding is missing, malformed, or contains raw/unknown identifiers |
| `INVALID_OPTIONS` | Required license metadata is missing |
| `INVALID_LICENSE_ID` / `INVALID_LICENSEE` / `INVALID_ISSUED_AT` / `INVALID_NOT_BEFORE` | Self-verification rejected the payload |

## Limitations

- No revocation, expiration, online validation, or clock-rollback enforcement.
- No production key generation, storage, or distribution is implemented.
- Windows reinstall/sysprep, motherboard replacement, or system-volume
  replacement may require license reissue.
- The storage overlap check canonicalizes existing ancestors and rejects links
  and reparse points in the storage path. Callers must still pass the real
  protected data directory and a dedicated license directory.
- Windows replacement uses one rename and fails closed if the existing license
  cannot be replaced. A crash may leave a temporary file, but it cannot touch
  user data or delete the previous license.
- `tools/` is owner-side and is not part of the application package. The
  packaging whitelist was not changed in this phase.

## Tests

Tests use temporary directories and in-memory Ed25519 keys only. They never use
a production key, a real license, or `~/Documents/CentreData`.
