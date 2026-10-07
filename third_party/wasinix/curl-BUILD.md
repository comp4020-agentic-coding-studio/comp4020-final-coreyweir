# Curl WASIX build

Source: `https://github.com/wasix-org/wasinix`, revision
`ec2c39877d2718d2c18f33d5ca2492bbc3cf18ba`.

Apply `wasinix.patch` to that revision, then run inside the checkout:

```sh
nix --accept-flake-config --experimental-features 'nix-command flakes' build .#legacyPackages.x86_64-linux.artifacts.webc.curl
```

Use the research repository's `tmp-work/` for the checkout and unpacked
package. Inspect the resulting `result` link and unpack the WEBc with
`wasmer package unpack`; the atom is `modules/curl`. Validate its imports with
`check-package-imports.py` and its execution with `../atom-spawn-check/` before
installing it in the application.

The measured atom SHA-256 is
`29050f9e08f9626e931adf860787809dd1fccead90932e1cb8ae143c1037e5b7`.
It reports curl 8.21.0 and has no wide-arithmetic instructions or `fd_event`
import. The compiler is wasixcc 0.4.5. Nix must accept the flake's binary cache
configuration (including a trusted user where required).

The toolchain-level post-flags are necessary: package-level overrides did not
override the wrapper's final `-mwide-arithmetic`. The curl source guard is
patched because configuring `HAVE_EVENTFD=0` did not remove eventfd wakeups.
Socketpair wakeups avoid the observed eventfd-path hang in the pinned JS
engine; this is a package workaround, not a claim that eventfd is fully fixed.
The blocking resolver is required because the threaded resolver completes the
request but leaves a helper thread that prevents the WASIX process from
exiting. A normal hostname request must exit without curl's `--resolve` option.
