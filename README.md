# AgentReady scanner

Audit any e-commerce store for **AI shopping-agent readiness** — the signals that decide whether ChatGPT/Gemini/Perplexity agents can find, parse, trust, and transact your catalog. Zero runtime dependencies (Node ≥18, native `fetch`).

This is the OSS lead-magnet engine and product seed for AgentReady (see `../DIRECTION.md`).

## Example
```text
AgentReady — AI Shopping-Agent Readiness
Store : https://www.allbirds.com/   Platform: shopify
SCORE : 91/100  (grade A)
----------------------------------------------------------------
PASS [##########]  5/5   Reachable over HTTPS
PASS [##########] 20/20  AI crawler access (robots.txt)  — all major AI bots allowed
PASS [#########-] 26/30  Product schema (JSON-LD)         — missing: aggregateRating
PASS [##########] 15/15  Server-rendered product data
PASS [##########] 10/10  Product feed / sitemap           — sitemap.xml + products.json
WARN [#####-----]  5/10  Operational legibility           — shipping policy not linked
----------------------------------------------------------------
TOP FIX: publish structured shipping/returns in Offer.shippingDetails / hasMerchantReturnPolicy
```

## Live snapshot — specialty coffee roasters (102 stores, Jun 2026)
Batch scan (`node src/batch.mjs urls.txt`) of 102 specialty-coffee storefronts (84 Shopify, 5 WooCommerce, 3 Squarespace, 10 custom):
- **All 102 resolved; 90 had a discoverable product page** to audit. The other 12 were headless/custom/WAF-protected with no externally-reachable product page — a readiness signal in itself.
- **Only 36% of audited pages had complete, agent-ready schema** (32/90); another 42% had partial schema.
- **22% had a live product page with zero JSON-LD** (20/90) — invisible to ChatGPT/Gemini shopping, including recognizable names (Intelligentsia, Four Barrel, Wrecking Ball).
- Median readiness 86/100, but ~32% scored D or F. *(Snapshot; re-run for current numbers — external scans vary slightly.)*

## Usage
```bash
node src/cli.mjs <store-url>          # pretty report
node src/cli.mjs <store-url> --json   # machine-readable (for the web tool / CI gate)
node src/batch.mjs urls.txt            # scan many stores → out/results.csv + out/summary.md
node src/report.mjs <store-url> reports # generate a client-ready Markdown audit report
```
Exit code: `0` if score ≥ 70, else `1` (so it can gate agency pipelines / CI).

Programmatic:
```js
import { scanStore, renderText } from "./src/scan.mjs";
const report = await scanStore("yourstore.com");
console.log(renderText(report));
```

## What it checks (weighted to 100)
| Check | Max | What it verifies |
|---|---|---|
| AI crawler access | 20 | GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot, Google-Extended allowed in `robots.txt` |
| Product schema (JSON-LD) | 30 | `Product`/`ProductGroup` completeness: name, price, availability, brand, sku/gtin, image, description, rating |
| Server-rendered data | 15 | product price/schema present in raw HTML (not JS-only) |
| Feed / sitemap | 10 | `sitemap.xml`, product sitemap, Shopify `/products.json` |
| Operational legibility | 10 | shipping/returns policy present + structured in `Offer` |
| Platform detection | 5 | Shopify / WooCommerce / BigCommerce / Magento / custom |
| llms.txt | 5 | present (honest: minor, used in agentic/B2A layer) |
| Transport | 5 | reachable over HTTPS |
| Cloudflare AI-block flag | 0 | warns if Cloudflare may be auto-blocking AI bots |

## Verified behavior (smoke tests, Jun 2026)
| Store | Score | Note |
|---|---|---|
| manduka.com | 96 A | full schema |
| allbirds.com | 91 A | schema 26/30 (missing aggregateRating) |
| gymshark.com | 85 B | full schema (ProductGroup) |
| brooklinen.com | 70 C | **0/30 — no JSON-LD at all** (true finding; schema only in JS state) |
| helixsleep.com | 29 F | custom stack, JS-rendered |

## Known limitations (v1 prototype) — roadmap
- **Single product page** sampled; production should sample N SKUs.
- **Heuristic robots parsing** (root-path disallow); production should evaluate per-path rules.
- **Cloudflare AI-block is a flag**, not a confirmation (can't see the bot-specific WAF rule externally).
- **Detects JSON-LD only.** Stores with `@type:Product` buried in JS state (e.g. brooklinen) score 0 — which is correct for agent discovery, but a future version should say "schema present but not as crawlable JSON-LD" to sharpen the finding.
- No JS execution — by design (mirrors what non-rendering AI crawlers see).
- **Discovery gaps on headless/custom stores:** sites without `/products.json` and with JS-rendered homepages may yield no testable product page. This is reported honestly as "no product page discoverable" — **not** counted as confirmed missing schema.
- **Run-to-run variance / rate-limits:** external scans can hit transient `429`/resets; the scanner retries with backoff, but batch aggregates are a point-in-time snapshot. Space out re-scans of the same host.
- Next: cheerio parsing, multi-SKU sampling, LLM layer for description-quality + auto-fix generation, Shopify/Woo apps, scheduled monitoring.

## License
MIT.
