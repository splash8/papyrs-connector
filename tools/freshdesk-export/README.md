# Freshdesk conversation export

Exports every ticket's full conversation to one CSV file: the original description, customer and agent replies, forwards, and public and private notes. You can skip tickets that belong to chosen groups.

## Run

There are two copies of the same script: `export.py` (Python 3.8+, no extra packages) and `export.mjs` (Node 20+). They take the same options and write the same CSV.

Windows PowerShell:

```powershell
$env:FRESHDESK_DOMAIN = "yourcompany.freshdesk.com"
$env:FRESHDESK_API_KEY = "xxxxxxxx"      # Freshdesk → Profile settings → View API key

python export.py --list-groups                       # show group IDs and names
python export.py --exclude-groups "Sales,HR" --out freshdesk-conversations.csv
```

Mac/Linux: set the variables with `export FRESHDESK_DOMAIN=…` and run `python3 export.py …`. With Node, run `node export.mjs …` instead.

| Option | Meaning |
|---|---|
| `--exclude-groups "A,B,123"` | Groups to skip, by name (case-insensitive) or ID. An unknown name stops the script. |
| `--exclude-ungrouped` | Also skip tickets with no group |
| `--since 2024-01-01` | Only tickets created on or after this date (default: all) |
| `--until 2024-12-31` | Only tickets created on or before this date |
| `--out file.csv` | Output path. The script won't overwrite an existing file unless you add `--resume`. |
| `--resume` | Continue an interrupted export (Python version only). Run the same command again with `--resume` added; tickets already in the file are kept and the rest are added. |

Use an admin's API key. An agent's key only returns tickets that agent can see.

## Output

The file has one row per conversation entry, and every row repeats the ticket's columns. `entry_type` is one of `description`, `customer_reply`, `agent_reply`, `public_note`, `private_note` or `forward`. Bodies are plain text (`body_text`). Attachments are listed by file name only. The file is UTF-8 with a BOM, so Excel shows accents correctly.

## Notes

- Freshdesk returns deleted and spam tickets only on request, so this export leaves them out.
- If the run stops (crash, closed window, PC restart), rerun the same command with `--resume`. The last ticket in the file may be cut off mid-thread, so it is fetched again. When resuming, the `Done:` line's "skipped" count covers only that run.
- The script makes one API call per ticket, plus one more for each extra 100 entries in a long thread. It waits and retries when Freshdesk returns 429. A large helpdesk can take hours on a low-tier plan's rate limit.
- Author names are filled in for agents and for the ticket's requester. Other contacts show only `author_id` and `from_email`.
