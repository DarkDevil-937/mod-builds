# Development log

## 2026-11-16 — Align native mod builder with the Starling fork

- Updated `scripts/prepare.sh` so the GitHub Actions builder downloads `mod_build_sandbox.sh`, `mod_build_server.py`, and `mod_build_once.py` from the Starling fork's `starling` branch instead of the upstream `starling-client/starling` repository.
- Updated the source checkout to fetch from `DarkDevil-937/starling-rust-26.3`.
- Pinned Starling 0.8.0 to fork commit `1f7a55856a8bfa605e27145de5a1e66c2fd35015`, matching the APK's configured build service and adapter code.
- This changes the commit used in the build job identity, so old cached compile failures for the upstream commit are not reused.
- A fresh clean base cache must be built for the new commit by running the `setup` workflow in this repository. Do not test a mod until the `base` workflow succeeds.
- No claim is made yet that the original `title::Button.action` compile error is fixed; the next compile log must confirm that the fork's adapter resolves it or reveal the next incompatibility.


## 2026-11-16 — Start isolated Starling Compiler V2

- Created branch `compiler-v2` from `main`; existing production branch and configured Starling server URL remain unchanged.
- Confirmed `mod-builds` already implements Starling's HTTPS protocol: `POST /v1/build?version=V`, `GET /v1/job/<id>`, and `GET /v1/job/<id>/lib`.
- V2 will preserve that protocol and isolate its Worker deployment and compiler changes. The actual `Button.action` fix remains unimplemented until the mod's intended action semantics can be established.
- Added `COMPILER_V2_PLAN.md` with architecture, safety boundaries, and acceptance checks. No deployment or successful compile is claimed.


## 2026-11-16 — Compiler V2 protocol isolation and test run

- Worker now reads `versions.json` from configurable `BUILD_REF` and dispatches `build.yml` on the same ref; default remains `main` for the production Worker.
- V2 wrangler config sets `BUILD_REF = compiler-v2` and Worker name `starling-compiler-v2`, keeping the production Worker untouched.
- Added tests for branch-specific version lookup and isolated workflow dispatch. GitHub Actions run 43894497024 passed all 25 Worker tests.
- Cloudflare upload was accepted, but final deployment failed with Cloudflare error 10007 because the new Worker resource `starling-compiler-v2` does not yet exist in the Cloudflare account. The existing production Worker was not modified. Create the new Worker in Cloudflare and connect it to this repository/branch with root directory `worker`, then rerun deploy.
- No V2 HTTPS endpoint is live yet; no mod compilation has been claimed or tested.
