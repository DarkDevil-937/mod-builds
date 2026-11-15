// Starling's Compile service on Cloudflare Workers: the door the game knows
// (packaging/android/build-server.txt in starling-client/starling), with this repository's
// GitHub Actions as the machines and its releases as the store. It replaces the gateway that
// lived on a paid VM (mod_build_gateway.py) and keeps the game's side as it was:
//
//   POST /v1/build?version=V   the mods (the game's bundle) in the body: {"job"}, or {"error"}
//   GET  /v1/job/J             {"state": "queued" | "building" | "done" | "failed", ...}
//   GET  /v1/job/J/lib         the library, from the `results` release (a redirect)
//
// The mods are sealed (AES-256-CTR, a key of their own) before they leave here, kept as an asset
// of the `requests` release under a random name, and the key goes to the build in its inputs,
// which only the run reads (build.yml, scripts/unseal.sh). The same mods on the same commit are
// the same job: what was built once is served again without a build.
//
// Secret: GITHUB_TOKEN, a fine-grained token for this repository only, with Actions and Contents
// read and write. Nothing about a player is kept: an address only counts its builds for a day,
// hashed, in this location's cache.

const REPO = "starling-client/mod-builds";
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const DOWNLOADS = `https://github.com/${REPO}/releases/download`;
const VERSIONS = `https://raw.githubusercontent.com/${REPO}/main/versions.json`;
const WORKFLOW = "build.yml";
const REQUESTS = "requests";
const RESULTS = "results";

// What the game sends at most (its LARGEST_REQUEST).
export const MAX_BODY = 32 << 20;
// Builds a day from one address, and from everyone through one Cloudflare location.
export const PER_ADDRESS = 32;
export const PER_DAY = 1500;
const DAY = 24 * 3600;
// How long a build may take before the game is told it is lost (its own wait is 90 minutes).
const LONGEST = 80 * 60;

const JOB = /^[0-9a-f]{24}$/;
const VERSION = /^\d+(\.\d+){1,3}$/;

const NOT_HERE = "No such thing here.";
const YOUR_LIMIT = "You have compiled a lot today. Try again tomorrow.";
const EVERYONES_LIMIT = "The build service has done all it can today. Try again tomorrow.";
const UNAVAILABLE = "The build service can't reach GitHub right now. Try again later.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (request.method === "POST" && url.pathname === "/v1/build") {
        return await build(request, url, env, ctx);
      }
      if (request.method === "GET" && parts[0] === "v1" && parts[1] === "job" && JOB.test(parts[2] ?? "")) {
        if (parts.length === 3) return await status(parts[2], env, ctx);
        if (parts.length === 4 && parts[3] === "lib") return library(parts[2]);
      }
      return answer(404, { error: NOT_HERE });
    } catch (e) {
      console.log(`${request.method} ${url.pathname}: ${e?.stack ?? e}`);
      return answer(503, { error: UNAVAILABLE });
    }
  },
};

/** A new build of `version` with the body's mods, or the job that already has them. */
async function build(request, url, env, ctx) {
  const version = url.searchParams.get("version") ?? "";
  if (!VERSION.test(version)) return answer(400, { error: "That is not a version of the game." });
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY) return answer(413, { error: "That is too big to compile." });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0 || body.length > MAX_BODY) {
    return answer(413, { error: "That is too big to compile." });
  }
  const commit = (await versions())[version];
  if (!commit) {
    return answer(400, {
      error: "This version of Starling can't compile mods any more. Update Starling.",
    });
  }
  const job = await jobOf(version, commit, body);
  // Built before, failing for good, or on its way: the job is all the game needs. A failure that
  // may pass another time (a machine that went away) is built again.
  if (await published(`${job}.json`, ctx)) return answer(200, { job });
  const failure = await failureOf(job, ctx);
  if (failure?.settled) return answer(200, { job });
  const asked = await recall(`asked/${job}`);
  if (asked && !(failure && (failure.at ?? 0) >= asked.at)) return answer(200, { job });
  if (!failure && (await running(job, env, ctx))) return answer(200, { job });

  const address = await hashed(request.headers.get("CF-Connecting-IP") ?? "unknown");
  if (!(await count(`address/${address}`, PER_ADDRESS, ctx))) return answer(429, { error: YOUR_LIMIT });
  if (!(await count("everyone", PER_DAY, ctx))) return answer(429, { error: EVERYONES_LIMIT });

  const { sealed, key } = await seal(body);
  const ask = hex(crypto.getRandomValues(new Uint8Array(16)));
  await upload(env, ctx, REQUESTS, `${ask}.bin`, sealed);
  await github(env, "POST", `/actions/workflows/${WORKFLOW}/dispatches`, {
    ref: "main",
    inputs: { job, ask, key, version },
  });
  ctx.waitUntil(remember(`asked/${job}`, { at: now() }, LONGEST));
  return answer(200, { job });
}

/** What the game shows while it waits, and the library's checksum once it is there. */
async function status(job, env, ctx) {
  const done = await published(`${job}.json`, ctx);
  if (done) return answer(200, done);
  const failure = await failureOf(job, ctx);
  const asked = await recall(`asked/${job}`);
  // A failure the build ran again since is old news.
  if (failure && !(asked && asked.at > (failure.at ?? 0))) {
    const { state, error, settled } = failure;
    return answer(200, { state, error, settled: Boolean(settled) });
  }
  // Whole seconds: the game reads them as an integer (`as_u64`), and a fraction reads as none.
  if (asked) return answer(200, { state: "building", seconds: Math.max(0, Math.floor(now() - asked.at)) });
  const run = await running(job, env, ctx);
  if (run) return answer(200, run);
  return answer(404, { error: "No such job." });
}

