# ch-aviation Papyrs connector for Claude

A custom Claude connector (remote MCP server) for `ch-aviation.papyrs.com`. It runs free on Cloudflare Workers.

## How permissions work

Each person connects with **their own Papyrs API token**. Every search, read and write runs as that person, so Papyrs enforces its own permissions, including subgroup restrictions. If someone can't see a page in Papyrs, Claude can't see it for them either. There is no admin token anywhere in the system.

The tokens are stored encrypted inside each person's OAuth grant. Only a valid Claude session for that person can unlock their token.

## How writing works (always flagged for review)

Claude never changes a live page directly.

| Tool | What it does |
|---|---|
| `papyrs_draft_new_page` | Creates a new page `[DRAFT] …` in the folder `Claude drafts/…`, with a "⚠ NEEDS REVIEW" banner. Only the author (and reviewers, if configured) can see it. A person publishes it in Papyrs by setting permissions and moving the folder. |
| `papyrs_propose_change` | For an existing page: adds text, adds a heading, or posts a comment. Creates a private `[REVIEW <id>]` page with the proposal. The live page stays unchanged. |
| `papyrs_apply_reviewed_change` | Applies a proposal only after the author or a reviewer approves it in chat. Their approval words are written onto the review page as an audit note. Each proposal can be applied once and expires after 30 days. |
| `papyrs_list_pending_reviews`, `papyrs_discard_change` | List or cancel proposals. |

Optional: set `REVIEWER_IDS` to one or more Papyrs user IDs, for example someone from comms. Those people then get edit access to every Claude draft, receive a Papyrs notification, and can apply or discard proposals themselves. Find user IDs with the `papyrs_find_people` tool.

Read tools: `papyrs_search`, `papyrs_list_pages`, `papyrs_read_page`, `papyrs_form_records`, `papyrs_find_people`, `papyrs_page_access` (who has edit, view or no access on a page, grouped by subgroup).

## Before you start

1. **Papyrs API access.** In Papyrs go to *Site Settings → Integrations & SSO → API* and request API access. Papyrs enables it per site.
2. **Rate limit.** By default Papyrs allows **6 API requests per 60 seconds**. The docs don't say whether this limit applies per token or to the whole site. If it applies to the whole site, 80 people will hit it constantly. Ask Papyrs support to confirm and to raise the limit for your site. The connector waits and retries once when Papyrs returns 429.
3. **Tokens for 80 people.** A Papyrs administrator generates a personal token for each person (*Site Settings → Integrations & SSO → Generate Token*) and sends it to that person privately. People must not share tokens. Revoking a token in Papyrs immediately cuts that person's Claude access.
4. **People Directory.** Signing in looks up the person's Papyrs user ID by email in the People Directory. Limited Users can't open it, so they connect **read-only**: they can search and read what Papyrs lets them see, but can't draft or propose changes (without their user ID a draft can't be made private to them).

## Deploy (about 15 minutes, free plan)

Requires Node 20+ and a free Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler deploy                            # prints https://papyrs-connector.<subdomain>.workers.dev
```

The `OAUTH_KV` and `REVIEW_KV` namespaces have no `id` in `wrangler.jsonc`, so the first deploy creates them automatically (this also works with Cloudflare Workers Builds from GitHub).

Then set `PUBLIC_URL` in `wrangler.jsonc` to the printed URL and run `npx wrangler deploy` again.

Settings in `wrangler.jsonc` → `vars`:

| Variable | Meaning |
|---|---|
| `PUBLIC_URL` | The Worker's public URL (no trailing slash) |
| `PAPYRS_BASE_URL` | `https://ch-aviation.papyrs.com` |
| `PAPYRS_SUBSITE` | The subsite name from your Papyrs page addresses (the word after `papyrs.com/`). Without it, Papyrs answers "Please specify a target subsite" |
| `PAPYRS_SUBSITES` | Optional. Every subsite Claude may look in, as `slug=Label` pairs, e.g. `home=Intranet Home,sales=Sales`. Claude picks the subsite that fits the question; a page URL with `/@<subsite>/` always works |
| `DRAFT_FOLDER` | Folder for drafts, default `Claude drafts` |
| `REVIEWER_IDS` | Optional, comma-separated Papyrs user IDs |
| `ALLOWED_REDIRECT_HOSTS` | `claude.ai,claude.com`, so only Claude can use the sign-in page |

**Free-tier fit:** Workers Free includes 100,000 requests per day and KV includes 100,000 reads and 1,000 writes per day. 80 people use a small fraction of that. Papyrs' rate limit will bite long before Cloudflare's does.

## Add it to Claude

- **Team / Enterprise:** an Owner goes to *Organization settings → Connectors → Add custom connector*, enters `https://papyrs-connector.<subdomain>.workers.dev/mcp` and saves. Each person then opens *Settings → Connectors*, clicks **Connect**, and enters their Papyrs email and personal token on the sign-in page.
- **Individual plans:** *Settings → Connectors → Add custom connector* with the same URL.

Menu names in Claude change from time to time. If something looks different, see Anthropic's help article "Building custom connectors via remote MCP servers".

## Test locally

```bash
node test/mock-papyrs.mjs &        # fake Papyrs with two users and per-user permissions
npx wrangler dev --var PUBLIC_URL:http://localhost:8787 --var PAPYRS_BASE_URL:http://localhost:9000 --var ALLOWED_REDIRECT_HOSTS: --var PAPYRS_SUBSITE:home --var PAPYRS_SUBSITES:home=Home,sales=Sales,data=Data
node test/e2e.mjs                  # full OAuth sign-in for both users + all tools
```

The test checks that a user can't see, read, list, edit or apply changes to another subgroup's restricted page. It also checks that drafts stay private and that live pages only change after an explicit approval.

## Limits of the Papyrs API

- The API can't edit or delete existing text on a page. It can only add text and headings or post comments, so "propose a change" means "add".
- It can't change a page's permissions after creation. Publishing a reviewed draft is a manual step in Papyrs, which also serves as the human review gate.
- Search results and page lists come from Papyrs as-is. Attachments are listed by name and link; their contents aren't read.
