# Starling Compiler V2

## Goal
Provide a separate HTTPS native-mod build service that Starling can select in Options → Mods → Native mods → Build server. Preserve Starling's existing wire protocol so the Android app does not need to be rebuilt.

## Confirmed client protocol
- `POST /v1/build?version=V`: request body is Starling's binary bundle of native mods; the service responds with `{"job":"<24 hex chars>"}`.
- `GET /v1/job/<job>`: responds with queued, building, done, or failed status.
- `GET /v1/job/<job>/lib`: returns the compiled native library and supports byte-range continuation.
- Starling accepts an HTTPS custom build-server URL.

## Architecture
- Cloudflare Worker: HTTPS API gateway compatible with the protocol above.
- GitHub Actions: disposable build machines; untrusted mod code must only run in the existing no-network sandbox.
- Pinned Starling source + matching build scripts + clean base cache: all must use the same exact commit.
- Compatibility adapter: make explicit, tested source transformations for known API changes. Never blindly delete fields or code to silence Rust errors.
- Results: publish the compiled library and status using the existing release-backed result store.

## Isolation and safety
- Keep V2 on its own branch and use a distinct Worker name/URL until verified.
- Do not change the currently working Starling app URL or main branch while developing V2.
- Do not put GitHub or Cloudflare tokens in source, logs, or chat.
- Keep per-mod source private in the existing sealed request flow.
- Preserve size limits, queue limits, rate limits, deterministic job IDs, and build timeouts.
- Keep mod compilation sandboxed without network access.

## Acceptance checks
1. Worker unit tests pass.
2. Protocol tests cover request validation, queue/status, completed-library download, and Range resume.
3. A clean base cache is built for the exact pinned Starling commit.
4. At least one known-compatible native mod compiles and downloads successfully.
5. The reported `title::Button.action` incompatibility is fixed only after its source semantics are known and a regression test is added.
6. A second mod is tested before recommending the V2 URL for regular use.

## Current status
- `compiler-v2` branch created from `main`.
- Existing `mod-builds` already contains the HTTPS Worker and GitHub Actions compiler backend; V2 is a separate, safer development line, not a new protocol.
- No V2 deployment or successful new compilation is claimed yet.
