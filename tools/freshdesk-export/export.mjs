#!/usr/bin/env node
// Export every Freshdesk ticket's full conversation (description, replies,
// public and private notes) to one CSV file, skipping tickets in chosen groups.
//
// Usage:
//   FRESHDESK_DOMAIN=yourcompany.freshdesk.com FRESHDESK_API_KEY=xxxx \
//     node export.mjs --exclude-groups "Sales,Billing" --out tickets.csv
//
// No dependencies; needs Node 20+.

import { createWriteStream } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "exclude-groups": { type: "string", default: "" },
    "exclude-ungrouped": { type: "boolean", default: false },
    since: { type: "string", default: "2000-01-01" },
    until: { type: "string" },
    out: { type: "string", default: "freshdesk-conversations.csv" },
    "list-groups": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  console.log(`Options:
  --exclude-groups "A,B,123"  Group names or IDs to skip (case-insensitive names)
  --exclude-ungrouped         Also skip tickets that have no group
  --since 2024-01-01          Only tickets created on/after this date (default: all)
  --until 2024-12-31          Only tickets created on/before this date
  --out file.csv              Output path (default: freshdesk-conversations.csv)
  --list-groups               Print the groups with their IDs and exit
Env: FRESHDESK_DOMAIN (e.g. acme.freshdesk.com), FRESHDESK_API_KEY`);
  process.exit(0);
}

const domain = (process.env.FRESHDESK_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const apiKey = process.env.FRESHDESK_API_KEY;
if (!domain || !apiKey) {
  console.error("Set FRESHDESK_DOMAIN and FRESHDESK_API_KEY (see --help).");
  process.exit(1);
}
const BASE = domain.startsWith("localhost") ? `http://${domain}` : `https://${domain}`;
const AUTH = "Basic " + Buffer.from(`${apiKey}:X`).toString("base64");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET with retry on rate limits (429) and transient server errors.
async function api(path) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(BASE + path, { headers: { Authorization: AUTH, "Content-Type": "application/json" } });
    if (res.ok) return { data: await res.json(), link: res.headers.get("link") || "" };
    if (res.status === 429 || (res.status >= 500 && attempt < 5)) {
      const wait = Number(res.headers.get("retry-after") || 30) * 1000;
      console.error(`  ${res.status} on ${path}, waiting ${wait / 1000}s…`);
      await sleep(wait);
      continue;
    }
    const err = new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
}

// Follows the Link: rel="next" header until the last page.
async function getAll(path) {
  const out = [];
  let next = path + (path.includes("?") ? "&" : "?") + "per_page=100";
  while (next) {
    const { data, link } = await api(next);
    out.push(...data);
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    next = m ? new URL(m[1]).pathname + new URL(m[1]).search : null;
  }
  return out;
}

