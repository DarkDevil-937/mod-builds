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
