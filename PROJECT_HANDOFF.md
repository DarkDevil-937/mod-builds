# Project handoff

## Current goal
Make Starling's Cloudflare Compile service build native mods against the same Starling fork and compatibility adapter used by the Android APK.

## Repositories
- App: `DarkDevil-937/starling-rust-26.3`, branch `starling`.
- Build service: `DarkDevil-937/mod-builds`, branch `main`.
- Cloudflare Worker: `starling-compile.airtelat5.workers.dev`.

## Root cause found
The Worker dispatches `build.yml` in this build-service repository. Before this fix, `scripts/prepare.sh` downloaded build scripts from `starling-client/starling` and fetched the game source from that upstream repository. Therefore the service was not necessarily using the fork's `native_mod_adapt.py` even though the Android APK came from the fork.

## Changes made
- `scripts/prepare.sh` now defaults both source and build scripts to `DarkDevil-937/starling-rust-26.3`, branch `starling`.
- `versions.json` now pins Starling 0.8.0 to `1f7a55856a8bfa605e27145de5a1e66c2fd35015`.
- `DEVELOPMENT_LOG.md` records the change and outstanding verification.

## Required next steps
1. Run the `setup` workflow in `DarkDevil-937/mod-builds`. It creates any missing result releases and dispatches `base.yml` for 0.8.0.
2. Wait for the `base` workflow to finish successfully. It must create cache key `base-1f7a55856a8bfa605e27145de5a1e66c2fd35015`.
3. Then test compiling the same native mod in Starling. No APK reinstall is needed because only the server changed.
4. If the compile still fails, inspect the new build's `build` workflow log. The previous known error was Rust E0560: `title::Button` has no field named `action`. Do not blindly remove the field; inspect the exact mod source and current Button API before adding a compatibility rewrite.
