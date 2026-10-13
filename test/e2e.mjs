// End-to-end test: full OAuth sign-in as two different people, then MCP tool calls.
import crypto from "node:crypto";
import assert from "node:assert/strict";

const BASE = "http://localhost:8787";
const REDIRECT = "http://localhost:3118/callback";
const b64url = (b) => Buffer.from(b).toString("base64url");

async function connect(email, token, { badTokenFirst = false } = {}) {
  const reg = await (await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  })).json();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "papyrs", resource: `${BASE}/mcp` });
  const g = await fetch(`${BASE}/authorize?${q}`, { redirect: "manual" });
  const htmlPage = await g.text();
  assert.equal(g.status, 200, htmlPage);
  const cookie = g.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const handle = htmlPage.match(/name="handle" value="([^"]+)"/)[1];
  const post = (tok) =>
    fetch(`${BASE}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, cn: "Claude", rh: "localhost", email, token: tok, decision: "approve" }),
    });
  if (badTokenFirst) {
    const bad = await post("wrong-token");
    const t = await bad.text();
    assert.equal(bad.status, 400);
    assert.match(t, /did not accept this token/);
    console.log("  bad token -> form shown again with error ✓");
  }
  const p = await post(token);
  assert.equal(p.status, 302, await p.text());
  const code = new URL(p.headers.get("location")).searchParams.get("code");
  const tok = await (await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }),
  })).json();
  assert.ok(tok.access_token, JSON.stringify(tok));
  return tok.access_token;
}

let rpcId = 1;
async function mcp(at, method, params = {}) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const t = await r.text();
  assert.equal(r.status, 200, t);
  const j = JSON.parse(t);
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
const call = async (at, name, args) => {
  const r = await mcp(at, "tools/call", { name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
};

// Unauthenticated call must be refused
const un = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
assert.equal(un.status, 401);
console.log("no token -> 401 ✓");

console.log("Connecting Alice (with a wrong token first)...");
const alice = await connect("alice@ch-aviation.com", "tok-alice", { badTokenFirst: true });
console.log("Connecting Bob...");
const bob = await connect("BOB@ch-aviation.com", "tok-bob");

const init = await mcp(alice, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
console.log("server:", init.serverInfo.name);
const tools = (await mcp(alice, "tools/list")).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));

// Permission isolation
let r = await call(alice, "papyrs_search", { query: "salary" });
assert.match(r.text, /Zagreb Salaries/);
r = await call(bob, "papyrs_search", { query: "salary" });
assert.doesNotMatch(r.text, /Zagreb Salaries/);
console.log("search: Alice sees the salary page, Bob does not ✓");

r = await call(bob, "papyrs_read_page", { page: "P2" });
assert.ok(r.isError && /no access/.test(r.text));
r = await call(alice, "papyrs_read_page", { page: "https://ch-aviation.papyrs.com/Zagreb-Salaries" });
assert.match(r.text, /SECRET salary table/);
console.log("read by URL: Alice ✓, Bob refused ✓");

r = await call(bob, "papyrs_list_pages", {});
assert.doesNotMatch(r.text, /Salaries/);
console.log("list pages: Bob only sees his pages ✓");

r = await call(alice, "papyrs_page_access", { page: "P2" });
console.log(r.text);
assert.match(r.text, /Bob Belgrade: no access/);
r = await call(alice, "papyrs_page_access", { page: "P1", subgroup: "Belgrade" });
assert.doesNotMatch(r.text, /Alice/);
console.log("page access by subgroup ✓");

// Writes are drafts flagged for review
r = await call(alice, "papyrs_draft_new_page", { title: "Remote work policy", content_markdown: "# Scope\n\nApplies to **all** staff.\n\n- Zagreb\n- Belgrade", intended_folder: "HR/Policies" });
console.log(r.text);
r = await call(bob, "papyrs_search", { query: "Remote work" });
assert.match(r.text, /No results/);
console.log("draft page is private to Alice ✓");

r = await call(bob, "papyrs_propose_change", { page: "P1", change_type: "add_text", content: "Bob's edit" });
assert.match(r.text, /not edit/);
console.log("Bob (view-only) cannot propose an edit to the handbook ✓");

r = await call(alice, "papyrs_propose_change", { page: "Company-Handbook", change_type: "add_text", content: "Sick leave: report by **9:00**.", reason: "new rule" });
console.log(r.text);
const rid = r.text.match(/Review draft (\w+)/)[1];
r = await call(alice, "papyrs_read_page", { page: "P1" });
assert.doesNotMatch(r.text, /Sick leave/);
console.log("live page unchanged before approval ✓");

r = await call(alice, "papyrs_list_pending_reviews", {});
assert.match(r.text, new RegExp(rid));
r = await call(bob, "papyrs_apply_reviewed_change", { review_id: rid, approval_statement: "yes" });
assert.match(r.text, /neither the author nor a reviewer/);
console.log("Bob cannot apply Alice's change ✓");

r = await call(alice, "papyrs_apply_reviewed_change", { review_id: rid, approval_statement: "Looks good, apply review " + rid });
console.log(r.text);
r = await call(alice, "papyrs_read_page", { page: "P1" });
assert.match(r.text, /Sick leave: report by 9:00/);
r = await call(alice, "papyrs_apply_reviewed_change", { review_id: rid, approval_statement: "again" });
assert.match(r.text, /No pending review/);
console.log("applied once after approval, cannot be applied twice ✓");

console.log("Connecting Carol (Limited User, no People Directory access)...");
const carol = await connect("carol@example.com", "tok-carol");
const carolTools = (await mcp(carol, "tools/list")).tools.map((t) => t.name);
assert.ok(carolTools.includes("papyrs_read_page"));
assert.ok(!carolTools.includes("papyrs_draft_new_page") && !carolTools.includes("papyrs_propose_change"));
r = await call(carol, "papyrs_read_page", { page: "P1" });
assert.match(r.text, /Company Handbook/);
r = await call(carol, "papyrs_read_page", { page: "P2" });
assert.ok(r.isError);
console.log("Limited User connects read-only and still only sees her own pages ✓");

console.log("\nALL TESTS PASSED");
