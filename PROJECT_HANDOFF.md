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


## Starling Compiler V2 (new work)
- Development branch: `compiler-v2` in `DarkDevil-937/mod-builds`.
- Production branch `main` and current Worker URL `https://starling-compile.airtelat5.workers.dev` are not changed.
- The existing Worker already speaks Starling's custom HTTPS protocol. V2 should preserve it: POST `/v1/build?version=V`, GET `/v1/job/<24-hex-id>`, GET `/v1/job/<24-hex-id>/lib`.
- Read `COMPILER_V2_PLAN.md` before making changes. V2 needs its own Worker name and URL before deployment.
- The original Rust E0560 `title::Button.action` issue is not fixed yet. Do not remove or rewrite the field without seeing the actual mod source and understanding the event mapping.


## Compiler V2 latest status (2026-11-16)
- Branch: `compiler-v2`.
- Worker name in `worker/wrangler.toml`: `starling-compiler-v2`; branch selector `BUILD_REF=compiler-v2`.
- Worker tests: 25/25 pass in Actions run 43894497024.
- Deployment: blocked because Cloudflare reports Worker resource `starling-compiler-v2` does not exist (error 10007). Existing production Worker `starling-compile` was not touched.
- Required account-side step: create a separate Cloudflare Worker named `starling-compiler-v2`, connect GitHub repo `DarkDevil-937/mod-builds`, branch `compiler-v2`, root directory `worker`. Then rerun the Deploy Cloudflare Worker workflow or let the Git integration deploy. Ensure the new Worker has the GitHub token secret `GITHUB_TOKEN` (workflow step sets it from repo secret `STARLING_GITHUB_TOKEN` when deploy workflow runs).
- After deployment, test an actual mod through V2 before changing Starling's custom server URL. Production remains `https://starling-compile.airtelat5.workers.dev` until V2 passes.
