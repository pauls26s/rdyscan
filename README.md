# AgentReady scanner

Audit any e-commerce store for **AI shopping-agent readiness** — the signals that decide whether ChatGPT/Gemini/Perplexity agents can find, parse, trust, and transact your catalog. Zero runtime dependencies (Node ≥18, native `fetch`).

This is the OSS lead-magnet engine and product seed for AgentReady (see `../DIRECTION.md`).

## Usage
```bash
node src/cli.mjs <store-url>          # pretty report
node src/cli.mjs <store-url> --json   # machine-readable (for the web tool / CI gate)
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
- Next: cheerio parsing, multi-SKU sampling, LLM layer for description-quality + auto-fix generation, Shopify/Woo apps, scheduled monitoring.

## License
MIT.
