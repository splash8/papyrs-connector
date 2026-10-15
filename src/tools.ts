import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PapyrsClient, PapyrsError, PapyrsPage, PapyrsPageSummary, PapyrsWidget, escapeHtml, markdownToWidgets, pageToText, widgetLinks, widgetStrings } from "./papyrs";

/** What the OAuth grant stores for each connected person (encrypted at rest by workers-oauth-provider). */
export interface Props {
  papyrsToken: string;
  papyrsUserId: string; // "" for Limited Users, who cannot open the People Directory
  name: string;
  email: string;
}

export interface Env {
  OAUTH_KV: KVNamespace;
  REVIEW_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  PUBLIC_URL: string; // where this Worker is reachable, e.g. https://papyrs-connector.<you>.workers.dev
  PAPYRS_BASE_URL: string; // e.g. https://ch-aviation.papyrs.com
  PAPYRS_SUBSITE: string; // default subsite name from the Papyrs URL, e.g. "home"
  PAPYRS_SUBSITES?: string; // optional, all subsites Claude may look in: "home=Intranet Home,sales=Sales,..."
  DRAFT_FOLDER: string; // e.g. "Claude drafts"
  REVIEWER_IDS?: string; // optional comma-separated Papyrs user IDs who review every Claude change
  ALLOWED_REDIRECT_HOSTS?: string; // e.g. "claude.ai,claude.com"
}

interface PendingChange {
  id: string;
  authorId: string;
  authorName: string;
  reviewers: string[];
  type: "add_text" | "add_heading" | "post_comment";
  targetPageId: string;
  targetSubsite?: string; // absent on proposals made before subsites were supported = default subsite
  targetTitle: string;
  targetUrl: string;
  content: string;
  draftPageId: string;
  draftUrl: string;
  createdAt: string;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof PapyrsError ? `Papyrs error ${e.status}: ${e.message}` : `Error: ${(e as Error).message}` }],
});

