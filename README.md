# Starling's mod builds

Native mods are compiled into [Starling](https://github.com/starling-client/starling), and a phone can't do that itself. When a player taps **Compile**, Starling sends their mods to the Compile service (`worker/`, on Cloudflare), which asks this repository to compile the game with them. The phone then downloads the result from this repository's `results` release.

- `worker/` is the service the game talks to, at the address in Starling's [`build-server.txt`](https://github.com/starling-client/starling/blob/starling/packaging/android/build-server.txt). It seals the mods (AES-256-CTR, a key for each build) into the `requests` release under a random name, and starts `build.yml` with the key in the run's inputs. The same mods on the same commit are the same job, so a build is never done twice. `npm test` there runs its tests, with no network.
- `build.yml` compiles one player's mods. A mod's code runs while it compiles, so that happens in a sandbox with no network, and that job's token can only read this repository. A second job, which runs nothing from the mods, puts the library and its status in `results`, and deletes the sealed mods.
- `clean.yml` deletes old builds, and sealed mods no run took, every six hours.
- `base.yml` makes the clean build cache for one version of the game. It only runs trusted code, and it's the only job that writes the cache.
- `versions.json` says which commit each version of the game is.

Runs and their logs are public, but the mods aren't: the key never shows up in a log. Builds are kept for two weeks.

## Your own build service

Anyone can run their own copy of this, on their own GitHub and Cloudflare accounts, and point Starling at it. It costs nothing: Actions are free on a public repository, and so are Workers up to 100,000 requests a day.

1. **Fork** this repository, and keep the fork public (on a private one, every build spends your Actions minutes).
2. **Turn on Actions** in the fork: the Actions tab, then "I understand my workflows, go ahead and enable them". GitHub turns off the workflows of a fork, `clean.yml`'s schedule too.
3. **Make the releases** the builds go to. With the [GitHub CLI](https://cli.github.com/), in a Bash shell:
   ```bash
   for tag in requests results results-{0..9} results-{a..f}; do
     gh release create "$tag" -R YOU/mod-builds --prerelease --title "$tag" --notes ""
   done
   ```
4. **Build the base** of each version in `versions.json`: Actions, `base`, Run workflow, with the version (`0.8.0`). It takes about a quarter of an hour, and every player's build starts from it. Run it again when a version is added. Each base is about 3 GB of Actions cache, and a repository gets 10 GB.
5. **Give the service a way in**, one of:
   - a GitHub App (Settings, Developer settings, GitHub Apps, New), with Actions and Contents set to Read and write, installed on the fork alone. Its token has its own hourly limit, and failed runs don't mail you. Keep its id and a private key.
   - a fine-grained token (Settings, Developer settings, Personal access tokens), for the fork alone, with Actions and Contents set to Read and write. It shares your 5,000 API calls an hour, and GitHub mails you every run that fails.
6. **Put the service on Cloudflare**, with [Node.js](https://nodejs.org/) and a free Cloudflare account. In `worker/wrangler.toml`, add your fork:
   ```toml
   [vars]
   REPO = "YOU/mod-builds"
   ```
   then, in `worker/`:
   ```bash
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
   and give it the App:
   ```bash
   echo 123456| npx wrangler secret put GITHUB_APP_ID
   openssl pkcs8 -topk8 -nocrypt -in the-app.private-key.pem | npx wrangler secret put GITHUB_APP_KEY
   ```
   or the token: `npx wrangler secret put GITHUB_TOKEN`, then paste it. `wrangler deploy` prints the service's address, `https://starling-compile.SOMETHING.workers.dev`.
7. **In Starling**: Options, Mods, the Native mods card, **Build server...**, then the address and **Use this server**. Only `https://` addresses are taken. **Use Starling's** goes back to Starling's own.

What a service can do, as it is: GitHub runs 20 jobs at a time on a free account (each build is two), the service starts 32 builds a day for one address and 1,500 for everyone (`PER_ADDRESS` and `PER_DAY` in `worker/src/index.js`), and the free Workers plan answers 100,000 requests a day. Past that, Cloudflare answers 429 until midnight UTC.

The library a build makes runs inside the game on the player's phone, so whoever runs a build service can put anything in it. Only point Starling at a service you trust, and only tell players to use yours if they trust you.

More in [docs/starling-native-mods.md](https://github.com/starling-client/starling/blob/starling/docs/starling-native-mods.md).
