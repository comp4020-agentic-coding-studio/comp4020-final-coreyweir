# Third-party notices

Riff ships third-party code in two places: the npm dependencies bundled into
`app/dist/`, and the WebAssembly command binaries under `app/src/assets/wasmer/`
(copied into `app/dist/assets/`). License texts live in `third_party/licenses/`.

## JavaScript bundled into the client

The npm tree is permissively licensed (MIT, ISC, Apache-2.0, BSD, 0BSD,
BlueOak). The licenses below need more than a mention:

- **@scelar/nodepod** (`app/vendor/scelar-nodepod-1.9.20-riff.43.tgz`, a
  locally patched build): MIT with the Commons Clause, © 2026 R1ck404 /
  ScelarOrg. The Commons Clause forbids selling the software. Riff is
  non-commercial coursework. See `third_party/licenses/nodepod-MIT-CommonsClause.txt`.
- **@wasmer/sdk** (a local fork of wasmer-js): MIT, © Wasmer Inc. See
  `third_party/licenses/wasmer-js-MIT.txt`.
- **lemon-tls** (a local fork, adapted to run in the browser): Apache-2.0.
  The files have been modified from upstream. See
  `third_party/licenses/lemon-tls-Apache-2.0.txt`.
- **Mithic** (`app/dist/mithic/*.cjs`, bundled from
  <https://github.com/andykswong/mithic>): MIT, © 2026 Andy K. S. Wong. See
  `third_party/licenses/mithic-MIT.txt`.

## WebAssembly command binaries

| Binary | Upstream | License | Source / build |
| --- | --- | --- | --- |
| `bash-1.0.25-riff.webc` (bash + GNU find/xargs) | wasix-org/bash `wasix-compat` @ `fc80964`; GNU findutils 4.10.0 | GPL-3.0 | `third_party/bash/` (patch series on top of `fc80964`), `third_party/findutils/` (patch + `build.sh`) |
| `wasinix-coreutils-9.11.0.wasm` | GNU coreutils 9.11.0 via wasinix @ `ec2c398` | GPL-3.0 | `third_party/wasinix/coreutils-BUILD.md` + `wasinix.patch` |
| `wasinix-nano-9.2.0.wasm` | GNU nano 9.2 (`--enable-tiny`) via wasinix | GPL-3.0 | built from wasinix @ `ec2c398` (the checkout present at the time), attribute `artifacts.webc.nano`; sha256 `f5dc70ff…3366` |
| `wasinix-curl-8.21.0.wasm` | curl 8.21.0 via wasinix @ `ec2c398` | curl | `third_party/wasinix/curl-BUILD.md` + `wasinix.patch` |
| `wasinix-jq-1.8.2.wasm` | jq 1.8.2 via wasinix | MIT | wasinix flake |
| `wasinix-rg-15.2.0.wasm` | ripgrep 15.2.0 via wasinix | MIT / Unlicense | wasinix flake |
| `uutils-coreutils-0.11.0.wasm` | uutils coreutils 0.11.0 | MIT | upstream release |
| `bridge-stub.wasm`, `openwrite-stub.wasm`, `argv-stub.wasm`, `fs-probe-wasi` | Riff (own work) | — | `app/tools/stub/` |

The upstream sources are public: wasix-org/bash on GitHub, GNU findutils,
coreutils and nano at <https://ftp.gnu.org/gnu/>, and wasinix's nix recipes.
Riff's modifications are in `third_party/`. GPL-3.0 text:
`third_party/licenses/GPL-3.0.txt`. If anything here is missing, open an issue
and the corresponding source will be provided.

## Not shipped

Claude Code is not in this repo or in the deployed image. Each host's browser
fetches it from the public npm registry at run time.
