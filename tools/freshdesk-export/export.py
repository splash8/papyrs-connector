#!/usr/bin/env python3
"""Export every Freshdesk ticket's full conversation (description, replies,
public and private notes) to one CSV file, skipping tickets in chosen groups.

Usage (Windows PowerShell):
    $env:FRESHDESK_DOMAIN = "yourcompany.freshdesk.com"
    $env:FRESHDESK_API_KEY = "xxxx"
    python export.py --exclude-groups "Sales,Billing" --out tickets.csv

Usage (Mac/Linux):
    FRESHDESK_DOMAIN=yourcompany.freshdesk.com FRESHDESK_API_KEY=xxxx \
        python3 export.py --exclude-groups "Sales,Billing" --out tickets.csv

No extra packages needed; Python 3.8+.
"""

import argparse
import base64
import csv
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

p = argparse.ArgumentParser(description="Export Freshdesk ticket conversations to CSV.")
p.add_argument("--exclude-groups", default="", help='Group names or IDs to skip, e.g. "Sales,HR,123"')
p.add_argument("--exclude-ungrouped", action="store_true", help="Also skip tickets that have no group")
p.add_argument("--since", default="2000-01-01", help="Only tickets created on/after this date (default: all)")
p.add_argument("--until", help="Only tickets created on/before this date")
p.add_argument("--out", default="freshdesk-conversations.csv", help="Output path")
p.add_argument("--resume", action="store_true",
               help="Continue an interrupted export: keep the tickets already in --out and add the rest")
p.add_argument("--list-groups", action="store_true", help="Print the groups with their IDs and exit")
args = p.parse_args()

domain = re.sub(r"^https?://", "", os.environ.get("FRESHDESK_DOMAIN", "")).rstrip("/")
api_key = os.environ.get("FRESHDESK_API_KEY")
if not domain or not api_key:
    sys.exit("Set FRESHDESK_DOMAIN and FRESHDESK_API_KEY (see --help).")
BASE = ("http://" if domain.startswith("localhost") else "https://") + domain
AUTH = "Basic " + base64.b64encode(f"{api_key}:X".encode()).decode()


class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


