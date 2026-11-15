# Starling's mod builds

Native mods are compiled into [Starling](https://github.com/starling-client/starling), and a phone can't do that itself. When a player taps **Compile**, Starling sends their mods to the Compile service (`worker/`, on Cloudflare), which asks this repository to compile the game with them. The phone then downloads the result from this repository's `results` release.

- `worker/` is the service the game talks to, at the address in Starling's [`build-server.txt`](https://github.com/starling-client/starling/blob/starling/packaging/android/build-server.txt). It seals the mods (AES-256-CTR, a key for each build) into the `requests` release under a random name, and starts `build.yml` with the key in the run's inputs. The same mods on the same commit are the same job, so a build is never done twice. `npm test` there runs its tests, with no network.
- `build.yml` compiles one player's mods. A mod's code runs while it compiles, so that happens in a sandbox with no network, and that job's token can only read this repository. A second job, which runs nothing from the mods, puts the library and its status in `results`, and deletes the sealed mods.
- `clean.yml` deletes old builds, and sealed mods no run took, every six hours.
- `base.yml` makes the clean build cache for one version of the game. It only runs trusted code, and it's the only job that writes the cache.
- `versions.json` says which commit each version of the game is.

Runs and their logs are public, but the mods aren't: the key never shows up in a log. Builds are kept for two weeks.

More in [docs/starling-native-mods.md](https://github.com/starling-client/starling/blob/starling/docs/starling-native-mods.md).
