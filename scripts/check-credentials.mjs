#!/usr/bin/env bun
// What *is* the key I just pasted, and will the project accept it?
//
// Supabase's dashboard puts three different-looking secrets within a few pixels
// of each other, and two of them are not API keys at all:
//
//   service_role API key   an API key. Starts `eyJ` (legacy JWT) or `sb_secret_`.
//   anon / publishable key an API key, but the wrong one for writing.
//   JWT secret             NOT an API key. It signs tokens; nothing accepts it as
//                          a credential, and presenting it yields "Invalid API key".
//
// This script names the value and then proves it against the project, so a mistake
// costs a second rather than a failed CI run. It never prints the key itself: only
// its type, its role, which project it belongs to, and whether the project agrees.
//
//   bun scripts/check-credentials.mjs                    # reads the workspace env
//   printf '%s' "$KEY" | bun scripts/check-credentials.mjs --stdin
//
// Exit codes: 0 the key works for the census, 1 it does not, 2 configuration missing.

const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const fromEnv = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";

let key = fromEnv.trim();
if (process.argv.includes("--stdin")) {
  key = (await new Response(Bun.stdin.stream()).text()).trim();
}

if (!url || !key) {
  console.error(
    "Missing configuration.\n" +
      "  SUPABASE_URL               " +
      (url ? "ok" : "MISSING") +
      "\n  SUPABASE_SERVICE_ROLE_KEY  " +
      (key ? "ok" : "MISSING") +
      "\nSet them in Settings → Environment (or pipe a key with --stdin), then re-run.",
  );
  process.exit(2);
}

const projectRef = url.replace(/^https?:\/\//, "").split(".")[0];
console.log(`Project : ${url}  (ref ${projectRef})`);
console.log(`Key     : ${key.length} characters, starts "${key.slice(0, 12)}…"`);

function decodeJwt(value) {
  try {
    const [, payload] = value.split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/* ── 1. what is this value? ────────────────────────────────────────────────── */

let kind = "unknown";
let role = null;
let ref = null;

if (key.startsWith("eyJ")) {
  const claims = decodeJwt(key);
  if (!claims) {
    kind = "malformed-jwt";
  } else {
    role = claims.role ?? null;
    ref = claims.ref ?? null;
    kind = "legacy-jwt";
  }
} else if (key.startsWith("sb_secret_")) {
  kind = "new-secret";
  role = "service_role (by convention of the sb_secret_ prefix)";
} else if (key.startsWith("sb_publishable_")) {
  kind = "publishable";
  role = "anon";
} else {
  kind = "not-an-api-key";
}

console.log(`Type    : ${kind}${role ? ` · role ${role}` : ""}${ref ? ` · ref ${ref}` : ""}`);

if (kind === "not-an-api-key") {
  console.error(
    "\n✗ That is not an API key.\n" +
      "  A JWT secret, a database password, or a truncated copy all look like this —\n" +
      "  no dots, no `sb_` prefix. Nothing accepts it as a credential, which is exactly\n" +
      '  why the project answers "Invalid API key".\n\n' +
      "  Where to get the right one:\n" +
      "    Supabase → Project Settings → API keys\n" +
      "      · new format: Create a secret key  → sb_secret_…\n" +
      "      · legacy:      reveal `service_role` → eyJ… (its payload says role=service_role)",
  );
  process.exit(1);
}

if (kind === "publishable" || role === "anon") {
  console.error(
    "\n✗ This is the anon / publishable key. It is a valid credential but the wrong one:\n" +
      "  census_can_write() accepts only service_role or an admin session, so writes\n" +
      "  would be refused (a different error from the one you are seeing).",
  );
  process.exit(1);
}

if (kind === "malformed-jwt") {
  console.error(
    "\n✗ This looks like a JWT but its payload does not decode — almost certainly truncated.",
  );
  process.exit(1);
}

if (ref && ref !== projectRef) {
  console.error(
    `\n✗ This key belongs to project "${ref}" but SUPABASE_URL is "${projectRef}".\n` +
      "  A key from a project that was deleted and recreated fails exactly this way.",
  );
  process.exit(1);
}

/* ── 2. does the project actually accept it? ───────────────────────────────── */

const headers = { "Content-Type": "application/json", apikey: key };
if (!key.startsWith("sb_publishable_") && !key.startsWith("sb_secret_")) {
  headers.Authorization = `Bearer ${key}`;
}

// `census_cursor_state` needs both a valid key and the service role, so it is the
// single call that proves everything the crawler needs.
const res = await fetch(`${url}/rest/v1/rpc/census_cursor_state`, {
  method: "POST",
  headers,
  body: JSON.stringify({ _range_start: "2301429001", _range_end: "2301429999" }),
});
const body = (await res.text()).slice(0, 200);

if (res.ok) {
  console.log(`\n✓ Accepted (HTTP ${res.status}) — ${body}`);
  console.log(
    "  This key can write census data. Put it in the GitHub secret SUPABASE_SERVICE_ROLE_KEY.",
  );
  process.exit(0);
}

const invalid = /invalid api key/i.test(body);
console.log(`\n✗ Rejected (HTTP ${res.status}): ${body}`);
console.log(
  invalid
    ? "  The gateway does not recognise this key for this project — the value is wrong,\n" +
        "  not merely under-privileged."
    : "  The key is recognised but not allowed here — check that it is the service_role key.",
);
process.exit(1);
