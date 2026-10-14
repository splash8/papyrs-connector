// Mock of the Papyrs API, enforcing per-token permissions like the real thing.
import http from "node:http";

const users = {
  "tok-alice": { id: "U1", attributes: { Name: "Alice Zagreb", Email: "alice@ch-aviation.com", Group: "Zagreb", Position: "Editor" }, role_id: "normal", subgroup_id: "SG-ZG" },
  "tok-carol": { id: "U3", attributes: { Name: "Carol Client", Email: "carol@example.com" }, role_id: "limited", subgroup_id: "SG-EXT" },
  "tok-bob": { id: "U2", attributes: { Name: "Bob Belgrade", Email: "bob@ch-aviation.com", Group: "Belgrade", Position: "Analyst" }, role_id: "normal", subgroup_id: "SG-BG" },
};
const pages = {
  P1: { id: "P1", slug: "Company-Handbook", title: "Company Handbook", category: "HR", permissions: { U1: "edit", U2: "view", U3: "view" }, json: [[{ classname: "Paragraph", id: "w1", text: "Holidays: 25 days." }], []] },
  P2: { id: "P2", slug: "Zagreb-Salaries", title: "Zagreb Salaries", category: "HR/Confidential", permissions: { U1: "view", U2: "no access" }, json: [[{ classname: "Paragraph", id: "w2", text: "SECRET salary table" }], []] },
  // Pages on the members-only "sales" subsite: a hub with a navigation widget, and the page it links to.
  P8: { id: "P8", subsite: "sales", slug: "Trial-set-up-Trial-extension", title: "Trial set-up / Trial extension", category: "Main", permissions: { U1: "edit", U2: "view" }, json: [[{ classname: "Paragraph", id: "w8", text: "To set up a trial, open the admin panel." }], []] },
  P9: { id: "P9", subsite: "sales", slug: "Sales-Wiki", title: "Sales Wiki", category: "Main", permissions: { U1: "view", U2: "view" }, json: [[{ classname: "Heading", id: "w9", text: "Trials" }, { classname: "Navigation", id: "n9", pages: [{ title: "Trial set-up / Trial extension", url: "/@sales/Trial-set-up-Trial-extension" }] }, { classname: "Paragraph", id: "w10", text: "See also pricing.", html: 'See also <a href="/@sales/Pricing">pricing</a>.' }, { classname: "Heading", id: "w11", text: "User Accounts" }, { classname: "Navigation", id: "n11", settings: { style: "list" } }], []] },
  P10: { id: "P10", subsite: "sales", slug: "Adding-a-user", title: "Adding a user", category: "Main/General - User Account", permissions: { U1: "view" }, json: [[], []] },
};
const subsiteMembers = { sales: ["U1"] };
let n = 3;
const can = (u, p, lvl) => {
  const l = p.permissions[u.id] ?? "no access";
  return lvl === "view" ? l !== "no access" : l === "edit";
};
const full = (p) => ({ ...p, url: `https://ch-aviation.papyrs.com/@${p.subsite ?? "home"}/${p.slug}`, created_by: "x", updated_at: "2026-10-01T00:00:00Z" });
export const log = [];

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    for await (const c of req) body += c;
    const u = users[url.searchParams.get("auth_token")];
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    log.push(`${req.method} ${url.pathname} as ${u?.id}`);
    console.log(`${req.method} ${url.pathname} as ${u?.id ?? "INVALID"}`);
    if (!u) return send(403, { error: "Invalid token", status: 403 });
    // Subsites other than "home" are members-only, like invitation-only subsites in Papyrs.
    const sub = url.pathname.match(/^\/@([^/]+)/)?.[1];
    if (sub && sub !== "home" && !(subsiteMembers[sub] ?? []).includes(u.id)) return send(403, { error: "You are not a member of this subsite", status: 403 });
    const path = url.pathname.replace(/^\/@[^/]+/, "").replace("/api/v1", "");
    const here = (p) => (p.subsite ?? "home") === (sub ?? "home");
    let m;
    if (path === "/people/all/") return u.role_id === "limited" ? send(403, { error: "No access to the People Directory", status: 403 }) : send(200, Object.values(users));
    if (path === "/pages/all/") return send(200, Object.values(pages).filter((p) => here(p) && can(u, p, "view")).map(({ json, permissions, ...r }) => full(r)));
    if ((m = path.match(/^\/pages\/get\/(\w+)\/$/))) {
      const p = pages[m[1]];
      if (!p || !here(p) || !can(u, p, "view")) return send(404, { error: "not found", status: 404 });
      return send(200, full(p));
    }
    if (path === "/search/query/") {
      const q = url.searchParams.get("q").toLowerCase();
      return send(200, {
        results: Object.values(pages)
          .filter((p) => here(p) && can(u, p, "view") && (p.title + JSON.stringify(p.json)).toLowerCase().includes(q))
          .map((p) => ({ desc: p.title, lnk: "/" + p.slug, cat: "Page", id: p.id })),
      });
    }
    if (path === "/pages/create/") {
      const b = JSON.parse(body);
      const id = "P" + n++;
      pages[id] = { id, subsite: sub ?? "home", slug: b.title.replace(/\W+/g, "-"), title: b.title, category: b.category, permissions: b.permissions ?? {}, json: b.json.map((col) => col.map((w, i) => ({ ...w, id: id + "w" + i, text: w.val.replace(/<[^>]+>/g, "") }))) };
      return send(200, full(pages[id]));
    }
    if ((m = path.match(/^\/page\/(\w+)\/(paragraph|heading)\/create\/$/))) {
      const p = pages[m[1]];
      if (!p || !can(u, p, "edit")) return send(403, { error: "no edit permission", status: 403 });
      const val = JSON.parse(body).widget.val;
      p.json[0].push({ classname: m[2] === "heading" ? "Heading" : "Paragraph", id: "w" + n++, text: val.replace(/<[^>]+>/g, "") });
      return send(200, { classname: "Paragraph", id: "wX", text: val });
    }
    if ((m = path.match(/^\/feed\/post\/(\w+)\/$/))) {
      const p = pages[m[1]];
      if (!p || !can(u, p, "view")) return send(404, { error: "not found", status: 404 });
      return send(200, { c: JSON.parse(body).msg, by: u.attributes.Name, id: 1 });
    }
    if ((m = path.match(/^\/pages\/records\/(\w+)\/$/))) return send(200, []);
    send(405, { error: "unknown", status: 405 });
  })
  .listen(9000, () => console.log("mock papyrs on 9000"));
