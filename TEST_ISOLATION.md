# Isolated Test Data for Development

These variables are development-only. They are ignored in packaged builds.

Test isolation is a development convenience, not a security boundary against a malicious local process. Use fresh, disposable directories that do not already exist, and do not pre-create them as symlinks, junctions, mapped drives, or mount points.

Set both variables together for a fully isolated test instance. Setting only `CENTRE_TEST_PROFILE` still uses the production data directory, and setting only `CENTRE_TEST_DATA_DIR` still uses the production Electron profile.

## Linux

```bash
CENTRE_TEST_DATA_DIR=/tmp/centre-desktop-test/data \
CENTRE_TEST_PROFILE=/tmp/centre-desktop-test/profile \
npm start
```

Remove the variables when finished:

```bash
unset CENTRE_TEST_DATA_DIR
unset CENTRE_TEST_PROFILE
```

## Windows PowerShell

```powershell
$env:CENTRE_TEST_DATA_DIR = "$env:TEMP\centre-desktop-test\data"
$env:CENTRE_TEST_PROFILE = "$env:TEMP\centre-desktop-test\profile"
npm start
```

Remove the variables when finished:

```powershell
Remove-Item Env:CENTRE_TEST_DATA_DIR
Remove-Item Env:CENTRE_TEST_PROFILE
```

## Strengthened Checks

- Both test paths must be non-empty absolute paths without null bytes.
- Each test path is checked against both production roots:
  - The production data directory: `Documents/CentreData`.
  - The production Electron user-data directory.
- Equality and containment in either direction are rejected for both roots.
- Test data and test profile must not be equal, contain each other, or be contained by each other.
- Existing path components are resolved with `realpath`, including symlinks and junction targets.
- For a directory that does not exist yet, the nearest existing ancestor is resolved and the remaining components are appended before comparison.
- Dangling links and existing components that cannot be safely inspected are rejected.
- Validation finishes before `app.setPath("userData", ...)`, `app.requestSingleInstanceLock()`, `createStore()`, and `ensureDir()`.
- An explicitly invalid configuration aborts startup and does not create the store directory.
- The chosen test paths are resolved to their real filesystem paths before being passed to Electron and the data store.
- Automatic backups remain inside the selected test data directory under `backups/`.

## Remaining Limitations

The checks are lexical and filesystem-aware, but they cannot provide complete protection against every alias or race:

- Windows 8.3 short names, device paths, mapped drives, `subst` drives, and some filesystem-specific aliases may not be normalized by Node's path and realpath APIs.
- Case-only aliases on case-insensitive filesystems other than Windows, such as the default macOS filesystem, may not be normalized when neither path exists yet.
- Mount points and bind mounts may expose the same files through different paths.
- A malicious local process could replace a validated path with a symlink or junction after validation and before the first write. No atomic no-follow write path is implemented here.
- Permission or filesystem failures while inspecting an ancestor cause startup to abort rather than continuing unsafely.

For these reasons, use a separate disposable OS profile or virtual machine when testing untrusted scenarios. Do not rely on these variables as a security boundary.

## Focused Tests

The path-resolution tests use temporary directories only, do not launch Electron, and do not access real user data:

```bash
node test/runtime-paths.test.js
```
