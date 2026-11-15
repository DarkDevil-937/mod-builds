// The Compile service against a GitHub of its own (this file's), with no network: node --test.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash } from "node:crypto";
import worker, { jobOf, seal, PER_ADDRESS, MAX_BODY } from "../src/index.js";

const REPO = "starling-client/mod-builds";
const COMMIT = "ac874422ed8f892505ff73d67ae486ecfee7a516";

/** The cache of one Cloudflare location: what was put, until its max-age. */
class Cache {
  entries = new Map();
  clock = 0;
  async match(request) {
    const entry = this.entries.get(request.url);
    if (!entry || entry.until <= this.clock) return undefined;
    return new Response(entry.body);
  }
  async put(request, response) {
    const age = Number(/max-age=(\d+)/.exec(response.headers.get("Cache-Control"))[1]);
    this.entries.set(request.url, { body: await response.text(), until: this.clock + age });
  }
}

/** GitHub as the service sees it: two releases, the workflow's runs, versions.json. */
class GitHub {
  assets = { requests: new Map(), results: new Map() };
  runs = [];
  dispatched = [];
  calls = 0;
  async fetch(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method ?? "GET";
    const json = (code, body) => new Response(JSON.stringify(body), { status: code });
    if (url.href === `https://raw.githubusercontent.com/${REPO}/main/versions.json`) {
      return json(200, { "0.8.0": COMMIT });
    }
    const download = url.href.match(new RegExp(`^https://github.com/${REPO}/releases/download/([\\w-]+)/(.+)$`));
    if (download) {
      const bytes = this.assets[download[1]]?.get(download[2]);
      return bytes ? new Response(bytes) : new Response("Not Found", { status: 404 });
    }
    this.calls++;
    assert.equal(init.headers?.Authorization, "Bearer secret", "every API call carries the token");
    if (url.host === "uploads.github.com") {
      const id = url.pathname.split("/")[5];
      const tag = { 1: "requests", 2: "results" }[id];
      this.assets[tag].set(url.searchParams.get("name"), new Uint8Array(await new Response(init.body).arrayBuffer()));
      return json(201, {});
    }
    const path = url.pathname.replace(`/repos/${REPO}`, "");
    if (path === "/releases/tags/requests") return json(200, { id: 1 });
    if (path === "/releases/tags/results") return json(200, { id: 2 });
    if (method === "POST" && path === "/actions/workflows/build.yml/dispatches") {
      this.dispatched.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (path === "/actions/workflows/build.yml/runs") {
      const status = url.searchParams.get("status");
      const page = Number(url.searchParams.get("page") ?? 1);
      const runs = this.runs.filter((r) => !status || r.status === status);
      return json(200, { workflow_runs: page === 1 ? runs : [] });
    }
    return json(404, { message: "Not Found" });
  }
}

let github, cache, waiting;
// No hold in the tests but the one that tests it.
const env = { GITHUB_TOKEN: "secret", HOLD_MS: 0 };
const ctx = { waitUntil: (p) => waiting.push(p) };

beforeEach(() => {
  github = new GitHub();
  cache = new Cache();
  waiting = [];
  globalThis.fetch = (input, init) => github.fetch(input, init);
  globalThis.caches = { default: cache };
});

async function call(method, path, { body, address = "203.0.113.7" } = {}) {
  const response = await worker.fetch(
    new Request(`https://starling-compile.example${path}`, {
      method,
      body,
      headers: { "CF-Connecting-IP": address },
    }),
    env,
    ctx,
  );
  await Promise.all(waiting.splice(0));
  return response;
}

const mods = new TextEncoder().encode("the player's mods ".repeat(100));

test("new mods are sealed, kept under a random name and built", async () => {
  const response = await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.equal(response.status, 200);
  const { job } = await response.json();
  assert.equal(job, await jobOf("0.8.0", COMMIT, mods));
  assert.equal(github.dispatched.length, 1);
  const { ref, inputs } = github.dispatched[0];
  assert.equal(ref, "main");
  assert.deepEqual(Object.keys(inputs).sort(), ["ask", "job", "key", "version"]);
  assert.equal(inputs.job, job);
  assert.equal(inputs.version, "0.8.0");
  assert.match(inputs.ask, /^[0-9a-f]{32}$/);
  assert.match(inputs.key, /^[0-9a-f]{96}$/);
  const sealed = github.assets.requests.get(`${inputs.ask}.bin`);
  assert.ok(sealed, "the sealed mods are in the requests release");
  assert.notDeepEqual(sealed, mods);
  // As the build opens them: openssl enc -d -aes-256-ctr -K <64 hex> -iv <32 hex>.
  const opened = createDecipheriv(
    "aes-256-ctr",
    Buffer.from(inputs.key.slice(0, 64), "hex"),
    Buffer.from(inputs.key.slice(64), "hex"),
  );
  assert.deepEqual(new Uint8Array(Buffer.concat([opened.update(sealed), opened.final()])), mods);
});

test("the job is the build's own check: sha256 of what was asked and the mods", async () => {
  const asked = `/v1/build?version=0.8.0&commit=${COMMIT}`;
  const want = createHash("sha256").update(asked).update(mods).digest("hex").slice(0, 24);
  assert.equal(await jobOf("0.8.0", COMMIT, mods), want);
});

test("a long body still opens: the counter never carries past its low 64 bits", async () => {
  const big = new Uint8Array(1 << 20).map((_, i) => i * 7);
  const { sealed, key } = await seal(big);
  const opened = createDecipheriv("aes-256-ctr", Buffer.from(key.slice(0, 64), "hex"), Buffer.from(key.slice(64), "hex"));
  assert.deepEqual(new Uint8Array(Buffer.concat([opened.update(sealed), opened.final()])), big);
});

test("the same mods asked again while they build start nothing new", async () => {
  await call("POST", "/v1/build?version=0.8.0", { body: mods });
  const again = await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.equal(again.status, 200);
  assert.equal(github.dispatched.length, 1);
  assert.equal(github.assets.requests.size, 1);
});

test("mods built before are the same job, and nothing is built", async () => {
  const job = await jobOf("0.8.0", COMMIT, mods);
  const done = { state: "done", sha256: "a".repeat(64), size: 1234, build: { abi: "arm64-v8a" } };
  github.assets.results.set(`${job}.json`, new TextEncoder().encode(JSON.stringify(done)));
  const response = await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.deepEqual(await response.json(), { job });
  assert.equal(github.dispatched.length, 0);
  assert.equal(github.calls, 0, "no call to GitHub's API");
  const status = await call("GET", `/v1/job/${job}`);
  assert.deepEqual(await status.json(), done);
});

test("a job on its way says it builds, and the library is GitHub's download", async () => {
  const { job } = await (await call("POST", "/v1/build?version=0.8.0", { body: mods })).json();
  const status = await (await call("GET", `/v1/job/${job}`)).json();
  assert.equal(status.state, "queued", "just asked: in line until GitHub lists its run");
  assert.ok(Number.isInteger(status.ahead), "a whole place, as the game reads it");
});

test("a build in its shard release is found before the old results release", async () => {
  const job = "7123456789abcdef01234567";
  const done = { state: "done", sha256: "b".repeat(64), size: 4, build: {} };
  github.assets["results-7"] = new Map([
    [`${job}.json`, new TextEncoder().encode(JSON.stringify(done))],
    [`${job}.so`, new Uint8Array([1, 2, 3, 4])],
  ]);
  assert.deepEqual(await (await call("GET", `/v1/job/${job}`)).json(), done);
  const lib = await worker.fetch(
    new Request(`https://starling-compile.example/v1/job/${job}/lib`, { headers: { Range: "bytes=0-" } }),
    env,
    ctx,
  );
  assert.deepEqual(new Uint8Array(await lib.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  const resumed = await worker.fetch(
    new Request(`https://starling-compile.example/v1/job/${job}/lib`, { headers: { Range: "bytes=2-" } }),
    env,
    ctx,
  );
  assert.equal(resumed.headers.get("Location"), `https://github.com/${REPO}/releases/download/results-7/${job}.so`);
});

test("a library from the start is a 200 the game can write; one that goes on is GitHub's 206", async () => {
  const job = "0123456789abcdef01234567";
  const library = new Uint8Array(4096).map((_, i) => i % 251);
  github.assets.results.set(`${job}.so`, library);
  // 0.8.0 asks with bytes=0- and appends on a 206: the first answer has to be a 200, whole.
  for (const range of ["bytes=0-", null]) {
    const response = await worker.fetch(
      new Request(`https://starling-compile.example/v1/job/${job}/lib`, {
        headers: range ? { Range: range } : {},
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 200, `Range ${range}`);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), library);
  }
  const resumed = await worker.fetch(
    new Request(`https://starling-compile.example/v1/job/${job}/lib`, { headers: { Range: "bytes=1000-" } }),
    env,
    ctx,
  );
  assert.equal(resumed.status, 302);
  assert.equal(resumed.headers.get("Location"), `https://github.com/${REPO}/releases/download/results/${job}.so`);
  const missing = await call("GET", "/v1/job/ffffffffffffffffffffffff/lib");
  assert.equal(missing.status, 404);
});

test("a job on its way is told after a hold, so every game asks less often; a failure at once", async () => {
  const { job } = await (await call("POST", "/v1/build?version=0.8.0", { body: mods })).json();
  env.HOLD_MS = 300;
  try {
    let started = Date.now();
    assert.equal((await (await call("GET", `/v1/job/${job}`)).json()).state, "queued");
    assert.ok(Date.now() - started >= 290, "held");
    const failed = { state: "failed", error: "error[E0425]", settled: true, at: Date.now() / 1000 + 60 };
    github.assets.results.set(`${job}.failed.json`, new TextEncoder().encode(JSON.stringify(failed)));
    cache.entries.clear();
    started = Date.now();
    assert.equal((await (await call("GET", `/v1/job/${job}`)).json()).state, "failed");
    assert.ok(Date.now() - started < 290, "not held");
  } finally {
    env.HOLD_MS = 0;
  }
});

test("a run seen on GitHub from another location is queued or building", async () => {
  const job = "0123456789abcdef01234567";
  github.runs = [{ display_title: `build ${job}`, status: "queued", created_at: "2026-11-15T20:00:00Z" }];
  assert.deepEqual(await (await call("GET", `/v1/job/${job}`)).json(), { state: "queued", ahead: 0 });
  cache.clock += 130;
  github.runs = [{ display_title: `build ${job}`, status: "in_progress", run_started_at: new Date().toISOString() }];
  assert.equal((await (await call("GET", `/v1/job/${job}`)).json()).state, "building");
});

test("a job in line is told its place, from one look at the line for everyone", async () => {
  const at = (minute) => `2026-11-15T20:${String(minute).padStart(2, "0")}:00Z`;
  const jobs = ["aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccc"];
  // Listed newest first, as GitHub does.
  github.runs = [
    { display_title: `build ${jobs[2]}`, status: "queued", created_at: at(3) },
    { display_title: `build ${jobs[1]}`, status: "queued", created_at: at(2) },
    { display_title: `build ${jobs[0]}`, status: "queued", created_at: at(1) },
  ];
  const before = github.calls;
  for (const [i, job] of jobs.entries()) {
    assert.deepEqual(await (await call("GET", `/v1/job/${job}`)).json(), { state: "queued", ahead: i });
  }
  assert.equal(github.calls - before, 2, "one look at the line (queued and building) for all three");
  // A job that moved from waiting to building after the line was read is found by a new look,
  // not called lost.
  const moved = "dddddddddddddddddddddddd";
  github.runs.push({ display_title: `build ${moved}`, status: "in_progress", run_started_at: new Date().toISOString() });
  assert.equal((await (await call("GET", `/v1/job/${moved}`)).json()).state, "building");
  // Just asked and not listed yet: at the end of the line, not lost.
  const { job } = await (await call("POST", "/v1/build?version=0.8.0", { body: mods })).json();
  assert.deepEqual(await (await call("GET", `/v1/job/${job}`)).json(), { state: "queued", ahead: 3 });
});

test("a failure is told; one that may pass builds again when asked", async () => {
  const job = await jobOf("0.8.0", COMMIT, mods);
  const failed = { state: "failed", error: "GitHub's machine went away.", settled: false, at: Date.now() / 1000 + 5 };
  github.assets.results.set(`${job}.failed.json`, new TextEncoder().encode(JSON.stringify(failed)));
  const told = await (await call("GET", `/v1/job/${job}`)).json();
  assert.deepEqual(told, { state: "failed", error: "GitHub's machine went away.", settled: false });
  await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.equal(github.dispatched.length, 1, "built again");
});

test("a failure for good is not built again", async () => {
  const job = await jobOf("0.8.0", COMMIT, mods);
  const failed = { state: "failed", error: "error[E0425]: cannot find value", settled: true, at: 1 };
  github.assets.results.set(`${job}.failed.json`, new TextEncoder().encode(JSON.stringify(failed)));
  const response = await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.deepEqual(await response.json(), { job });
  assert.equal(github.dispatched.length, 0);
});

test("an address has its builds a day", async () => {
  for (let i = 0; i < PER_ADDRESS; i++) {
    const body = new TextEncoder().encode(`mods ${i}`);
    assert.equal((await call("POST", "/v1/build?version=0.8.0", { body })).status, 200);
  }
  const over = await call("POST", "/v1/build?version=0.8.0", { body: new TextEncoder().encode("one more") });
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /tomorrow/);
  const other = await call("POST", "/v1/build?version=0.8.0", {
    body: new TextEncoder().encode("one more"),
    address: "198.51.100.2",
  });
  assert.equal(other.status, 200, "another address still builds");
});

test("what the service can't build is said in words the game shows", async () => {
  const old = await call("POST", "/v1/build?version=0.7.9", { body: mods });
  assert.equal(old.status, 400);
  assert.match((await old.json()).error, /Update Starling/);
  const wrong = await call("POST", "/v1/build?version=latest", { body: mods });
  assert.equal(wrong.status, 400);
  const empty = await call("POST", "/v1/build?version=0.8.0", { body: new Uint8Array() });
  assert.equal(empty.status, 413);
  const big = await call("POST", "/v1/build?version=0.8.0", { body: new Uint8Array(MAX_BODY + 1) });
  assert.equal(big.status, 413);
  assert.equal(github.dispatched.length, 0);
});

test("anything else is not here, and an unknown job is lost", async () => {
  assert.equal((await call("GET", "/v1/job/not-a-job")).status, 404);
  assert.equal((await call("GET", "/")).status, 404);
  assert.equal((await call("GET", "/v1/github/0123")).status, 404);
  assert.equal((await call("GET", "/v1/job/0123456789abcdef01234567")).status, 404);
});

test("GitHub's hourly limit spent: a job asked here keeps going, an unknown one is retried", async () => {
  const { job } = await (await call("POST", "/v1/build?version=0.8.0", { body: mods })).json();
  const limited = github.fetch.bind(github);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.host === "api.github.com") return new Response('{"message":"API rate limit exceeded"}', { status: 403 });
    return limited(input, init);
  };
  // Asked five minutes ago: past the "just asked" answer, so its place would be looked up.
  const asked = cache.entries.get(`https://starling-compile.cache/asked/${job}`);
  asked.body = JSON.stringify({ at: Date.now() / 1000 - 300 });
  const told = await (await call("GET", `/v1/job/${job}`)).json();
  assert.equal(told.state, "building", "asked here: still building, not an error");
  const unknown = await call("GET", "/v1/job/eeeeeeeeeeeeeeeeeeeeeeee");
  assert.equal(unknown.status, 503, "can't tell: the game tries again, not 'lost'");
});

test("a job whose run ended without an answer is told so, and asking again builds it again", async () => {
  const { job } = await (await call("POST", "/v1/build?version=0.8.0", { body: mods })).json();
  // Asked 15 minutes ago; its run is gone from the line and published nothing.
  const asked = cache.entries.get(`https://starling-compile.cache/asked/${job}`);
  asked.body = JSON.stringify({ at: Date.now() / 1000 - 900 });
  const told = await (await call("GET", `/v1/job/${job}`)).json();
  assert.deepEqual(told, { state: "failed", error: "The build on GitHub did not finish. Try again.", settled: false });
  await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.equal(github.dispatched.length, 2, "built again");
});

test("GitHub out of reach is a 503 with words", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("network down");
  };
  const response = await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /can't reach GitHub/);
});
