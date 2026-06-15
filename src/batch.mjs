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
  const conc = Number((a.find((x) => x.startsWith("--concurrency=")) || "").split("=")[1]) || 4;
  const outDir = (a.find((x) => x.startsWith("--out=")) || "").split("=")[1] || "out";
  return { file, conc, outDir };
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
  const { file, conc, outDir } = parseArgs();
  let urls = SAMPLE;
  if (file && existsSync(file)) {
    urls = readFileSync(file, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  }
  console.log(`Scanning ${urls.length} stores (concurrency ${conc})…`);

  const rows = await pool(urls, conc, async (url) => {
    try {
      const r = await scanStore(url, { timeout: 12000 });
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
  const scores = ok.map((r) => r.score);
  const grades = {};
  for (const r of ok) grades[r.grade] = (grades[r.grade] || 0) + 1;
  const noSchema = ok.filter((r) => r.schema === 0).length;
  const weakSchema = ok.filter((r) => r.schema < 15).length;
  const blockBots = ok.filter((r) => r.crawler < 20).length;
  const ssrFail = ok.filter((r) => r.ssr === "fail").length;
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
Scanned **${urls.length}** stores · **${ok.length}** reachable.

- **Median score:** ${median(scores)}/100
- **No product JSON-LD at all:** ${pct(noSchema, ok.length)}% (${noSchema}/${ok.length})
- **Missing / partial schema:** ${pct(weakSchema, ok.length)}%
- **Blocking >=1 AI crawler:** ${pct(blockBots, ok.length)}%
- **Product page JS-only (fails AI parsing):** ${pct(ssrFail, ok.length)}%
- **No proper feed / sitemap:** ${pct(noFeed, ok.length)}%
- **Grades:** ${Object.entries(grades).sort().map(([g, n]) => `${g}:${n}`).join("  ")}
- **Platforms:** ${Object.entries(platforms).map(([p, n]) => `${p}:${n}`).join("  ")}

> **Headline draft:** "I scanned ${ok.length} stores for AI-shopping readiness. ${pct(noSchema, ok.length)}% have **no product schema at all** — invisible to ChatGPT/Gemini shopping. Median readiness: ${median(scores)}/100."
`;
  writeFileSync(`${outDir}/summary.md`, md);
  console.log("\n" + md);
  console.log(`Wrote ${outDir}/results.csv and ${outDir}/summary.md`);
})();
