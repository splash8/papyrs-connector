// Thin client for the Papyrs REST API (https://papyrs.com/docs/api/).
// Every call runs with ONE person's own API token, so Papyrs itself decides
// what that person may see or change. The connector never holds an admin token.

export class PapyrsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface PapyrsPerson {
  id: string;
  role_id?: string;
  subgroup_id?: string;
  waiting_invite?: boolean;
  attributes: Record<string, string>;
}

export interface PapyrsPageSummary {
  id: string;
  title: string;
  slug?: string;
  category: string;
  url: string;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
  tags?: string[];
  is_public?: boolean | number;
}

export interface PapyrsWidget {
  classname: string;
  id: string;
  text?: string;
  html?: string;
  files?: { filename: string; url: string; vanity_size?: string }[];
  [k: string]: unknown;
}

export interface PapyrsPage extends PapyrsPageSummary {
  json: PapyrsWidget[][];
  permissions?: Record<string, "edit" | "view" | "no access">;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PapyrsClient {
  private siteBase: string;
  private base: string;

  // Pages, search and feeds live inside a subsite, so their URLs need "/@<subsite>".
  // The people directory is site-wide and stays at the site root.
  constructor(baseUrl: string, private token: string, subsite = "") {
    const root = baseUrl.replace(/\/+$/, "");
    const sub = subsite.trim().replace(/^@/, "");
    this.siteBase = root + "/api/v1";
    this.base = (sub ? `${root}/@${encodeURIComponent(sub)}` : root) + "/api/v1";
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; siteWide?: boolean } = {},
  ): Promise<T> {
    const url = new URL((opts.siteWide ? this.siteBase : this.base) + path);
    url.searchParams.set("auth_token", this.token);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    // Papyrs allows only 6 requests per 60 seconds by default. Wait and retry once
    // instead of failing the whole question on the first 429.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url.toString(), {
        method,
        headers: { "Content-Type": "application/json", "User-Agent": "ch-aviation-claude-connector" },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if (res.status === 429 && attempt === 0) {
        await sleep(12_000);
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        try {
          msg = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {}
        if (res.status === 404) msg = "Not found, or you have no access to it in Papyrs.";
        if (res.status === 403) msg = `Papyrs refused this for your account: ${msg}`;
        if (res.status === 429) msg = "Papyrs rate limit reached (6 requests per minute). Wait a minute and try again.";
        throw new PapyrsError(res.status, msg.slice(0, 500));
      }
      return (text ? JSON.parse(text) : null) as T;
    }
    throw new PapyrsError(429, "Papyrs rate limit reached.");
  }

  search(q: string) {
    return this.call<{ results: { desc: string; lnk: string; cat: string; id: string }[] }>("GET", "/search/query/", { query: { q } });
  }
  allPages() {
    return this.call<PapyrsPageSummary[]>("GET", "/pages/all/");
  }
  getPage(id: string) {
    return this.call<PapyrsPage>("GET", `/pages/get/${encodeURIComponent(id)}/`);
  }
  records(id: string, page = 0, perPage = 50) {
    return this.call<{ field: string; value: unknown }[][]>("GET", `/pages/records/${encodeURIComponent(id)}/`, {
      query: { page: String(page), items_per_page: String(perPage) },
    });
  }
  people() {
    return this.call<PapyrsPerson[]>("GET", "/people/all/", { siteWide: true });
  }
  createPage(body: { title: string; json: unknown; category?: string; permissions?: Record<string, string>; notifications?: Record<string, string> }) {
    return this.call<PapyrsPage>("POST", "/pages/create/", { body });
  }
  addWidget(pageId: string, kind: "paragraph" | "heading", html: string) {
    return this.call<PapyrsWidget>("POST", `/page/${encodeURIComponent(pageId)}/${kind}/create/`, {
      query: { format: "html" },
      body: { widget: { val: html } },
    });
  }
  postToPage(pageId: string, msg: string) {
    return this.call<unknown>("POST", `/feed/post/${encodeURIComponent(pageId)}/`, { body: { msg } });
  }
}

// ---------- small text helpers ----------

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Very small Markdown subset -> Papyrs widgets: "# " lines become headings, the rest paragraphs. */
export function markdownToWidgets(md: string): { classname: "Heading" | "Paragraph"; val: string }[] {
  const out: { classname: "Heading" | "Paragraph"; val: string }[] = [];
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/\*(.+?)\*/g, "<i>$1</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  for (const block of md.replace(/\r/g, "").split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    const h = b.match(/^#{1,6}\s+(.*)$/);
    if (h && !b.includes("\n")) out.push({ classname: "Heading", val: inline(h[1]) });
    else
      out.push({
        classname: "Paragraph",
        val: b
          .split("\n")
          .map((l) => inline(l.replace(/^\s*[-*]\s+/, "• ")))
          .join("<br>"),
      });
  }
  return out;
}

export function pageToText(page: PapyrsPage, maxChars = 40_000): string {
  const parts: string[] = [];
  for (const column of page.json ?? []) {
    for (const w of column ?? []) {
      if (w.classname === "Heading" && w.text) parts.push(`## ${w.text}`);
      else if (w.files?.length) parts.push(`[Attachments] ${w.files.map((f) => `${f.filename} (${f.url})`).join("; ")}`);
      else if (w.text) parts.push(String(w.text));
      else parts.push(`[${w.classname} widget]`);
    }
  }
  const text = parts.join("\n\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n\n[...truncated]" : text;
}
