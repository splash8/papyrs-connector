# Freshdesk conversation export

Exports every ticket's full conversation to one CSV file: the original description, customer and agent replies, forwards, and public and private notes. You can skip tickets that belong to chosen groups. The script has no dependencies and needs Node 20+.

## Run

```bash
export FRESHDESK_DOMAIN=yourcompany.freshdesk.com
export FRESHDESK_API_KEY=xxxxxxxx      # Freshdesk → Profile settings → View API key

node tools/freshdesk-export/export.mjs --list-groups          # show group IDs and names
node tools/freshdesk-export/export.mjs \
  --exclude-groups "Sales,HR" \
  --out freshdesk-conversations.csv
```

| Option | Meaning |
|---|---|
| `--exclude-groups "A,B,123"` | Groups to skip, by name (case-insensitive) or ID. An unknown name stops the script. |
| `--exclude-ungrouped` | Also skip tickets with no group |
| `--since 2024-01-01` | Only tickets updated on or after this date (default: all) |
| `--until 2024-12-31` | Only tickets created on or before this date |
| `--out file.csv` | Output path |

Use an admin's API key. An agent's key only returns tickets that agent can see.

## Output

The file has one row per conversation entry, and every row repeats the ticket's columns. `entry_type` is one of `description`, `customer_reply`, `agent_reply`, `public_note`, `private_note` or `forward`. Bodies are plain text (`body_text`). Attachments are listed by file name only. The file is UTF-8 with a BOM, so Excel shows accents correctly.

## Notes

- Freshdesk returns deleted and spam tickets only on request, so this export leaves them out.
- The script makes one API call per ticket, plus one more for each extra 100 entries in a long thread. It waits and retries when Freshdesk returns 429. A large helpdesk can take hours on a low-tier plan's rate limit.
- Author names are filled in for agents and for the ticket's requester. Other contacts show only `author_id` and `from_email`.