/** The finished library, where GitHub serves it (with Range, for a download that goes on). */
function library(job) {
  return new Response(null, {
    status: 302,
    headers: { Location: `${DOWNLOADS}/${RESULTS}/${job}.so` },
  });
}

/** The job of these mods on this commit: the same mods ask for the same build. */
export async function jobOf(version, commit, body) {
  const asked = new TextEncoder().encode(`/v1/build?version=${version}&commit=${commit}`);
  const all = new Uint8Array(asked.length + body.length);
  all.set(asked);
  all.set(body, asked.length);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", all))).slice(0, 24);
}

/**
 * The body sealed with AES-256-CTR under a fresh key: `key` is the key's hex and then the counter
 * block's, as `openssl enc -aes-256-ctr -K -iv` takes them. The counter's low 64 bits start at
 * zero, so WebCrypto's 64-bit counter and OpenSSL's 128-bit one never part.
 */
export async function seal(body) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const counter = crypto.getRandomValues(new Uint8Array(16));
  counter.fill(0, 8);
  const key = await crypto.subtle.importKey("raw", raw, "AES-CTR", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, body);
  return { sealed: new Uint8Array(sealed), key: hex(raw) + hex(counter) };
}

/** versions.json: each version the service compiles, and its commit. */
async function versions() {
  const response = await fetch(VERSIONS, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error(`versions.json: ${response.status}`);
  return response.json();
}

/**
 * One of the results release's JSON files, or null; kept here an hour once there (scripts/clean.py
 * deletes old builds), 15 s while not.
 */
async function published(name, ctx, seconds = 3600) {
  const key = `published/${name}`;
  const known = await recall(key);
  if (known) return known.value;
  const response = await fetch(`${DOWNLOADS}/${RESULTS}/${name}`, { redirect: "follow" });
  if (response.status === 404) {
    ctx.waitUntil(remember(key, { value: null }, 15));
    return null;
  }
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  const value = await response.json();
  ctx.waitUntil(remember(key, { value }, seconds));
  return value;
}

/** The last failure published for `job`, which a new run replaces. */
function failureOf(job, ctx) {
  return published(`${job}.failed.json`, ctx, 30);
}

/** The job's run on GitHub when it is queued or going: what the game is told of it. */
async function running(job, env, ctx) {
  const key = `run/${job}`;
  const known = await recall(key);
  if (known) return known.value;
  const { workflow_runs: runs } = await github(
    env,
    "GET",
    `/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=100`,
  );
  const run = runs.find((r) => r.display_title === `build ${job}` && r.status !== "completed");
  let value = null;
  if (run?.status === "in_progress") {
    const began = Date.parse(run.run_started_at ?? "") / 1000;
    value = { state: "building", seconds: Number.isFinite(began) ? Math.max(0, Math.floor(now() - began)) : 0 };
  } else if (run) {
    value = { state: "queued", ahead: 0 };
  }
  ctx.waitUntil(remember(key, { value }, 20));
  return value;
}

/** Puts `bytes` in release `tag` as `name`. */
async function upload(env, ctx, tag, name, bytes) {
  const id = await releaseId(env, ctx, tag);
  const response = await fetch(
    `${UPLOADS}/repos/${REPO}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
    { method: "POST", headers: { ...headers(env), "Content-Type": "application/octet-stream" }, body: bytes },
  );
  if (!response.ok) throw new Error(`upload ${tag}/${name}: ${response.status} ${await response.text()}`);
}

async function releaseId(env, ctx, tag) {
  const key = `release/${tag}`;
  const known = await recall(key);
  if (known) return known.value;
  const { id } = await github(env, "GET", `/releases/tags/${tag}`);
  ctx.waitUntil(remember(key, { value: id }, DAY));
  return id;
}

/** One call to the repository's API: its JSON, or null when it answers nothing. */
async function github(env, method, path, payload) {
  const response = await fetch(`${API}/repos/${REPO}${path}`, {
    method,
    headers: { ...headers(env), ...(payload ? { "Content-Type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function headers(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "starling-compile",
  };
}

/** Adds one to today's count of `name` unless it is at `limit`: whether it was below. */
async function count(name, limit, ctx) {
  const key = `count/${Math.floor(now() / DAY)}/${name}`;
  const known = await recall(key);
  const n = known?.value ?? 0;
  if (n >= limit) return false;
  ctx.waitUntil(remember(key, { value: n + 1 }, DAY));
  return true;
}

// This location's cache holds what is worth not asking GitHub again; keys are made-up URLs.
function cacheKey(name) {
  return new Request(`https://starling-compile.cache/${name}`);
}

async function recall(name) {
  const hit = await caches.default.match(cacheKey(name));
  return hit ? hit.json() : null;
}

function remember(name, value, seconds) {
  return caches.default.put(
    cacheKey(name),
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${seconds}` },
    }),
  );
}

async function hashed(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).slice(0, 32);
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function now() {
  return Date.now() / 1000;
}

function answer(code, body) {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
