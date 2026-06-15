// AgentReady scanner — core engine (pure, zero runtime deps).
// Externally audits an e-commerce store for AI-shopping-agent readiness.
// Importable: `import { scanStore, renderText } from "./scan.mjs"`.
// Uses only global fetch/URL/console — no `process`, so it runs in any ESM host.

const AI_BOTS = [
  "GPTBot",          // OpenAI training crawler
  "OAI-SearchBot",   // ChatGPT search index
  "ChatGPT-User",    // ChatGPT fetch-on-demand
  "ClaudeBot",       // Anthropic
  "PerplexityBot",   // Perplexity
  "Google-Extended", // Gemini / Google AI
];

const DEFAULT_TIMEOUT = 9000;
const UA =
  "Mozilla/5.0 (compatible; AgentReadyBot/0.1; +https://agentready.dev/bot)";

// ---------- low-level fetch ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { timeout = DEFAULT_TIMEOUT, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: ctrl.signal,
        headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*" },
      });
      const body = await res.text();
      // retry transient rate-limit / server errors
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      return { ok: res.ok, status: res.status, finalUrl: res.url || url, headers: res.headers, body };
    } catch (err) {
      // transient network error (connection reset / abort) — back off and retry
      if (attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
      return { ok: false, status: 0, finalUrl: url, headers: null, body: "", error: String((err && err.message) || err) };
    } finally {
      clearTimeout(t);
    }
  }
}

function normalizeUrl(input) {
  let s = String(input || "").trim();
  if (!s) throw new Error("empty url");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return new URL(s);
}

// ---------- robots.txt ----------
function parseRobots(text) {
  // returns { groups: [{ agents:[...lower], rules:[{type, path}] }] }
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "disallow" || field === "allow") {
      if (!cur) {
        cur = { agents: ["*"], rules: [] };
        groups.push(cur);
      }
      cur.rules.push({ type: field, path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return { groups };
}

// Is `bot` blocked from crawling "/" (root) per robots groups?
function botBlocked(robots, bot) {
  const b = bot.toLowerCase();
  const match = (grp) => grp.agents.includes(b);
  const star = (grp) => grp.agents.includes("*");
  // most-specific group wins; if specific group exists use it, else fall back to '*'
  const specific = robots.groups.filter(match);
  const wildcard = robots.groups.filter(star);
  const pick = specific.length ? specific : wildcard;
  if (!pick.length) return false; // no rules → allowed
  // blocked if any group has Disallow: / (and no Allow: / overriding)
  for (const grp of pick) {
    const disallowRoot = grp.rules.some(
      (r) => r.type === "disallow" && (r.path === "/" || r.path === "/*")
    );
    const allowRoot = grp.rules.some((r) => r.type === "allow" && r.path === "/");
    if (disallowRoot && !allowRoot) return true;
  }
  return false;
}

// ---------- JSON-LD ----------
function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let txt = m[1].trim();
    if (!txt) continue;
    try {
      const parsed = JSON.parse(txt);
      out.push(parsed);
    } catch {
      // tolerate trailing commas / minor issues
      try {
        const cleaned = txt.replace(/,\s*([}\]])/g, "$1");
        out.push(JSON.parse(cleaned));
      } catch {
        /* skip unparseable block */
      }
    }
  }
  return out;
}

function flattenLd(nodes) {
  const flat = [];
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== "object") return;
    if (Array.isArray(n["@graph"])) n["@graph"].forEach(walk);
    flat.push(n);
  };
  nodes.forEach(walk);
  return flat;
}

function typeMatches(node, name) {
  const t = node && node["@type"];
  if (!t) return false;
  const arr = Array.isArray(t) ? t : [t];
  return arr.some((x) => String(x).toLowerCase() === name.toLowerCase());
}

function findProductNode(ldNodes) {
  const flat = flattenLd(ldNodes);
  // Product preferred; ProductGroup (variant products, common on Shopify) is valid too.
  return (
    flat.find((n) => typeMatches(n, "Product")) ||
    flat.find((n) => typeMatches(n, "ProductGroup")) ||
    null
  );
}

function get(node, key) {
  return node && node[key] != null ? node[key] : undefined;
}
// For a ProductGroup, a representative variant carries offers/sku/price.
function variantOf(product) {
  const v = get(product, "hasVariant");
  if (!v) return null;
  return Array.isArray(v) ? v[0] : v;
}
function firstOffer(product) {
  let off = get(product, "offers");
  if (!off) {
    const v = variantOf(product);
    off = v && get(v, "offers");
  }
  if (!off) return undefined;
  if (Array.isArray(off)) off = off[0];
  return off;
}