function wrap<A>(fn: (args: A) => Promise<ReturnType<typeof text>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

const reviewersOf = (env: Env) =>
  (env.REVIEWER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Configured subsites as [slug, label] pairs; the default subsite always comes first. */
const subsitesOf = (env: Env): [string, string][] => {
  const list: [string, string][] = (env.PAPYRS_SUBSITES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [slug, label] = s.split("=").map((x) => x.trim());
      return [slug.replace(/^@/, ""), label || slug];
    });
  const def = (env.PAPYRS_SUBSITE ?? "").replace(/^@/, "");
  if (def && !list.some(([s]) => s.toLowerCase() === def.toLowerCase())) list.unshift([def, def]);
  return list;
};

export function buildServer(env: Env, props: Props): McpServer {
  const defaultSubsite = (env.PAPYRS_SUBSITE ?? "").replace(/^@/, "");
  const clients = new Map<string, PapyrsClient>();
  /** One client per subsite: Papyrs pages, search and forms live inside a subsite ("/@sales/..."). */
  const clientFor = (subsite?: string) => {
    const s = (subsite ?? "").trim().replace(/^@/, "") || defaultSubsite;
    const key = s.toLowerCase();
    if (!clients.has(key)) clients.set(key, new PapyrsClient(env.PAPYRS_BASE_URL, props.papyrsToken, s));
    return clients.get(key)!;
  };
  const papyrs = clientFor();
  const subsites = subsitesOf(env);
  const subsiteHelp =
    ` Papyrs is split into subsites: ${subsites.map(([s, l]) => `"${s}" (${l})`).join(", ")}. ` +
    "papyrs_search and papyrs_list_pages cover every subsite the person belongs to unless you name one; name a subsite to save API calls when you know where to look. " +
    "If a result says some subsites were not searched (rate limit), search those again by name.";
  const subsiteArg = z.string().optional().describe(`Subsite to look in (default "${defaultSubsite}"). One of: ${subsites.map(([s]) => s).join(", ")}`);
  const subsiteFilter = z
    .string()
    .optional()
    .describe(`Only this subsite; omit to cover all subsites the person belongs to. One of: ${subsites.map(([s]) => s).join(", ")}`);
  const base = env.PAPYRS_BASE_URL.replace(/\/+$/, "");

  // Subsites that refused this person (not a member) are remembered for a day, so a search across
  // all subsites doesn't spend scarce API calls on them again. Papyrs still decides every time.
  const noAccessKey = `noaccess:${props.papyrsUserId || props.email}`;
  const FAN_OUT_DEADLINE_MS = 25_000;
  /**
   * Run fn on each subsite (a few at a time) and collect what came back. Subsites the person can't open
   * are skipped silently; ones cut off by the rate limit or the time budget are reported so Claude can retry.
   */
  async function acrossSubsites<T>(only: string | undefined, fn: (c: PapyrsClient) => Promise<T>, rememberRefusals = true) {
    if (only) return { results: [[only.replace(/^@/, ""), await fn(clientFor(only))]] as [string, T][], notSearched: [] as string[] };
    const known = new Set((await env.REVIEW_KV.get<string[]>(noAccessKey, "json")) ?? []);
    const queue = subsites.map(([s]) => s).filter((s) => !known.has(s));
    const results: [string, T][] = [];
    const notSearched: string[] = [];
    let refused = false;
    const started = Date.now();
    const worker = async () => {
      for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
        if (Date.now() - started > FAN_OUT_DEADLINE_MS) {
          notSearched.push(s);
          continue;
        }
        try {
          // No wait-and-retry on 429 here: report the subsite as not searched instead of eating the time budget.
          results.push([s, await fn(new PapyrsClient(env.PAPYRS_BASE_URL, props.papyrsToken, s, false))]);
        } catch (e) {
          if (e instanceof PapyrsError && (e.status === 403 || e.status === 404)) {
            // A 404 while looking up one page only means "not in this subsite", so only searches remember refusals.
            if (rememberRefusals) {
              known.add(s);
              refused = true;
            }
          } else notSearched.push(s);
        }
      }
    };
    // ch-aviation's raised limit took ~70 requests a minute without a 429 (Oct 2026), so 8 at a time is safe.
    await Promise.all(Array.from({ length: 8 }, worker));
    if (refused) await env.REVIEW_KV.put(noAccessKey, JSON.stringify([...known]), { expirationTtl: 60 * 60 * 24 });
    const order = (s: string) => subsites.findIndex(([x]) => x === s);
    results.sort((a, b) => order(a[0]) - order(b[0]));
    return { results, notSearched };
  }
  const notSearchedNote = (ns: string[]) =>
    ns.length ? `\n\nNot searched (Papyrs rate limit or time budget), try again by name: ${ns.join(", ")}` : "";
  /** Search links are sometimes relative to the subsite ("/page/..."), sometimes to the site ("/@sales/..."). */
  const absolute = (link: string, subsite: string) =>
    !link ? "" : link.startsWith("http") ? link : link.startsWith("/@") ? base + link : `${base}/@${subsite}${link.startsWith("/") ? "" : "/"}${link}`;
  const draftFolder = env.DRAFT_FOLDER || "Claude drafts";
  const server = new McpServer(
    { name: "ch-aviation Papyrs", version: "1.0.0" },
    {
      instructions:
        `You are connected to the ch-aviation Papyrs intranet as ${props.name}. Every call runs with ${props.name}'s own Papyrs token, ` +
        "so results contain only what this person may see; never suggest content exists beyond what the tools return. " +
        "Papyrs rate-limits its API, so prefer papyrs_search first and read only the pages you need." +
        subsiteHelp +
        " " +
        "Nothing is written to a live page directly: write tools create a private draft flagged for review, and a change is " +
        "applied only after the person (or a named reviewer) has read it and explicitly approved it in chat." +
        (props.papyrsUserId
          ? ""
          : ` ${props.name} is a Papyrs Limited User, so this connection is read-only: drafting and proposing changes are not available.`),
    },
  );

  /**
   * Accepts a page ID, a full Papyrs URL, or a slug, and returns the page ID plus the subsite it lives in.
   * A URL's "/@<subsite>/" wins over the subsite argument. A bare ID or slug with no subsite is looked up in the
   * default subsite first, then in every other subsite the person can open (Claude often has only the ID).
   */
  async function resolvePage(
    ref: string,
    subsite?: string,
  ): Promise<{ id: string; subsite: string; client: PapyrsClient; page?: PapyrsPage }> {
    const r = ref.trim();
    const named = (r.match(/\/@([^/?#]+)/)?.[1] ?? subsite ?? "").trim();
    const s = named || defaultSubsite;
    const client = clientFor(s);
    const isId = !r.includes("/") && !r.includes("-") && r.length <= 8;
    const slug = r.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? r;
    const findIn = (pages: PapyrsPageSummary[]) =>
      pages.find((p) => p.slug === slug || p.url.replace(/\/+$/, "").endsWith("/" + slug) || p.id === slug);
    try {
      if (isId) return { id: r, subsite: s, client, page: await client.getPage(r) };
      const hit = findIn(await client.allPages());
      if (hit) return { id: hit.id, subsite: s, client };
      throw new PapyrsError(404, `No page matching "${ref}" in subsite "${s}" that you can access.`);
    } catch (e) {
      if (named || !(e instanceof PapyrsError && e.status === 404)) throw e;
    }
    const { results, notSearched } = await acrossSubsites(
      undefined,
      async (c) => {
        if (isId) return { id: r, page: await c.getPage(r) as PapyrsPage | undefined };
        const hit = findIn(await c.allPages());
        if (!hit) throw new PapyrsError(404, "not here");
        return { id: hit.id, page: undefined as PapyrsPage | undefined };
      },
      false,
    );
    const found = results.find(([x]) => x !== s);
    if (found) return { id: found[1].id, subsite: found[0], client: clientFor(found[0]), page: found[1].page };
    throw new PapyrsError(
      404,
      `No page matching "${ref}" in any subsite you can access: it doesn't exist, or you have no access to it in Papyrs.` + (notSearched.length ? ` Not checked (rate limit): ${notSearched.join(", ")}.` : ""),
    );
  }

  /**
   * Navigation widgets don't carry their links: Papyrs fills them from a folder (or a list of pages) when it
   * renders the page. Match each one against the subsite's page list (one extra API call, only when needed):
   * first by the widget's own settings (a folder name or page IDs), then by the heading right above it.
   */
  async function resolveNavigation(p: PapyrsPage, client: PapyrsClient) {
    const resolved = new Map<PapyrsWidget, { links: [string, string][]; note: string }>();
    const navs: { w: PapyrsWidget; heading?: string }[] = [];
    for (const column of p.json ?? []) {
      let heading: string | undefined;
      for (const w of column ?? []) {
        if (w.classname === "Heading" && w.text) heading = String(w.text).trim();
        else if (!w.text && !w.files?.length && !widgetLinks(w).length) navs.push({ w, heading });
      }
    }
    if (!navs.length) return resolved;
    let pages: PapyrsPageSummary[];
    try {
      pages = (await client.allPages()).filter((x) => x.id !== p.id);
    } catch {
      return resolved;
    }
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const asLinks = (list: PapyrsPageSummary[]) => list.slice(0, 40).map((x) => [x.title, x.url] as [string, string]);
    for (const { w, heading } of navs) {
      const settings = widgetStrings(w).map(norm);
      const byId = pages.filter((x) => settings.includes(norm(x.id)));
      const byFolder = pages.filter((x) => {
        const c = norm(x.category ?? "");
        return settings.some((s) => s && (c === s || c.startsWith(s + "/") || c.endsWith("/" + s)));
      });
      if (byId.length) resolved.set(w, { links: asLinks(byId), note: "pages it links to" });
      else if (byFolder.length) resolved.set(w, { links: asLinks(byFolder), note: "pages in its folder" });
      else if (heading) {
        // Folders are often named a bit differently from the heading ("User Accounts" vs "General - User Account"):
        // match a folder segment that contains every word of the heading, ignoring plural "s".
        const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((x) => x.length > 1).map((x) => x.replace(/s$/, ""));
        const hw = words(heading);
        const byHeading = hw.length
          ? pages.filter((x) => (x.category ?? "").split("/").some((seg) => {
              const sw = words(seg);
              return hw.every((h) => sw.includes(h));
            }))
          : [];
        if (byHeading.length) resolved.set(w, { links: asLinks(byHeading), note: `likely pages: folder named "${heading}"` });
      }
    }
    return resolved;
  }

  // ---------------- READ ----------------

  server.registerTool(
    "papyrs_search",
    {
      title: "Search Papyrs",
      description:
        "Search the ch-aviation Papyrs intranet (pages, files, people, form entries, comments) exactly as the connected person would in the Papyrs search box. Only results this person has access to are returned.",
      inputSchema: { query: z.string().min(1).describe("Search words"), subsite: subsiteFilter },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async ({ query, subsite }) => {
      const { results, notSearched } = await acrossSubsites(subsite, (c) => c.search(query));
      const lines: string[] = [];
      for (const [sub, res] of results) {
        for (const r of (res.results ?? []).slice(0, 25)) {
          const pick = (...keys: string[]) => keys.map((k) => r[k]).find((v) => typeof v === "string" && v) as string | undefined;
          const title = pick("desc", "title", "name", "text") ?? JSON.stringify(r).slice(0, 200);
          const kind = pick("cat", "type", "category");
          const id = pick("id") ?? (typeof r.id === "number" ? String(r.id) : undefined);
          const url = absolute(pick("lnk", "url", "link", "href") ?? "", sub);
          lines.push(`- [${sub}]${kind ? ` [${kind}]` : ""} ${title}${url ? ` — ${url}` : ""}${id ? ` (id: ${id})` : ""}`);
        }
      }
      if (!lines.length) return text(`No results for "${query}"${subsite ? ` in subsite "${subsite}"` : ""} that ${props.name} can access.${notSearchedNote(notSearched)}`);
      return text(lines.join("\n") + notSearchedNote(notSearched));
    }),
  );

  server.registerTool(
    "papyrs_list_pages",
    {
      title: "List Papyrs pages",
      description: "List pages the connected person can see, optionally filtered by folder (category) or words in the title. Newest first.",
      inputSchema: {
        folder: z.string().optional().describe('Folder path prefix, e.g. "HR" or "Main/Bizdev"'),
        title_contains: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        subsite: subsiteFilter,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async ({ folder, title_contains, limit, subsite }) => {
      const { results, notSearched } = await acrossSubsites(subsite, (c) => c.allPages());
      let pages = results
        .flatMap(([sub, list]) => list.map((p) => ({ ...p, subsite: sub })))
        .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
      if (folder) pages = pages.filter((p) => (p.category ?? "").toLowerCase().startsWith(folder.toLowerCase()));
      if (title_contains) pages = pages.filter((p) => p.title.toLowerCase().includes(title_contains.toLowerCase()));
      if (!pages.length) return text(`No matching pages that you can access.${notSearchedNote(notSearched)}`);
      return text(
        `${pages.length} page(s); showing ${Math.min(limit, pages.length)}:\n` +
          pages
            .slice(0, limit)
            .map((p) => `- ${p.title} | subsite: ${p.subsite} | folder: ${p.category || "-"} | updated ${p.updated_at?.slice(0, 10) ?? "?"} | id: ${p.id} | ${p.url}`)
            .join("\n") +
          notSearchedNote(notSearched),
      );
    }),
  );

  server.registerTool(
    "papyrs_read_page",
    {
      title: "Read a Papyrs page",
      description: "Read the text content of one Papyrs page (by page ID, URL or slug). Fails if the connected person has no access.",
      inputSchema: { page: z.string().describe("Page ID (e.g. SKvP), full URL, or slug"), subsite: subsiteArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async ({ page, subsite }) => {
      const ref = await resolvePage(page, subsite);
      const p = ref.page ?? (await ref.client.getPage(ref.id));
      const resolved = await resolveNavigation(p, ref.client);
      return text(
        `# ${p.title}\nSubsite: ${ref.subsite} | folder: ${p.category || "-"} | by ${p.created_by ?? "?"} | updated ${p.updated_at ?? "?"} | ${p.url}\n\n${pageToText(p, (l) => absolute(l, ref.subsite), resolved)}`,
      );
    }),
  );

  server.registerTool(
    "papyrs_form_records",
    {
      title: "Read form entries",
      description: "Read the form records submitted on a Papyrs page (forms, trackers). Paginated, newest first.",
      inputSchema: {
        page: z.string().describe("Page ID, URL or slug of the page holding the form"),
        page_number: z.number().int().min(0).default(0),
        per_page: z.number().int().min(1).max(250).default(50),
        subsite: subsiteArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async ({ page, page_number, per_page, subsite }) => {
      const ref = await resolvePage(page, subsite);
      const rows = await ref.client.records(ref.id, page_number, per_page);
      if (!rows.length) return text("No form records on this page (or none you can see).");
      return text(rows.map((r) => r.map((f) => `${f.field}: ${f.value}`).join(" | ")).join("\n"));
    }),
  );

  server.registerTool(
    "papyrs_find_people",
    {
      title: "Find people",
      description:
        "Look up people in the Papyrs People Directory by name, position or group (subgroup). Only works if the connected person can open the People Directory.",
      inputSchema: { query: z.string().optional().describe("Name, position, email or group to filter on; empty lists everyone") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async ({ query }) => {
      const q = (query ?? "").toLowerCase();
      const people = (await papyrs.people()).filter(
        (p) => !q || Object.values(p.attributes).some((v) => String(v).toLowerCase().includes(q)) || p.subgroup_id?.toLowerCase() === q,
      );
      if (!people.length) return text("Nobody matches.");
      // With a single match, include the raw directory record: field names vary between Papyrs sites.
      const raw = people.length === 1 ? `\n\nRaw directory record: ${JSON.stringify(people[0]).slice(0, 1500)}` : "";
      return text(
        people
          .map(
            (p) =>
              `- ${p.attributes.Name} (user ID ${p.id}) | ${p.attributes.Position || "-"} | ${p.attributes.Email || "-"} | group: ${p.attributes.Group || "-"} (subgroup ${p.subgroup_id ?? "-"}) | role: ${p.role_id}${p.waiting_invite ? " | invite pending" : ""}`,
          )
          .join("\n") + raw,
      );
    }),
  );

  server.registerTool(
    "papyrs_page_access",
    {
      title: "Who can access a page",
      description:
        "Show who has edit, view or no access on a Papyrs page, grouped by Papyrs subgroup. Useful to check permissions for each person in a subgroup. Needs access to the page and the People Directory.",
      inputSchema: {
        page: z.string().describe("Page ID, URL or slug"),
        subgroup: z.string().optional().describe("Only show people in this group (group name or subgroup ID)"),
        subsite: subsiteArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async ({ page, subgroup, subsite }) => {
      const ref = await resolvePage(page, subsite);
      const p = ref.page ?? (await ref.client.getPage(ref.id));
      if (!p.permissions) {
        // Show what Papyrs did return (minus the page content), so the real permissions shape can be seen.
        const { json, ...meta } = p as unknown as Record<string, unknown>;
        return text(
          "Papyrs did not return a 'permissions' field for this page to your account. Page fields returned: " +
            JSON.stringify(meta).slice(0, 2000),
        );
      }
      const people = await papyrs.people();
      const sg = subgroup?.toLowerCase();
      const groups = new Map<string, string[]>();
      for (const person of people) {
        const group = person.attributes.Group || "(no group)";
        if (sg && group.toLowerCase() !== sg && person.subgroup_id?.toLowerCase() !== sg) continue;
        const level = p.permissions[person.id] ?? (p.is_public ? "view (public page)" : "no access");
        const key = `${group} [${person.subgroup_id ?? "-"}]`;
        groups.set(key, [...(groups.get(key) ?? []), `  - ${person.attributes.Name}: ${level}${person.role_id === "admin" ? " (site admin)" : ""}`]);
      }
      if (!groups.size) return text("No people found for that subgroup.");
      return text(`Access to "${p.title}":\n` + [...groups].map(([g, rows]) => `${g}\n${rows.join("\n")}`).join("\n"));
    }),
  );

  // ---------------- WRITE (always flagged for review) ----------------

  // Limited Users can't open the People Directory, so we don't know their Papyrs user ID.
  // Without it a draft can't be made private to them, so they get the read tools only.
  if (!props.papyrsUserId) return server;

  const reviewers = reviewersOf(env).filter((id) => id !== props.papyrsUserId);
  const draftPermissions = (me: string) => {
    const perms: Record<string, string> = { [me]: "edit" };
    for (const r of reviewers) perms[r] = "edit";
    return perms;
  };
  const draftNotifications = (me: string) => {
    const n: Record<string, string> = { [me]: "on" };
    for (const r of reviewers) n[r] = "on";
    return n;
  };

  /**
   * Create a private draft in the default subsite. Papyrs has refused the site-wide directory ID with
   * "User with ID <x> not found in your site", so on that error try, in order: the same ID without
   * notifications, then the ID(s) the subsite's own directory has for this person's email. The page is
   * never created without the permission that keeps it private. A working ID is remembered per person.
   */
  const draftIdKey = `draftid:${defaultSubsite}:${props.email}`;
  async function createDraft(body: { title: string; category: string; json: unknown }) {
    const remembered = await env.REVIEW_KV.get<{ id: string; notify: boolean }>(draftIdKey, "json");
    const attempt = (id: string, notify: boolean) =>
      papyrs.createPage({ ...body, permissions: draftPermissions(id), ...(notify ? { notifications: draftNotifications(id) } : {}) });
    const userNotFound = (e: unknown) => e instanceof PapyrsError && e.status === 400 && /not found in your site/i.test(e.message);
    const tries: { id: string; notify: boolean }[] = remembered ? [remembered] : [];
    tries.push({ id: props.papyrsUserId, notify: true }, { id: props.papyrsUserId, notify: false });
    let lastError: unknown;
    let lookedUp = false;
    const log: string[] = [];
    for (let i = 0; i < tries.length; i++) {
      const t = tries[i];
      const duplicate = tries.findIndex((x) => x.id === t.id && x.notify === t.notify) !== i;
      if (!duplicate) {
        try {
          const created = await attempt(t.id, t.notify);
          if (!remembered || remembered.id !== t.id || remembered.notify !== t.notify)
            await env.REVIEW_KV.put(draftIdKey, JSON.stringify(t), { expirationTtl: 60 * 60 * 24 * 30 });
          return created;
        } catch (e) {
          log.push(`${t.id}${t.notify ? "+notifications" : ""}: ${(e as Error).message}`);
          if (!userNotFound(e)) throw e;
          lastError = e;
        }
      }
      if (i === tries.length - 1 && !lookedUp) {
        lookedUp = true;
        try {
          const me = (await papyrs.subsitePeople()).find((p) => (p.attributes?.Email ?? "").trim().toLowerCase() === props.email);
          const ids = me
            ? Object.entries(me as unknown as Record<string, unknown>)
                .filter(([k, v]) => /id$/i.test(k) && typeof v === "string" && v)
                .map(([, v]) => v as string)
            : [];
          log.push(`subsite directory: ${me ? `found, IDs ${ids.join(", ") || "none"}` : "person not found by email"}`);
          for (const id of ids) tries.push({ id, notify: true }, { id, notify: false });
        } catch (e) {
          log.push(`subsite directory: ${(e as Error).message}`);
        }
        // Some Papyrs sites may key permissions by email instead of user ID.
        tries.push({ id: props.email, notify: false });
      }
    }
    throw new PapyrsError(
      400,
      `Papyrs did not accept ${props.name}'s user ID for the draft's private permissions (${(lastError as Error)?.message}). ` +
        `Nothing was created. Attempts: ${log.join(" | ")}. ` +
        "Ask the connector's maintainer to check which user ID Papyrs expects for page permissions.",
    );
  }
  const banner = (what: string) => ({
    classname: "Heading",
    val: escapeHtml(`⚠ NEEDS REVIEW — ${what}. Drafted with Claude for ${props.name} on ${new Date().toISOString().slice(0, 10)}. Not visible to anyone else until shared.`),
  });

  server.registerTool(
    "papyrs_draft_new_page",
    {
      title: "Draft a new page (for review)",
      description:
        `Create a NEW Papyrs page as a private draft in the "${draftFolder}" folder, flagged NEEDS REVIEW. Only the connected person` +
        (reviewers.length ? " and the configured reviewers" : "") +
        " can see it. Publishing (sharing with others, moving folders) is done by a human in Papyrs after review. Content is simple Markdown: '# ' headings, paragraphs, **bold**, *italic*, links, '- ' bullets.",
      inputSchema: {
        title: z.string().min(1),
        content_markdown: z.string().min(1),
        intended_folder: z.string().optional().describe("Where the page should live once reviewed, e.g. HR/Policies"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrap(async ({ title, content_markdown, intended_folder }) => {
      const widgets = [banner(`draft page${intended_folder ? ` intended for "${intended_folder}"` : ""}`), ...markdownToWidgets(content_markdown)];
      const created = await createDraft({
        title: `[DRAFT] ${title}`,
        category: intended_folder ? `${draftFolder}/${intended_folder}` : draftFolder,
        json: [widgets, []],
      });
      return text(
        `Draft created and flagged for review: ${created.url}\nOnly ${props.name}${reviewers.length ? " and the reviewers" : ""} can see it. ` +
          `To publish: open it in Papyrs, review, remove the banner, set permissions${intended_folder ? ` and move it to "${intended_folder}"` : ""}.`,
      );
    }),
  );

  server.registerTool(
    "papyrs_propose_change",
    {
      title: "Propose a change to an existing page (for review)",
      description:
        "Propose adding text or a heading to an existing Papyrs page, or posting a comment in its discussion. Nothing changes on the live page: " +
        "this creates a private review draft and returns a review_id. Only after the person has read the draft and explicitly approved it, call papyrs_apply_reviewed_change.",
      inputSchema: {
        page: z.string().describe("Target page ID, URL or slug"),
        change_type: z.enum(["add_text", "add_heading", "post_comment"]),
        content: z.string().min(1).describe("Markdown for add_text; plain text for add_heading and post_comment"),
        reason: z.string().optional().describe("One line on why, shown to the reviewer"),
        subsite: subsiteArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrap(async ({ page, change_type, content, reason, subsite }) => {
      const ref = await resolvePage(page, subsite);
      const target: PapyrsPage = ref.page ?? (await ref.client.getPage(ref.id));
      const myLevel = target.permissions?.[props.papyrsUserId];
      if (change_type !== "post_comment" && myLevel && myLevel !== "edit")
        return text(`${props.name} has "${myLevel}" access to "${target.title}", not edit, so this change cannot be applied later. Nothing was created.`);
      const id = crypto.randomUUID().slice(0, 8);
      const label = { add_text: "add this text", add_heading: "add this heading", post_comment: "post this comment" }[change_type];
      const draft = await createDraft({
        title: `[REVIEW ${id}] ${target.title}`,
        category: `${draftFolder}/Proposed changes`,
        json: [
          [
            banner(`proposed change ${id} to "${target.title}"`),
            { classname: "Paragraph", val: `Proposal: <b>${label}</b> on <a href="${escapeHtml(target.url)}">${escapeHtml(target.title)}</a>.${reason ? `<br>Reason: ${escapeHtml(reason)}` : ""}<br>Approve it in Claude by saying: <i>apply review ${id}</i>.` },
            { classname: "Heading", val: "Proposed content" },
            ...markdownToWidgets(content),
          ],
          [],
        ],
      });
      const pending: PendingChange = {
        id,
        authorId: props.papyrsUserId,
        authorName: props.name,
        reviewers,
        type: change_type,
        targetPageId: target.id,
        targetSubsite: ref.subsite,
        targetTitle: target.title,
        targetUrl: target.url,
        content,
        draftPageId: draft.id,
        draftUrl: draft.url,
        createdAt: new Date().toISOString(),
      };
      await env.REVIEW_KV.put(`review:${id}`, JSON.stringify(pending), { expirationTtl: 60 * 60 * 24 * 30 });
      return text(
        `Review draft ${id} created: ${draft.url}\nThe live page "${target.title}" is unchanged. Show the person the proposed content; apply only after they explicitly approve review ${id}. Unapplied proposals expire after 30 days.`,
      );
    }),
  );

  server.registerTool(
    "papyrs_list_pending_reviews",
    {
      title: "List changes waiting for review",
      description: "List proposed Papyrs changes the connected person created or is a reviewer for.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async () => {
      const list = await env.REVIEW_KV.list({ prefix: "review:" });
      const mine: PendingChange[] = [];
      for (const k of list.keys) {
        const v = await env.REVIEW_KV.get<PendingChange>(k.name, "json");
        if (v && (v.authorId === props.papyrsUserId || v.reviewers.includes(props.papyrsUserId))) mine.push(v);
      }
      if (!mine.length) return text("Nothing waiting for review.");
      return text(mine.map((c) => `- ${c.id}: ${c.type} on "${c.targetTitle}" by ${c.authorName}, ${c.createdAt.slice(0, 10)} — draft ${c.draftUrl}`).join("\n"));
    }),
  );

  server.registerTool(
    "papyrs_apply_reviewed_change",
    {
      title: "Apply an approved change",
      description:
        "Apply a proposed change to the live Papyrs page. ONLY call this after the person has seen the proposed content and explicitly said they approve this review_id in this conversation. Runs with the person's own Papyrs permissions.",
      inputSchema: {
        review_id: z.string(),
        approval_statement: z.string().min(3).describe("The person's own words approving it, quoted from the chat"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    wrap(async ({ review_id, approval_statement }) => {
      const key = `review:${review_id.trim()}`;
      const c = await env.REVIEW_KV.get<PendingChange>(key, "json");
      if (!c) return text(`No pending review ${review_id}. It may be applied, discarded or expired.`);
      if (c.authorId !== props.papyrsUserId && !c.reviewers.includes(props.papyrsUserId))
        return text(`${props.name} is neither the author nor a reviewer of ${review_id}.`);
      const live = clientFor(c.targetSubsite);
      if (c.type === "add_text") {
        for (const w of markdownToWidgets(c.content))
          await live.addWidget(c.targetPageId, w.classname === "Heading" ? "heading" : "paragraph", w.val);
      } else if (c.type === "add_heading") {
        await live.addWidget(c.targetPageId, "heading", escapeHtml(c.content));
      } else {
        await live.postToPage(c.targetPageId, c.content);
      }
      await env.REVIEW_KV.delete(key);
      try {
        await papyrs.addWidget(
          c.draftPageId,
          "paragraph",
          escapeHtml(`✔ Applied by ${props.name} on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. Approval: "${approval_statement.slice(0, 300)}". This draft can be deleted.`),
        );
      } catch {
        /* the audit note is nice-to-have; the change itself succeeded */
      }
      return text(`Applied review ${c.id} to "${c.targetTitle}": ${c.targetUrl}`);
    }),
  );

  server.registerTool(
    "papyrs_discard_change",
    {
      title: "Discard a proposed change",
      description: "Discard a proposed change so it can no longer be applied. The draft page stays in Papyrs for reference.",
      inputSchema: { review_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrap(async ({ review_id }) => {
      const key = `review:${review_id.trim()}`;
      const c = await env.REVIEW_KV.get<PendingChange>(key, "json");
      if (!c) return text(`No pending review ${review_id}.`);
      if (c.authorId !== props.papyrsUserId && !c.reviewers.includes(props.papyrsUserId)) return text("Only the author or a reviewer can discard it.");
      await env.REVIEW_KV.delete(key);
      return text(`Discarded review ${c.id}. Draft page kept at ${c.draftUrl}.`);
    }),
  );

  return server;
}
