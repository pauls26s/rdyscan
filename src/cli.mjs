#!/usr/bin/env node
// AgentReady CLI — thin wrapper over scan.mjs.
// Usage: node src/cli.mjs <store-url> [--json]
import { scanStore, renderText } from "./scan.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const url = args.find((a) => !a.startsWith("--"));

if (!url) {
  console.error("Usage: node src/cli.mjs <store-url> [--json]");
  process.exit(2);
}

try {
  const report = await scanStore(url);
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderText(report));
  // exit code reflects readiness so it can gate CI / agency pipelines
  process.exit(report.score >= 70 ? 0 : 1);
} catch (err) {
  console.error("scan failed:", err && err.message ? err.message : err);
  process.exit(2);
}
