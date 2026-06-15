#!/usr/bin/env node
// AgentReady batch runner — scan many stores, emit CSV + an aggregate summary
// for the "I scanned N stores" proof post (the distribution engine).
//
// Usage:
//   node src/batch.mjs                       # scans the built-in sample list
//   node src/batch.mjs urls.txt              # one URL per line (# comments ok)
//   node src/batch.mjs urls.txt --concurrency=6 --out=out
import { scanStore } from "./scan.mjs";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const SAMPLE = ["allbirds.com", "gymshark.com", "manduka.com", "brooklinen.com", "helixsleep.com"];

function parseArgs() {
  const a = process.argv.slice(2);
  const file = a.find((x) => !x.startsWith("--"));
  const conc = Number((a.find((x) => x.startsWith("--concurrency=")) || "").split("=")[1]) || 3;
  const outDir = (a.find((x) => x.startsWith("--out=")) || "").split("=")[1] || "out";
  const delay = Number((a.find((x) => x.startsWith("--delay=")) || "").split("=")[1]) || 600;
  return { file, conc, outDir, delay };
}

async function pool(items, n, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(n, items.length) || 1 }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx]);
      process.stdout.write(".");
    }
  });
  await Promise.all(runners);
  process.stdout.write("\n");
  return results;
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

(async () => {
  const { file, conc, outDir, delay } = parseArgs();
  let urls = SAMPLE;
  if (file && existsSync(file)) {
    urls = readFileSync(file, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  }
  console.log(`Scanning ${urls.length} stores (concurrency ${conc}, ${delay}ms/host)…`);

  const rows = await pool(urls, conc, async (url) => {
    try {
      const r = await scanStore(url, { timeout: 12000, minHostInterval: delay });
      const c = (id) => r.checks.find((x) => x.id === id) || { score: 0, status: "" };
      return {
        url, ok: true, score: r.score, grade: r.grade, platform: r.platform,
        schema: c("product_schema").score, crawler: c("crawler_access").score,
        ssr: c("ssr").status, feed: c("feed_sitemap").score, tested: r.productUrlTested || "",
      };
    } catch (e) {
      return { url, ok: false, error: String((e && e.message) || e) };
    }
  });

  const ok = rows.filter((r) => r.ok);
  const audited = ok.filter((r) => r.tested);          // a real product page was evaluated
  const couldNotAudit = ok.filter((r) => !r.tested);   // no externally-discoverable product page
  const scores = ok.map((r) => r.score);
  const grades = {};
  for (const r of ok) grades[r.grade] = (grades[r.grade] || 0) + 1;
  const A = audited.length || 1;
  const noSchema = audited.filter((r) => r.schema === 0).length;          // confirmed: live page, zero JSON-LD
  const partialSchema = audited.filter((r) => r.schema > 0 && r.schema < 26).length;
  const fullSchema = audited.filter((r) => r.schema >= 26).length;        // ~complete, agent-ready
  const blockBots = ok.filter((r) => r.crawler < 20).length;
  const ssrFail = audited.filter((r) => r.ssr === "fail").length;
  const noFeed = ok.filter((r) => r.feed < 10).length;
  const platforms = {};
  for (const r of ok) platforms[r.platform] = (platforms[r.platform] || 0) + 1;

  mkdirSync(outDir, { recursive: true });
  const header = "url,ok,score,grade,platform,schema,crawler,ssr,feed,tested,error";
  const csv = [header]
    .concat(rows.map((r) => [r.url, r.ok, r.score, r.grade, r.platform, r.schema, r.crawler, r.ssr, r.feed, r.tested, r.error].map(csvCell).join(",")))
    .join("\n");
  writeFileSync(`${outDir}/results.csv`, csv);

  const md = `# Agent-Readiness — batch scan (${new Date().toISOString().slice(0, 10)})
Scanned **${urls.length}** stores · **${ok.length}** reachable · **${audited.length}** had a discoverable product page to audit.

- **Median readiness score:** ${median(scores)}/100
- **Complete, agent-ready schema:** ${pct(fullSchema, A)}% of audited (${fullSchema}/${audited.length})
- **Partial schema** (missing fields agents compare on): ${pct(partialSchema, A)}% of audited
- **CONFIRMED no product schema** (live product page, zero JSON-LD): ${pct(noSchema, A)}% of audited (${noSchema}/${audited.length})
- **No externally-discoverable product page** (headless/custom or blocking — agents may struggle too): ${couldNotAudit.length}/${ok.length}
- **Blocking >=1 AI crawler:** ${pct(blockBots, ok.length)}%
- **JS-only product page (fails AI parsing):** ${pct(ssrFail, A)}% of audited
- **No product feed / sitemap:** ${pct(noFeed, ok.length)}%
- **Grades:** ${Object.entries(grades).sort().map(([g, n]) => `${g}:${n}`).join("  ")}
- **Platforms:** ${Object.entries(platforms).map(([p, n]) => `${p}:${n}`).join("  ")}

> **Headline draft (defensible):** "I audited ${audited.length} specialty-coffee product pages for AI-shopping readiness. Only ${pct(fullSchema, A)}% have complete, agent-ready schema; ${pct(noSchema, A)}% have a live product page with ZERO structured data — invisible to ChatGPT/Gemini. Median readiness ${median(scores)}/100."
`;
  writeFileSync(`${outDir}/summary.md`, md);
  console.log("\n" + md);
  console.log(`Wrote ${outDir}/results.csv and ${outDir}/summary.md`);
})();
