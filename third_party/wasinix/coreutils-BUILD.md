# GNU coreutils WASIX build

Source: `https://github.com/wasix-org/wasinix`, revision
`ec2c39877d2718d2c18f33d5ca2492bbc3cf18ba`.

Apply [`../curl-build/wasinix.patch`](../curl-build/wasinix.patch) to that
revision (the toolchain-wide `-mno-wide-arithmetic` flag is required; the
curl-specific hunk is unused here), then run inside the checkout:

```sh
nix --accept-flake-config --experimental-features 'nix-command flakes' build .#legacyPackages.x86_64-linux.artifacts.webc.coreutils
```

Use the research repository's `tmp-work/` for the checkout and unpacked
package. Inspect the resulting `result` link and unpack the WEBc with
`wasmer package unpack`; the atom is `modules/coreutils`. Validate its
imports with `check-package-imports.py`, engine loading with
`../atom-spawn-check/spawn-check.mjs`, and child execution with
`../atom-spawn-check/coreutils-check.mjs` before installing it in the
application.

The measured atom SHA-256 is
`7534fb8088b1fb508878cab3cd37dcb22db4076e0579255b914b8b22d9b71296`.
It is GNU coreutils 9.11.0, built with wasixcc 0.4.5 against
`wasix-sysroot-off`, and has no wide-arithmetic instructions. The app
installs the atom as session-bin `env`, `stat`, `du`, `id`, `timeout`,
and `chmod`.

`timeout` also requires the fork to record process parent identity:
without it, `getppid()` in a forked child returns 0 and GNU timeout
exits 125 before exec. That is a runtime fix, not a package workaround.