def api(path):
    """GET with retry on rate limits (429) and transient server errors."""
    attempt = 0
    while True:
        attempt += 1
        req = urllib.request.Request(BASE + path, headers={"Authorization": AUTH, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.load(res), res.headers.get("Link") or ""
        except urllib.error.HTTPError as e:
            if e.code == 429 or (e.code >= 500 and attempt < 5):
                wait = int(e.headers.get("Retry-After") or 30)
                print(f"  {e.code} on {path}, waiting {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            raise ApiError(e.code, f"GET {path} -> {e.code}: {e.read().decode(errors='replace')}")
        except (OSError, http.client.HTTPException, ValueError) as e:
            # Dropped connections, timeouts, truncated responses (e.g. after
            # the PC slept or the VPN reconnected during a long rate-limit wait).
            if attempt < 10:
                print(f"  network error ({e}), retrying...", file=sys.stderr)
                time.sleep(min(60, 5 * attempt))
                continue
            raise


def get_all(path):
    """Follows the Link: rel="next" header until the last page."""
    out = []
    nxt = path + ("&" if "?" in path else "?") + "per_page=100"
    while nxt:
        data, link = api(nxt)
        out.extend(data)
        m = re.search(r'<([^>]+)>;\s*rel="next"', link)
        if m:
            u = urllib.parse.urlparse(m.group(1))
            nxt = u.path + ("?" + u.query if u.query else "")
        else:
            nxt = None
    return out


STATUS = {2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed"}
PRIORITY = {1: "Low", 2: "Medium", 3: "High", 4: "Urgent"}


def entry_type(c):
    if c.get("source") == 2:
        return "private_note" if c.get("private") else "public_note"
    if c.get("source") == 8:
        return "forward"
    return "customer_reply" if c.get("incoming") else "agent_reply"


def cell(v):
    if v is None:
        return ""
    if isinstance(v, list):
        return "; ".join(str(x) for x in v)
    return v


COLUMNS = [
    "ticket_id", "subject", "status", "priority", "group_id", "group_name", "ticket_created_at",
    "ticket_updated_at", "requester_email", "requester_name", "entry_type", "entry_id",
    "entry_created_at", "author_id", "author_name", "from_email", "to_emails", "cc_emails",
    "body_text", "attachments",
]


def parse_date(s, end_of_day=False):
    if len(s) <= 10:
        s += "T23:59:59" if end_of_day else "T00:00:00"
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# --- groups -------------------------------------------------------------
groups = get_all("/api/v2/groups")
group_name = {g["id"]: g["name"] for g in groups}

if args.list_groups:
    for g in groups:
        print(f"{g['id']}\t{g['name']}")
    sys.exit(0)

excluded = set()
for raw in [s.strip() for s in args.exclude_groups.split(",") if s.strip()]:
    match = next((g for g in groups if str(g["id"]) == raw or g["name"].lower() == raw.lower()), None)
    if not match:
        sys.exit(f'Unknown group "{raw}". Run with --list-groups to see the names.')
    excluded.add(match["id"])
print("Excluding groups: " + (", ".join(group_name[i] for i in excluded) or "(none)"), file=sys.stderr)

# --- agents (to name note/reply authors) --------------------------------
people = {}
try:
    for a in get_all("/api/v2/agents"):
        c = a.get("contact") or {}
        people[a["id"]] = c.get("name") or c.get("email") or ""
except ApiError as e:
    print(f"Could not list agents ({e.status}); author names for agents will be blank.", file=sys.stderr)


# --- tickets ------------------------------------------------------------
# The list endpoint only goes back 30 days unless updated_since is given, and
# stops at a page limit; so walk by updated_at ascending and restart the
# window from the last seen timestamp whenever a page limit is hit.
def tickets(seen, since):
    while True:
        page, last, fresh = 1, None, 0
        while True:
            q = ("/api/v2/tickets?updated_since=" + urllib.parse.quote(since) +
                 "&order_by=updated_at&order_type=asc&include=description,requester"
                 f"&per_page=100&page={page}")
            try:
                data, _ = api(q)
            except ApiError as e:
                if e.status == 400 and last:
                    break  # page limit reached; restart from `last`
                raise
            for t in data:
                last = t["updated_at"]
                if t["id"] in seen:
                    continue
                seen.add(t["id"])
                fresh += 1
                yield t
            if len(data) < 100:
                return
            page += 1
        if not fresh or last == since:
            return
        since = last


# A ticket created after --since was also updated after it, so the
# updated_since walk above sees every such ticket; filter on created_at here.
since_dt = parse_date(args.since)
until = parse_date(args.until, end_of_day=True) if args.until else None
exported = skipped = rows = 0
done = set()
walk_from = since_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

if os.path.exists(args.out) and os.path.getsize(args.out) > 0:
    if not args.resume:
        sys.exit(f"{args.out} already exists. Add --resume to continue that export, "
                 "or delete/rename the file to start over.")
    with open(args.out, newline="", encoding="utf-8-sig") as f:
        kept = list(csv.DictReader(f))
    if kept:
        # Tickets are written in updated_at order, so continue the walk from the
        # last one. It may have been cut off mid-thread, so drop it and redo it.
        last_id = kept[-1]["ticket_id"]
        walk_from = max(walk_from, max(r["ticket_updated_at"] for r in kept))
        kept = [r for r in kept if r["ticket_id"] != last_id]
        done = {int(r["ticket_id"]) for r in kept}
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(kept)
    exported, rows = len(done), len(kept)
    print(f"Resuming: {exported} tickets ({rows} rows) already in {args.out}", file=sys.stderr)
    mode = "a"
else:
    mode = "w"

# utf-8-sig writes a BOM so Excel reads accents correctly
with open(args.out, mode, newline="", encoding="utf-8" if mode == "a" else "utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=COLUMNS)
    if mode == "w":
        w.writeheader()

    def write(row):
        w.writerow({k: cell(row.get(k)) for k in COLUMNS})

    for t in tickets(set(done), walk_from):
        gid = t.get("group_id")
        if gid in excluded or (args.exclude_ungrouped and not gid) or \
                parse_date(t["created_at"]) < since_dt or (until and parse_date(t["created_at"]) > until):
            skipped += 1
            continue
        req = t.get("requester") or {}
        base = {
            "ticket_id": t["id"],
            "subject": t.get("subject"),
            "status": STATUS.get(t.get("status"), t.get("status")),
            "priority": PRIORITY.get(t.get("priority"), t.get("priority")),
            "group_id": gid,
            "group_name": group_name.get(gid, ""),
            "ticket_created_at": t.get("created_at"),
            "ticket_updated_at": t.get("updated_at"),
            "requester_email": req.get("email"),
            "requester_name": req.get("name"),
        }
        if t.get("requester_id") and req.get("name"):
            people[t["requester_id"]] = req["name"]

        write({
            **base,
            "entry_type": "description",
            "entry_created_at": t.get("created_at"),
            "author_id": t.get("requester_id"),
            "author_name": req.get("name"),
            "from_email": req.get("email"),
            "to_emails": t.get("to_emails"),
            "cc_emails": t.get("cc_emails"),
            "body_text": t.get("description_text"),
            "attachments": [a.get("name") for a in t.get("attachments") or []],
        })
        rows += 1

        for c in get_all(f"/api/v2/tickets/{t['id']}/conversations"):
            write({
                **base,
                "entry_type": entry_type(c),
                "entry_id": c.get("id"),
                "entry_created_at": c.get("created_at"),
                "author_id": c.get("user_id"),
                "author_name": people.get(c.get("user_id"), ""),
                "from_email": c.get("from_email"),
                "to_emails": c.get("to_emails"),
                "cc_emails": c.get("cc_emails"),
                "body_text": c.get("body_text"),
                "attachments": [a.get("name") for a in c.get("attachments") or []],
            })
            rows += 1

        f.flush()  # keep the file complete up to this ticket if the run is interrupted
        exported += 1
        if exported % 50 == 0:
            print(f"  {exported} tickets, {rows} rows...", file=sys.stderr)

print(f"Done: {exported} tickets exported ({rows} rows), {skipped} skipped -> {args.out}", file=sys.stderr)
