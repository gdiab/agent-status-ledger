#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { configPath, loadConfig } from "./config";
import { buildReport } from "./report";
import { annotateTrends, loadPreviousReport } from "./trends";
import { renderMarkdown } from "./render/markdown";
import { renderJson } from "./render/json";
import { renderHtml, HTML_LAYOUTS, type HtmlLayout } from "./render/html";
import { redact } from "./redact";
import { resolveApiKey, macKeychainLookup } from "./apikey";
import { formatDoctorReport, runDoctor, type Exec } from "./doctor";
import { makeSpawnExec } from "./exec";
import { homedir } from "node:os";
import { sendReportEmail } from "./email";
import { statusSummary } from "./render/rollup";

const USAGE = `usage: asl report [--since 24h] [--open] [--no-llm] [--no-email] [--out DIR] [--layout ${HTML_LAYOUTS.join("|")}]
       asl doctor`;

// Two exec seams, both timeout-bounded (src/exec.ts) so nothing can hang the
// unattended run:
// - spawnExec (60s) for doctor's checks and the email path — matches the
//   keychain lookup's bound in apikey.ts, and email's curl already self-caps
//   at --max-time 60, so 60s is the ceiling any legitimate caller needs.
// - engramExec (5s) for the engram enrichment calls — observed real latency
//   is ~60ms and a report run may make several calls per profile, so a hung
//   binary must fail fast rather than eat the 60s budget repeatedly.
const spawnExec: Exec = makeSpawnExec(60_000);
const engramExec: Exec = makeSpawnExec(5_000);

function runDoctorCli(): never {
  const cfgPath = configPath();
  const results = runDoctor({
    env: process.env,
    keychain: macKeychainLookup,
    exec: spawnExec,
    platform: process.platform,
    home: homedir(),
    configPath: cfgPath,
    config: loadConfig(cfgPath),
  });
  console.log(formatDoctorReport(results));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

function parseSince(s: string, now: Date): Date {
  const m = /^(\d+)([hd])$/.exec(s);
  if (!m) throw new Error(`--since must look like "24h" or "3d", got "${s}"`);
  const ms = Number(m[1]) * (m[2] === "h" ? 3600_000 : 86_400_000);
  return new Date(now.getTime() - ms);
}

function parseCliArgs() {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      allowPositionals: true,
      options: {
        since: { type: "string", default: "24h" },
        open: { type: "boolean", default: false },
        "no-llm": { type: "boolean", default: false },
        "no-email": { type: "boolean", default: false },
        out: { type: "string" },
        layout: { type: "string", default: "cards" },
      },
    });
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    console.error(USAGE);
    process.exit(2);
  }
}

async function main() {
  const { values, positionals } = parseCliArgs();
  if (positionals[0] === "doctor") runDoctorCli();
  if (positionals[0] !== "report") {
    console.error(USAGE);
    process.exit(2);
  }

  const layout = values.layout!;
  if (!(HTML_LAYOUTS as readonly string[]).includes(layout)) {
    console.error(`error: --layout must be ${HTML_LAYOUTS.map((l) => `"${l}"`).join(" or ")}, got "${layout}"`);
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

  // Cross-day trends: diff against the most recent prior report JSON in the
  // reports dir (the loader's strictly-older filter excludes today's file).
  // No usable history → annotateTrends is a no-op and output is unchanged.
  const day = now.toISOString().slice(0, 10);
  const previous = await loadPreviousReport(config.reportsDir, day);
  // The 5s-bounded engram seam gives the evidence-upgrade connector (opt-in
  // via connectors.engram.enabled) a working exec in the real CLI, not just
  // in tests. buildReport's own gate (evidence === "claimed_only" &&
  // config.connectors.engram.enabled) means this is inert unless the user
  // has opted in.
  const report = annotateTrends(
    await buildReport({ since, now, config, useLlm, apiKey, engramExec }),
    previous,
  );

  mkdirSync(config.reportsDir, { recursive: true });
  const base = join(config.reportsDir, day);
  const md = redact(renderMarkdown(report), config.redactPatterns);
  const json = redact(renderJson(report), config.redactPatterns);
  const html = redact(renderHtml(report, { layout: layout as HtmlLayout }), config.redactPatterns);
  await Bun.write(`${base}.md`, md);
  await Bun.write(`${base}.json`, json);
  await Bun.write(`${base}.html`, html);

  console.log(`agents: ${report.agents.length}, exceptions: ${report.exceptions.length}`);
  for (const a of report.exceptions) console.log(`  ! ${a.displayName} — ${a.status}`);
  console.log(`wrote ${base}.md ${base}.json ${base}.html`);

  if (config.email && !values["no-email"]) {
    const statuses = statusSummary(report);
    // Pure ASCII: an em dash would make the whole subject one RFC 2047
    // encoded word, and a populated status list pushes that past the
    // 75-char encoded-word limit.
    const subject = `ASL - ${day}${statuses ? `: ${statuses}` : ""}`;
    // Email is best-effort and must never block --open below; sendReportEmail
    // itself never throws, so no try/catch is needed here.
    const r = sendReportEmail(config.email, subject, md, html, {
      env: process.env,
      keychain: macKeychainLookup,
      exec: spawnExec,
      now,
    });
    if (r.ok) console.log(r.message);
    else console.error(`warning: ${r.message}`);
  }

  if (values.open) Bun.spawn(["open", `${base}.html`]);
}

main().catch((e) => {
  console.error(`error: ${e.message ?? e}`);
  process.exit(1);
});
