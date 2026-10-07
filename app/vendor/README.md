# Vendored packages

`scelar-nodepod-1.9.20-riff.27.tgz` is the private Riff build of
`@scelar/nodepod`. It includes the source-level environment, shell, Git binary,
Preview, external-command lifecycle, direct external-command routing,
binary-safe external-command I/O, terminal streaming, and byte-safe live
external-command stdin maintained in the fork.

Riff installs this immutable archive through `package-lock.json`; it is not
published to a public registry and must not be replaced by a mutable `npm link`.

Always publish fork changes under a new `riff.N` version. Repacking an archive
under an existing version leaves `package-lock.json` pointing at the previous
integrity hash, and npm then reinstalls the superseded tarball from its cache.

## Cutting a new `riff.N`

Two steps silently produce a tarball that looks right and contains the previous
release. Both were hit cutting `riff.38`.

**Build before packing.** `npm pack` runs `prepack`, not `prepublishOnly`, and
the fork's build is on `prepublishOnly`. So packing on its own ships whatever
`dist/` happens to be on disk — which is the last release's, with none of the
new work in it, and nothing says so. In `nodepod_fork`:

```
pnpm run build:publish && npm pack
```

Then check the tarball actually contains the change, by name, before moving it
here. A symbol added in this release is the cheapest possible test:

```
tar xzf scelar-nodepod-1.9.20-riff.N.tgz -C /tmp/check
rg -l '<a symbol this release adds>' /tmp/check/package/dist
```

**Install the new spec, do not hand-edit the lockfile.** Renaming the tarball in
`package.json` and `package-lock.json` by hand leaves the previous release's
`integrity` hash behind. npm compares the entry, decides the tree is already
satisfied, prints `up to date`, and leaves the old package installed. Instead:

```
npm install file:vendor/scelar-nodepod-1.9.20-riff.N.tgz
```

which rewrites `resolved` and `integrity` together. Confirm with
`node -e "console.log(require('./node_modules/@scelar/nodepod/package.json').version)"`
rather than trusting the install output.