// ---------- platform detection ----------
function detectPlatform(html, headers) {
  const h = (k) => (headers && headers.get ? (headers.get(k) || "") : "");
  const body = html || "";
  const cookie = h("set-cookie");
  if (/cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.theme|myshopify\.com|x-shopify|shopify-features|window\.Shopify/i.test(body) || h("x-shopid") || h("x-shopify-stage") || /_shopify|_secure_session/i.test(cookie) || /Shopify/i.test(h("powered-by")))
    return "shopify";
  if (/woocommerce|wp-content\/plugins\/woocommerce|wc-block|class="[^"]*woocommerce/i.test(body)) return "woocommerce";
  if (/static\.squarespace\.com|squarespace\.com|Static\.SQUARESPACE|data-controller="Commerce/i.test(body)) return "squarespace";
  if (/cdn11\.bigcommerce\.com|bigcommerce/i.test(body)) return "bigcommerce";
  if (/bigcartel\.com|bigcartel/i.test(body)) return "bigcartel";
  if (/mage-init|static\/version|"Magento_|\bMagento\b/i.test(body)) return "magento";
  if (/wixstatic\.com|X-Wix/i.test(body) || h("x-wix-request-id")) return "wix";
  return "custom/unknown";
}

// ---------- product URL discovery ----------
function absolutize(href, origin) {
  try {
    return new URL(href, origin).toString();
  } catch {
    return null;
  }
}
function findProductLinks(html, origin) {
  const links = new Set();
  const re = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (/\/products\/[a-z0-9\-_%]+/i.test(href) || /\/product\/[a-z0-9\-_%]+/i.test(href)) {
      const abs = absolutize(href, origin);
      if (abs && !/\/products\/?$/i.test(abs)) links.add(abs.split("#")[0].split("?")[0]);
    }
  }
  return [...links];
}

// ---------- scoring helpers ----------
function grade(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 55) return "D";
  return "F";
}

