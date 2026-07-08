#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config";
import { buildReport } from "./report";
import { renderMarkdown } from "./render/markdown";
import { renderJson } from "./render/json";
import { renderHtml } from "./render/html";
import { redact } from "./redact";
import { resolveApiKey, macKeychainLookup } from "./apikey";

const USAGE = "usage: asl report [--since 24h] [--open] [--no-llm] [--out DIR]";

function parseSince(s: string, now: Date): Date {
  const m = /^(\d+)([hd])$/.exec(s);
  if (!m) throw new Error(`--since must look like "24h" or "3d", got "${s}"`);
  const ms = Number(m[1]) * (m[2] === "h" ? 3600_000 : 86_400_000);
  return new Date(now.getTime() - ms);
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      since: { type: "string", default: "24h" },
      open: { type: "boolean", default: false },
      "no-llm": { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  if (positionals[0] !== "report") {
    console.error(USAGE);
    process.exit(2);
  }

  const config = loadConfig();
  if (values.out) config.reportsDir = values.out;
  const now = new Date();
  let since: Date;
  try {
    since = parseSince(values.since!, now);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    console.error(USAGE);
    process.exit(2);
  }
  const resolved = values["no-llm"] ? null : resolveApiKey(process.env, macKeychainLookup);
  const apiKey = resolved?.key;
  const useLlm = !values["no-llm"] && !!apiKey;
  if (!values["no-llm"]) {
    if (resolved) {
      console.error(`using API key from ${resolved.source}`);
    } else {
      console.error("note: no Anthropic API key found (env or keychain) — using template narratives");
    }
  }

  const report = await buildReport({ since, now, config, useLlm, apiKey });

  mkdirSync(config.reportsDir, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  const base = join(config.reportsDir, day);
  const md = redact(renderMarkdown(report), config.redactPatterns);
  const json = redact(renderJson(report), config.redactPatterns);
  const html = redact(renderHtml(report), config.redactPatterns);
  await Bun.write(`${base}.md`, md);
  await Bun.write(`${base}.json`, json);
  await Bun.write(`${base}.html`, html);

  console.log(`agents: ${report.agents.length}, exceptions: ${report.exceptions.length}`);
  for (const a of report.exceptions) console.log(`  ! ${a.displayName} — ${a.status}`);
  console.log(`wrote ${base}.md ${base}.json ${base}.html`);
  if (values.open) Bun.spawn(["open", `${base}.html`]);
}

main().catch((e) => {
  console.error(`error: ${e.message ?? e}`);
  process.exit(1);
});