const STATUS = { 2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed" };
const PRIORITY = { 1: "Low", 2: "Medium", 3: "High", 4: "Urgent" };

function entryType(c) {
  if (c.source === 2) return c.private ? "private_note" : "public_note";
  if (c.source === 8) return "forward";
  return c.incoming ? "customer_reply" : "agent_reply";
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join("; ") : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUMNS = [
  "ticket_id", "subject", "status", "priority", "group_id", "group_name", "ticket_created_at",
  "ticket_updated_at", "requester_email", "requester_name", "entry_type", "entry_id",
  "entry_created_at", "author_id", "author_name", "from_email", "to_emails", "cc_emails",
  "body_text", "attachments",
];

// --- groups -------------------------------------------------------------
const groups = await getAll("/api/v2/groups");
const groupName = new Map(groups.map((g) => [g.id, g.name]));

if (args["list-groups"]) {
  for (const g of groups) console.log(`${g.id}\t${g.name}`);
  process.exit(0);
}

const excluded = new Set();
for (const raw of args["exclude-groups"].split(",").map((s) => s.trim()).filter(Boolean)) {
  const match = groups.find((g) => String(g.id) === raw || g.name.toLowerCase() === raw.toLowerCase());
  if (!match) {
    console.error(`Unknown group "${raw}". Run with --list-groups to see the names.`);
    process.exit(1);
  }
  excluded.add(match.id);
}
console.error(`Excluding groups: ${[...excluded].map((id) => groupName.get(id)).join(", ") || "(none)"}`);

// --- agents (to name note/reply authors) --------------------------------
const people = new Map();
try {
  for (const a of await getAll("/api/v2/agents")) people.set(a.id, a.contact?.name || a.contact?.email || "");
} catch (e) {
  console.error(`Could not list agents (${e.status}); author names for agents will be blank.`);
}

// --- tickets ------------------------------------------------------------
// The list endpoint only goes back 30 days unless updated_since is given, and
// stops at a page limit; so walk by updated_at ascending and restart the
// window from the last seen timestamp whenever a page limit is hit.
async function* tickets() {
  const seen = new Set();
  let since = new Date(args.since).toISOString();
  for (;;) {
    let page = 1, last = null, fresh = 0;
    for (;;) {
      const q = `/api/v2/tickets?updated_since=${encodeURIComponent(since)}&order_by=updated_at&order_type=asc` +
        `&include=description,requester&per_page=100&page=${page}`;
      let data;
      try {
        ({ data } = await api(q));
      } catch (e) {
        if (e.status === 400 && last) break; // page limit reached; restart from `last`
        throw e;
      }
      for (const t of data) {
        last = t.updated_at;
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        fresh++;
        yield t;
      }
      if (data.length < 100) return;
      page++;
    }
    if (!fresh || last === since) return;
    since = last;
  }
}

const out = createWriteStream(args.out);
out.write("﻿" + COLUMNS.join(",") + "\r\n"); // BOM so Excel reads UTF-8
const write = (row) => out.write(COLUMNS.map((c) => csvCell(row[c])).join(",") + "\r\n");

// A ticket created after --since was also updated after it, so the
// updated_since walk above sees every such ticket; filter on created_at here.
const sinceDate = new Date(args.since);
const until = args.until ? new Date(args.until + (args.until.length <= 10 ? "T23:59:59Z" : "")) : null;
let exported = 0, skipped = 0, rows = 0;

for await (const t of tickets()) {
  if (excluded.has(t.group_id) || (args["exclude-ungrouped"] && !t.group_id) ||
      new Date(t.created_at) < sinceDate || (until && new Date(t.created_at) > until)) {
    skipped++;
    continue;
  }
  const base = {
    ticket_id: t.id,
    subject: t.subject,
    status: STATUS[t.status] || t.status,
    priority: PRIORITY[t.priority] || t.priority,
    group_id: t.group_id,
    group_name: groupName.get(t.group_id) || "",
    ticket_created_at: t.created_at,
    ticket_updated_at: t.updated_at,
    requester_email: t.requester?.email,
    requester_name: t.requester?.name,
  };
  if (t.requester_id && t.requester?.name) people.set(t.requester_id, t.requester.name);

  write({
    ...base,
    entry_type: "description",
    entry_id: "",
    entry_created_at: t.created_at,
    author_id: t.requester_id,
    author_name: t.requester?.name,
    from_email: t.requester?.email,
    to_emails: t.to_emails,
    cc_emails: t.cc_emails,
    body_text: t.description_text,
    attachments: (t.attachments || []).map((a) => a.name),
  });
  rows++;

  for (const c of await getAll(`/api/v2/tickets/${t.id}/conversations`)) {
    write({
      ...base,
      entry_type: entryType(c),
      entry_id: c.id,
      entry_created_at: c.created_at,
      author_id: c.user_id,
      author_name: people.get(c.user_id) || "",
      from_email: c.from_email,
      to_emails: c.to_emails,
      cc_emails: c.cc_emails,
      body_text: c.body_text,
      attachments: (c.attachments || []).map((a) => a.name),
    });
    rows++;
  }
  if (++exported % 50 === 0) console.error(`  ${exported} tickets, ${rows} rows…`);
}

await new Promise((r) => out.end(r));
console.error(`Done: ${exported} tickets exported (${rows} rows), ${skipped} skipped → ${args.out}`);
