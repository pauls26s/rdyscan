#!/usr/bin/env node
// AgentReady report generator — turn a live scan into a client-ready Markdown audit.
// Usage: node src/report.mjs <store-url> [outDir]   (default outDir = "reports")
import { scanStore } from "./scan.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const ICON = { pass: "✅ PASS", warn: "⚠️ WARN", fail: "❌ FAIL", info: "ℹ️ INFO" };

function brand(host) {
  return host.replace(/^www\./, "");
}
function missingFields(report) {
  const s = report.checks.find((c) => c.id === "product_schema");
  const m = s && /missing:\s*([^|]+)/i.exec(s.detail || "");
  return m ? m[1].trim() : "";
}
function bottomLine(r) {
  const b = brand(new URL(r.finalUrl || r.url).hostname);
  if (!r.reachable) return `We could not reach ${b} as an AI crawler would — it may be blocked or down for agent traffic, which means zero AI-shopping visibility.`;
  const schema = r.checks.find((c) => c.id === "product_schema");
  if (!r.productUrlTested) return `We couldn't find a machine-readable product page on ${b}. AI shopping agents hit the same wall — if they can't reach a product page, they can't recommend or transact it.`;
  if (schema.score === 0) return `${b} is reachable, but its product pages expose **no structured data (JSON-LD)**. AI agents (ChatGPT, Gemini, Perplexity) read schema, not your design — so they can't see your prices, availability, or reviews, and skip you for competitors who are legible.`;
  if (schema.score < 26) { const mf = missingFields(r); return `${b}'s product schema is **incomplete**${mf ? ` (missing ${mf})` : ""}. Those are the exact fields agents use to compare and recommend products — without them you're under-represented in AI results.`; }
  if (r.score >= 85) return `${b} is **largely agent-ready** — a strong base. A few targeted fixes will close the remaining gap to an A.`;
  return `${b} has partial AI-shopping readiness with clear, fixable gaps below.`;
}
function platformPath(r) {
  switch (r.platform) {
    case "shopify": return "**Shopify:** apply at chatgpt.com/merchants and enable the ChatGPT sales channel; UCP is handled by Agentic Storefronts as it rolls out. Your real gap is usually **schema depth + content**, not the channel toggle — the fixes below.";
    case "woocommerce": return "**WooCommerce:** schema, feeds, and crawler access are all on you (no native agent channel). This is high-effort but high-leverage — exactly where outside help pays for itself.";
    case "squarespace": return "**Squarespace:** commerce schema is partial by default and product grids are JS-rendered. Add complete Product JSON-LD and a clean product feed; confirm AI crawlers aren't blocked.";
    case "bigcommerce": return "**BigCommerce:** supports feeds/channels but needs manual schema completion and AI-crawler verification.";
    default: return "**Custom / headless stack:** you control (and must build) schema, server-rendering, feeds, and crawler access. Highest manual effort — which is exactly why a structured audit matters most here.";
  }
}

function buildReport(r) {
  const host = new URL(r.finalUrl || r.url).hostname;
  const b = brand(host);
  const date = new Date().toISOString().slice(0, 10);
  const top = r.topFixes && r.topFixes.length
    ? r.topFixes.map((f, i) => `${i + 1}. **(+${f.impact})** ${f.fix}`).join("\n")
    : "No high-impact fixes — store is largely agent-ready.";
  const rows = r.checks
    .filter((c) => c.max > 0)
    .map((c) => `| ${ICON[c.status] || c.status} | ${c.label} | ${c.score}/${c.max} | ${c.detail || ""} |`)
    .join("\n");

  return `# Agent-Readiness Audit — ${b}

${r.finalUrl || r.url} · ${date} · prepared by **AgentReady**

## Headline
- **Agent-Readiness Score:** ${r.score}/100 — grade **${r.grade}**
- **Platform:** ${r.platform}
- **Product page audited:** ${r.productUrlTested || "_none discoverable externally_"}
- **Bottom line:** ${bottomLine(r)}

## Why this matters now
AI now drives ~$20.9B in US retail (≈4x year-over-year) and AI traffic converts **31–42% better** than normal search — but agents don't read your storefront, they read your **structured data, server HTML, and feeds**. Stores that aren't agent-legible get reduced to inventory for someone else's platform. Most competitors haven't fixed this yet; the window is now.

## What we found
| Check | Item | Score | Detail |
|---|---|---|---|
${rows}

## Prioritized fixes (highest impact first)
${top}

## Platform-specific path
${platformPath(r)}

## Live visibility test — DO BEFORE SENDING (manual, ~5 min)
The score above measures *readiness*; this measures *reality*. Ask each assistant these and note whether **${b}** surfaces:
- [ ] ChatGPT / Gemini / Perplexity: "best [your category] coffee under $25"
- [ ] "${b} vs [a competitor]"
- [ ] "where to buy [your flagship product]"
> If ${b} is invisible even for its own brand + product queries, lead the conversation with that — it's the most visceral proof.

## What "done" looks like
- **Target:** 90+ (grade A) within 30–60 days.
- **Re-audit monthly** to catch silent regressions (e.g. a Cloudflare update re-blocking GPTBot, or a theme update dropping schema).

## Options
1. **DIY** — this report has everything; implement it yourself.
2. **Done-for-you** — we implement the fixes above and re-audit you to an A. Flat fee.
3. **Monitoring** — monthly re-audit + AI-visibility tracking + regression alerts.
4. **Agencies** — white-label this report + a multi-store dashboard.

---
*Methodology: automated external checks via the AgentReady scanner (AI-crawler access, JSON-LD Product completeness, server-rendering, feed/sitemap, operational legibility, platform). Live-visibility test performed manually. Figures: Adobe / Salesforce / McKinsey / BrightEdge / OpenAI ACP, 2025–2026. Snapshot as of ${date}.*
`;
}

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const outDir = args.filter((a) => !a.startsWith("--"))[1] || "reports";
if (!url) { console.error("Usage: node src/report.mjs <store-url> [outDir]"); process.exit(2); }

try {
  const r = await scanStore(url);
  const host = new URL(r.finalUrl || r.url).hostname.replace(/^www\./, "");
  const slug = host.replace(/[^a-z0-9]+/gi, "-");
  mkdirSync(outDir, { recursive: true });
  const path = `${outDir}/${slug}.md`;
  writeFileSync(path, buildReport(r));
  console.log(`${url.padEnd(28)} → ${r.score}/100 ${r.grade}  (${r.productUrlTested ? "audited" : "no product page"})  ${path}`);
} catch (err) {
  console.error(`${url}: scan failed — ${err && err.message ? err.message : err}`);
  process.exit(1);
}
