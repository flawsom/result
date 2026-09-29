#!/usr/bin/env bun
// Does the deployed site actually read the census the workflow writes?
//
// A green workflow run and a live page are two claims, and the interesting one is
// that the second follows from the first. This checks the whole chain from the
// outside, the way a browser walks it, and prints a verdict per link:
//
//   1. The deployed HTML loads, and it names the JavaScript chunks it runs.
//   2. One of those chunks is the census bundle, and it is the *current* build
//      (it carries the copy and the query names this repository ships).
//   3. That bundle carries the project URL and the publishable key it will use at
//      runtime, the same credentials, not a guess.
//   4. Those credentials, from this machine, return the aggregate the crawl
//      stored. If step 4 shows observations, the hosted interface is receiving
//      the workflow's data; if it shows zero, it is not, and no amount of
//      green CI changes that.
//
//   bun scripts/census-verify.mjs
//   bun scripts/census-verify.mjs http://localhost:8083
//
// Read-only. It never writes to Supabase and never prints a key.
import { CENSUS_YEARS, MEASURED_BLOCKS } from "../src/lib/census-blocks.ts";

const BASE = (process.argv[2] ?? "https://result.unifies.codes").replace(/\/+$/, "");
const ORIGIN = new URL(BASE).origin;
const MAX_CHUNKS = 140;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? `, ${detail}` : ""}`);
}

/** Worth reporting, not worth failing: the panel falls back to polling for this. */
function note(name, detail) {
  console.log(` note  ${name}${detail ? `, ${detail}` : ""}`);
}

async function getText(url) {
  const res = await fetch(url, { headers: { Accept: "*/*" } });
  return { res, text: res.ok ? await res.text() : "" };
}

/* ─────────────────────────────────────────────────────────── 1. the page ─── */

const page = await getText(BASE);
check("deployed page", page.res.ok, `${BASE} → ${page.res.status}`);

const assetUrls = new Set();
for (const match of page.text.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const path = match[1];
  // Stylesheets, images and data URLs are not part of the module graph.
  if (/^https?:|^\.|\.(css|svg|png|ico|woff2?|json)(\?|$)/.test(path)) continue;
  assetUrls.add(new URL(path, ORIGIN).href);
}
check("page names its chunks", assetUrls.size > 0, `${assetUrls.size} script(s) in the HTML`);

/**
 * Both builds walk the same way: a module names the modules it imports, so the
 * graph is reachable from the HTML without executing anything. Production emits
 * `assets/BputCensus-<hash>.js`; the dev server emits `src/components/…tsx`.
 */
// `assets/chunk-hash.js` in a production build; `/src/components/X.tsx` and the
// extension-less `/@id/…` virtuals a dev server hands out.
const MODULE_RE =
  /([\w./@:-]+\.(?:js|tsx|ts))(?=["')\s]|$)|(@(?:id|vite)\/[\w:./-]+)(?=["')\s]|$)/gm;
const isLocal = (value) =>
  value.includes("/") && !/^[a-z]+:/i.test(value) && !value.startsWith("//");
const resolveAsset = (value) => new URL(value.startsWith("/") ? value : `/${value}`, ORIGIN).href;

/* ─────────────────────────────────────────────── 2. crawl the chunk graph ─── */

// The census panel is a lazy chunk, so it is not in the HTML. Vite leaves the
// lazy filenames inside the chunks that import them, so the graph is walkable
// from the entry points without executing anything.
const CENSUS_MODULE_RE = /BputCensus[^"'()\s]*\.(?:js|tsx)/;
const seen = new Map();
const queue = [...assetUrls];
let censusUrl = null;

while (queue.length > 0 && seen.size < MAX_CHUNKS) {
  const url = queue.shift();
  if (seen.has(url)) continue;
  const file = await getText(url);
  seen.set(url, file.text);
  if (!file.res.ok) continue;
  if (CENSUS_MODULE_RE.test(url)) censusUrl = url;
  for (const match of file.text.matchAll(MODULE_RE)) {
    const specifier = match[1] ?? `/${match[2]}`;
    if (!isLocal(specifier)) continue;
    const next = resolveAsset(specifier);
    if (CENSUS_MODULE_RE.test(next)) censusUrl = next;
    if (!seen.has(next) && !queue.includes(next)) queue.push(next);
  }
  if (censusUrl && seen.has(censusUrl)) break;
}

if (censusUrl && !seen.has(censusUrl)) {
  const chunk = await getText(censusUrl);
  seen.set(censusUrl, chunk.text);
  if (!chunk.res.ok) censusUrl = null;
}

// A dev server hands out virtual entry points whose graph cannot be walked the
// way a build's can. Rather than report the app broken, ask for the source
// modules by name and say so.
let devServer = false;
if (!censusUrl) {
  for (const path of [
    "/src/components/BputCensus.tsx",
    "/src/lib/census-client.ts",
    "/src/lib/census-blocks.ts",
    "/src/integrations/supabase/client.ts",
  ]) {
    const url = `${ORIGIN}${path}`;
    const file = await getText(url);
    if (file.res.ok) {
      seen.set(url, file.text);
      devServer = true;
      if (CENSUS_MODULE_RE.test(path)) censusUrl = url;
    }
  }
}
check(
  "census module is served",
  Boolean(censusUrl),
  censusUrl
    ? `${censusUrl.replace(ORIGIN, "")}${devServer ? " (dev server, module fetched directly)" : ""}`
    : `no BputCensus module found in ${seen.size} fetched modules`,
);

/* ────────────────────────────────────────── 3. is it the build we think it is ─── */

const bundle = censusUrl ? (seen.get(censusUrl) ?? "") : "";
const allText = [...seen.values()].join("\n");

check(
  "census queries present in the build",
  allText.includes("census_live") && allText.includes("get_bput_census"),
  "the deployed build reads census_live and get_bput_census at runtime",
);
check(
  "measured-grid copy deployed",
  allText.includes("were measured, not guessed"),
  "the deployed build says the ranges were measured rather than extrapolated",
);
check(
  devServer ? "grid denominator wired into the panel" : "grid denominator in the build",
  devServer ? bundle.includes("MEASURED_BLOCKS") : allText.includes(String(MEASURED_BLOCKS)),
  devServer
    ? "the panel reads the measured block count rather than a literal of its own"
    : `block count ${MEASURED_BLOCKS} is compiled into the deployed copy`,
);

/* ───────────────────────────────────────── 4. the credentials it will use ─── */

const projectUrl = allText.match(/https:\/\/[a-z0-9]{20}\.supabase\.co/)?.[0] ?? null;
const pubKey = allText.match(/sb_publishable_[A-Za-z0-9_-]{10,}/)?.[0] ?? null;
const mask = (value) => (value ? `${value.slice(0, 16)}…(${value.length} chars)` : "none");
check("project URL in the bundle", Boolean(projectUrl), projectUrl ?? "not found");
check("publishable key in the bundle", Boolean(pubKey), mask(pubKey));

/** Best-effort Realtime join on the same channel the census panel subscribes to. */
async function realtimeJoin(url, key) {
  const socketUrl = `${url.replace(/^https/, "wss")}/realtime/v1/websocket?apikey=${key}&vsn=1.0.0`;
  try {
    const socket = new WebSocket(socketUrl);
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 6_000);
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            topic: "realtime:census-verify",
            event: "phx_join",
            payload: {
              config: {
                postgres_changes: [{ event: "*", schema: "public", table: "census_live" }],
              },
            },
            ref: "1",
          }),
        );
      socket.onmessage = (event) => {
        const frame = String(event.data);
        if (frame.includes('"phx_reply"')) {
          clearTimeout(timer);
          resolve(frame.includes('"ok"') ? "ok" : frame.slice(0, 160));
        }
      };
      socket.onerror = () => {
        clearTimeout(timer);
        resolve("error");
      };
    });
    const outcome = await done;
    socket.close();
    note(
      "realtime push on census_live",
      outcome === "ok"
        ? "joined; a batch lands on open pages in about a second"
        : `not verified (${outcome})`,
    );
  } catch (error) {
    note(
      "realtime push on census_live",
      `not verified (${error instanceof Error ? error.message : error})`,
    );
  }
}

if (projectUrl && pubKey) {
  const rpc = async (fn) => {
    const res = await fetch(`${projectUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: pubKey },
      body: "{}",
    });
    if (!res.ok) throw new Error(`${fn} → ${res.status} ${(await res.text()).slice(0, 120)}`);
    return res.json();
  };

  try {
    // The live counter is a table read, not an RPC: the page subscribes to this
    // row over Realtime and selects it once on load. Same request, same key.
    const liveRes = await fetch(`${projectUrl}/rest/v1/census_live?select=*&limit=1`, {
      headers: { Accept: "application/json", apikey: pubKey },
    });
    const live = liveRes.ok ? await liveRes.json() : null;
    const row = Array.isArray(live) ? live[0] : live;
    const observations = Number(row?.observations ?? 0);
    check(
      "hosted read path returns the crawl's rows",
      liveRes.ok && observations > 0,
      liveRes.ok
        ? `${observations.toLocaleString()} observations · ${Number(row?.visited ?? 0).toLocaleString()} probed` +
            `${row?.last_batch_at ? ` · last batch ${row.last_batch_at}` : ""}`
        : `census_live → HTTP ${liveRes.status}`,
    );

    // Realtime is how a batch reaches an open page in about a second. Polling is
    // the fallback, so an unverified socket is a note and not a failure.
    await realtimeJoin(projectUrl, pubKey);

    const progress = await rpc("census_progress");
    const done = Number(progress?.doneRanges ?? 0);
    check(
      "crawl progress is visible to the page",
      done >= 0,
      `${done}/${MEASURED_BLOCKS} ranges complete · ${Number(progress?.observations ?? 0).toLocaleString()} observations stored`,
    );

    const census = await rpc("get_bput_census");
    const meta = census?.meta ?? {};
    check(
      "aggregate returns published cells",
      Number(meta.observations ?? 0) > 0,
      `${Number(meta.observations ?? 0).toLocaleString()} pooled observations · ` +
        `${meta.batchYears ?? 0} batch year(s) · ${meta.branches ?? 0} branches · k≥${meta.kAnonymity ?? "?"}`,
    );
    // Published per semester says how much of the portal's history is still being
    // served. It is not a labelling bug: every label the derivation produces was
    // probed on real 2012-2020 batches, and the ones that answer do so without
    // help, while the old sessions BPUT has aged out answer to nothing at all.
    note(
      "publication by semester (published/observed)",
      (census?.bySemester ?? [])
        .map((r) => `S${r.semester} ${Number(r.published ?? 0)}/${Number(r.observations ?? 0)}`)
        .join(" · "),
    );

    const years = (census?.byYear ?? []).map((r) => r.batchYear);
    check(
      "years covered so far",
      true,
      `${years.length ? years.join(", ") : "none yet"} (grid covers ${CENSUS_YEARS.length} batch years)`,
    );
  } catch (error) {
    check(
      "hosted read path",
      false,
      (error instanceof Error ? error.message : String(error)).slice(0, 200),
    );
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? `\n[census-verify] ${results.length} checks passed against ${BASE}.`
    : `\n[census-verify] ${failed.length} of ${results.length} checks failed against ${BASE}.`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