// ---------- main ----------
export async function scanStore(input, opts = {}) {
  const url = normalizeUrl(input);
  let origin = url.origin;
  const checks = [];
  const add = (c) => checks.push(c);

  // 1) homepage / transport
  const home = await fetchText(url.toString(), opts);
  const reachable = home.ok && home.status >= 200 && home.status < 400;
  // Adopt the post-redirect origin only when it's the same registrable domain and
  // not an auxiliary host (bots sometimes get bounced to checkout/cart/account).
  if (reachable && home.finalUrl) {
    try {
      const fo = new URL(home.finalUrl);
      const reg = (h) => h.split(".").slice(-2).join(".");
      const isAux = /(^|\.)(checkout|cart|account|secure|pay|login)\./i.test(fo.hostname);
      if (reg(fo.hostname) === reg(url.hostname) && !isAux) origin = fo.origin;
    } catch { /* keep input origin */ }
  }
  const https = origin.startsWith("https://");
  add({
    id: "transport",
    label: "Reachable over HTTPS",
    max: 5,
    score: reachable && https ? 5 : reachable ? 3 : 0,
    status: reachable && https ? "pass" : reachable ? "warn" : "fail",
    detail: reachable ? `HTTP ${home.status}${https ? ", HTTPS" : ", NOT https"}` : `unreachable (${home.error || home.status})`,
    fix: https ? "" : "Serve the store over HTTPS — agents and checkout protocols require TLS 1.2+.",
  });

  let platform = detectPlatform(home.body, home.headers);
  add({
    id: "platform",
    label: "Platform detected",
    max: 5,
    score: platform === "custom/unknown" ? 2 : 5,
    status: platform === "custom/unknown" ? "warn" : "info",
    detail: platform,
    fix:
      platform === "shopify"
        ? "Shopify: enable the ChatGPT sales channel; UCP handled by Agentic Storefronts when live."
        : platform === "woocommerce"
        ? "WooCommerce: add complete Product schema + a product feed (manual lift — your main opportunity)."
        : platform === "custom/unknown"
        ? "Custom stack: you must build schema, feeds, and crawler access yourself — highest manual effort, audit matters most."
        : `${platform}: needs manual ACP/feed integration vs Shopify auto-handling.`,
  });

  // 2) robots.txt — AI crawler access
  const robotsRes = await fetchText(origin + "/robots.txt", opts);
  let crawlerScore = 20;
  let blocked = [];
  let robotsDetail = "no robots.txt (all bots allowed by default)";
  if (robotsRes.ok && /disallow|user-agent/i.test(robotsRes.body)) {
    const robots = parseRobots(robotsRes.body);
    blocked = AI_BOTS.filter((b) => botBlocked(robots, b));
    const starBlocked = botBlocked(robots, "*");
    if (starBlocked && blocked.length === AI_BOTS.length) {
      crawlerScore = 0;
      robotsDetail = "robots.txt blocks all crawlers from / (catastrophic for AI discovery)";
    } else {
      crawlerScore = Math.max(0, 20 - blocked.length * (20 / AI_BOTS.length));
      robotsDetail = blocked.length ? `blocks: ${blocked.join(", ")}` : "all major AI bots allowed";
    }
  }
  add({
    id: "crawler_access",
    label: "AI crawler access (robots.txt)",
    max: 20,
    score: Math.round(crawlerScore),
    status: crawlerScore >= 18 ? "pass" : crawlerScore >= 10 ? "warn" : "fail",
    detail: robotsDetail,
    fix: blocked.length
      ? `Allow these AI agents in robots.txt: ${blocked.join(", ")}. Each blocked bot = one AI surface you're invisible on.`
      : "",
  });

  // Cloudflare AI-block heuristic
  const server = home.headers && home.headers.get ? (home.headers.get("server") || "") : "";
  if (/cloudflare/i.test(server)) {
    add({
      id: "cdn_ai_block",
      label: "Cloudflare AI-bot policy",
      max: 0,
      score: 0,
      status: "warn",
      detail: "Cloudflare detected — its default config can block AI bots automatically.",
      fix: "In Cloudflare → AI Audit / Bot settings, confirm AI crawlers (GPTBot, OAI-SearchBot, etc.) are NOT blocked.",
    });
  }

  // 3) find + fetch a product page — Shopify products.json (any store), homepage links, then sitemap fallback
  let productUrl = null;
  let productsJsonOk = false;
  const productCandidates = [];
  {
    const host = new URL(origin).hostname.replace(/^www\./, "");
    const proto = new URL(origin).protocol;
    const hostCandidates = [...new Set([`${proto}//www.${host}`, `${proto}//${host}`, origin])];
    // skip gift cards / merch so we sample a representative product
    const skip = /gift|e-?gift|\bcard\b|sample|sticker|merch|t-?shirt|tee|hoodie|sweat|\bhat\b|cap|beanie|mug|tote|bag-clip|subscription/i;
    let handle = null;
    for (const o of hostCandidates) {
      const pj = await fetchText(o + "/products.json?limit=20", opts);
      if (!pj.ok) continue;
      try {
        const j = JSON.parse(pj.body);
        if (j && Array.isArray(j.products) && j.products.length) {
          productsJsonOk = true;
          if (platform === "custom/unknown") platform = "shopify"; // products.json is a definitive Shopify signal
          const pick = j.products.find((p) => p.handle && !skip.test(p.handle)) || j.products.find((p) => p.handle);
          handle = pick && pick.handle;
          break;
        }
      } catch { /* not shopify json on this host; try next */ }
    }
    if (handle) for (const o of hostCandidates) productCandidates.push(`${o}/products/${handle}`);
  }
  for (const l of findProductLinks(home.body, origin)) {
    if (!productCandidates.includes(l)) productCandidates.push(l);
    if (productCandidates.length >= 6) break;
  }
  // sitemap fallback for headless / non-Shopify stores
  if (!productCandidates.length) {
    const sm = await fetchText(origin + "/sitemap.xml", opts);
    if (sm.ok) {
      let locs = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
      const subProd = locs.find((u) => /\.xml/i.test(u) && /product/i.test(u));
      if (subProd) {
        const s2 = await fetchText(subProd, opts);
        if (s2.ok) locs = [...s2.body.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
      }
      const prod = locs.find((u) => /\/products?\//i.test(u));
      if (prod) productCandidates.push(prod);
    }
  }
  let productRes = null;
  let product = null;
  for (const cand of productCandidates) {
    const res = await fetchText(cand, opts);
    if (!productRes && res.ok) { productRes = res; productUrl = cand; } // keep first reachable page for SSR check
    if (res.ok) {
      const node = findProductNode(extractJsonLd(res.body));
      if (node) { product = node; productRes = res; productUrl = cand; break; } // first page with real schema wins
    }
  }
  if (productUrl) { try { origin = new URL(productUrl).origin; } catch { /* keep */ } }

  // 4) product schema completeness
  const schemaFields = [
    ["name", (p) => !!get(p, "name")],
    ["description", (p) => !!get(p, "description")],
    ["image", (p) => !!get(p, "image")],
    ["brand", (p) => !!get(p, "brand")],
    ["sku/gtin", (p) => { const has = (x) => !!(get(x, "sku") || get(x, "gtin13") || get(x, "gtin12") || get(x, "gtin") || get(x, "mpn") || get(x, "productID")); const v = variantOf(p); return has(p) || (v && has(v)); }],
    ["offers.price", (p) => firstOffer(p) && (get(firstOffer(p), "price") != null || get(firstOffer(p), "lowPrice") != null)],
    ["offers.availability", (p) => firstOffer(p) && !!get(firstOffer(p), "availability")],
    ["aggregateRating", (p) => !!get(p, "aggregateRating")],
  ];
  let schemaScore = 0;
  let present = [];
  let missing = [];
  if (product) {
    for (const [name, test] of schemaFields) {
      let ok = false;
      try { ok = !!test(product); } catch { ok = false; }
      (ok ? present : missing).push(name);
    }
    schemaScore = (present.length / schemaFields.length) * 30;
  } else {
    missing = schemaFields.map((f) => f[0]);
  }
  add({
    id: "product_schema",
    label: "Product schema (JSON-LD) completeness",
    max: 30,
    score: Math.round(schemaScore),
    status: !product ? "fail" : schemaScore >= 26 ? "pass" : schemaScore >= 15 ? "warn" : "fail",
    detail: !product
      ? productUrl
        ? "no Product JSON-LD found on product page"
        : "no product page discoverable to test"
      : `present: ${present.join(", ") || "none"}${missing.length ? ` | missing: ${missing.join(", ")}` : ""}`,
    fix: !product
      ? "Add schema.org/Product JSON-LD to product pages (name, offers.price, availability, brand, sku/gtin, image, description, aggregateRating)."
      : missing.length
      ? `Add the missing fields agents use to compare/verify: ${missing.join(", ")}.`
      : "",
  });

  // 5) SSR — is product data in raw HTML?
  let ssrStatus = "warn", ssrScore = 7, ssrDetail = "no product page to test";
  if (productRes && productRes.ok) {
    const raw = productRes.body || "";
    const hasLd = !!product;
    const hasPrice = /["'](price|lowPrice)["']\s*:/i.test(raw) || /\$\s?\d{1,3}(?:[.,]\d{2})?/.test(raw);
    if (hasLd || hasPrice) {
      ssrStatus = "pass"; ssrScore = 15;
      ssrDetail = "product data present in server-rendered HTML";
    } else {
      ssrStatus = "fail"; ssrScore = 0;
      ssrDetail = "product page looks JS-rendered — agents see an empty shell (JS content fails AI parsing ~77% of the time)";
    }
  }
  add({
    id: "ssr",
    label: "Server-rendered product data",
    max: 15,
    score: ssrScore,
    status: ssrStatus,
    detail: ssrDetail,
    fix: ssrStatus === "fail" ? "Server-render (SSR/SSG) price, title, availability and JSON-LD so non-JS AI crawlers can read them." : "",
  });

  // 6) feed / sitemap
  const sm = await fetchText(origin + "/sitemap.xml", opts);
  const hasSitemap = sm.ok && /<(urlset|sitemapindex)/i.test(sm.body);
  const hasProductSitemap = hasSitemap && /product/i.test(sm.body);
  let feedScore = 0;
  if (hasSitemap) feedScore += 5;
  if (hasProductSitemap || productsJsonOk) feedScore += 5;
  add({
    id: "feed_sitemap",
    label: "Product feed / sitemap availability",
    max: 10,
    score: feedScore,
    status: feedScore >= 10 ? "pass" : feedScore >= 5 ? "warn" : "fail",
    detail: `${hasSitemap ? "sitemap.xml ✓" : "no sitemap.xml"}${productsJsonOk ? ", products.json ✓" : hasProductSitemap ? ", product sitemap ✓" : ""}`,
    fix:
      feedScore < 10
        ? "Expose a product feed (ACP/Google Merchant format: CSV/TSV/XML/JSON with id, title, price, availability, GTIN) and a product sitemap; refresh ≤15min."
        : "",
  });

  // 7) llms.txt (honest minor signal)
  const llms = await fetchText(origin + "/llms.txt", opts);
  const hasLlms = llms.ok && llms.status === 200 && llms.body.trim().length > 0 && /<!doctype|<html/i.test(llms.body) === false;
  add({
    id: "llms_txt",
    label: "llms.txt present",
    max: 5,
    score: hasLlms ? 5 : 0,
    status: hasLlms ? "pass" : "info",
    detail: hasLlms ? "llms.txt found" : "no llms.txt (minor — mostly used in the agentic/B2A layer, not search citation)",
    fix: hasLlms ? "" : "Add /llms.txt summarizing catalog + key links. Low effort; helps agentic/B2A navigation (don't expect search-citation lift).",
  });

  // 8) operational legibility — shipping/returns policy
  const lc = (home.body || "").toLowerCase();
  const hasShipping = /href=["'][^"']*(shipping|delivery)[^"']*["']/i.test(home.body) || lc.includes("shipping policy");
  const hasReturns = /href=["'][^"']*(returns?|refund)[^"']*["']/i.test(home.body) || lc.includes("return policy") || lc.includes("refund policy");
  const offerHasShip = product && firstOffer(product) && !!get(firstOffer(product), "shippingDetails");
  const offerHasReturn = product && firstOffer(product) && !!get(firstOffer(product), "hasMerchantReturnPolicy");
  let polScore = (hasShipping ? 5 : 0) + (hasReturns ? 5 : 0);
  if (offerHasShip) polScore = Math.min(10, polScore + 2);
  if (offerHasReturn) polScore = Math.min(10, polScore + 2);
  add({
    id: "legibility",
    label: "Operational legibility (shipping/returns)",
    max: 10,
    score: Math.min(10, polScore),
    status: polScore >= 10 ? "pass" : polScore >= 5 ? "warn" : "fail",
    detail: `${hasShipping ? "shipping ✓" : "shipping policy not linked"}, ${hasReturns ? "returns ✓" : "returns policy not linked"}${offerHasShip ? ", structured shippingDetails ✓" : ""}${offerHasReturn ? ", structured returnPolicy ✓" : ""}`,
    fix:
      polScore < 10
        ? "Publish clear, consistent shipping & returns terms and encode them in Offer.shippingDetails / hasMerchantReturnPolicy — agents skip ambiguous offers."
        : "",
  });

  // ---------- total ----------
  const scored = checks.filter((c) => c.max > 0);
  const total = scored.reduce((a, c) => a + c.score, 0);
  const maxTotal = scored.reduce((a, c) => a + c.max, 0);
  const score = Math.round((total / maxTotal) * 100);

  return {
    url: url.toString(),
    finalUrl: home.finalUrl,
    fetchedAt: new Date().toISOString(),
    reachable,
    platform,
    productUrlTested: productUrl,
    score,
    grade: grade(score),
    checks,
    topFixes: checks
      .filter((c) => c.fix && c.status !== "pass" && c.status !== "info")
      .sort((a, b) => (b.max - b.score) - (a.max - a.score))
      .slice(0, 5)
      .map((c) => ({ label: c.label, fix: c.fix, impact: c.max - c.score })),
  };
}

// ---------- text renderer ----------
export function renderText(r) {
  const bar = (s, m) => {
    const n = Math.round((s / m) * 10);
    return "[" + "#".repeat(n) + "-".repeat(10 - n) + "]";
  };
  const icon = (st) => ({ pass: "PASS", warn: "WARN", fail: "FAIL", info: "INFO" }[st] || st);
  const lines = [];
  lines.push("");
  lines.push(`AgentReady — AI Shopping-Agent Readiness`);
  lines.push(`Store : ${r.finalUrl}`);
  lines.push(`Platform: ${r.platform}${r.productUrlTested ? `  | product tested: ${r.productUrlTested}` : ""}`);
  lines.push(`SCORE : ${r.score}/100  (grade ${r.grade})`);
  lines.push("-".repeat(64));
  for (const c of r.checks) {
    const sc = c.max > 0 ? `${String(c.score).padStart(2)}/${c.max}` : "  · ";
    lines.push(`${icon(c.status).padEnd(4)} ${c.max > 0 ? bar(c.score, c.max) : "          "} ${sc}  ${c.label}`);
    if (c.detail) lines.push(`        ${c.detail}`);
  }
  lines.push("-".repeat(64));
  if (r.topFixes.length) {
    lines.push("TOP FIXES (highest impact first):");
    r.topFixes.forEach((f, i) => lines.push(`  ${i + 1}. (+${f.impact}) ${f.fix}`));
  } else {
    lines.push("No high-impact fixes — store is largely agent-ready.");
  }
  lines.push("");
  return lines.join("\n");
}
