import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { listMessageIds } from "./lib/gws.ts";
import { Reporter } from "./lib/report.ts";

const DEFAULT_YEAR_LOOKBACK = Number(process.env.CLEANUP_YEAR_LOOKBACK ?? 10);

const GMAIL_CATEGORIES = [
  "category:promotions",
  "category:social",
  "category:updates",
  "category:forums",
];

/**
 * Parse the --years flag.
 *
 * Accepts:
 *   undefined       → last N years (env CLEANUP_YEAR_LOOKBACK, default 10)
 *   "10" or "10year" → last 10 years
 *   "2010-2026" or "2026-2010" → explicit inclusive range (auto-sorted)
 */
export function parseYearRange(arg: string | undefined): {
  fromYear: number;
  toYear: number;
} {
  const currentYear = new Date().getUTCFullYear();
  if (!arg) {
    return { fromYear: currentYear - DEFAULT_YEAR_LOOKBACK, toYear: currentYear };
  }
  const lookback = arg.match(/^(\d+)(?:year)?s?$/i);
  if (lookback) {
    const n = Number(lookback[1]);
    return { fromYear: currentYear - n, toYear: currentYear };
  }
  const range = arg.match(/^(\d{4})[\s_-]+(\d{4})$/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return { fromYear: Math.min(a, b), toYear: Math.max(a, b) };
  }
  throw new Error(
    `Invalid --years value: "${arg}". Examples: "10", "10year", "2010-2026", "2026-2010".`,
  );
}

function extractYearsArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--years" || a === "-y") return args[i + 1];
    if (a.startsWith("--years=")) return a.slice("--years=".length);
  }
  return undefined;
}

async function countQuery(q: string): Promise<number> {
  let total = 0;
  let pageToken: string | undefined;
  do {
    const { ids, nextPageToken } = await listMessageIds(q, pageToken);
    total += ids.length;
    pageToken = nextPageToken;
  } while (pageToken);
  return total;
}

export async function baseline(args: string[] = []): Promise<void> {
  const report = new Reporter("baseline");
  await mkdir("out", { recursive: true });

  const { fromYear, toYear } = parseYearRange(extractYearsArg(args));
  report.set("Year range", `${fromYear}–${toYear}`);

  console.log(
    `→ Counting by year (${fromYear}–${toYear}, ${toYear - fromYear + 1} years; this can take a minute)…`,
  );
  const years: Record<string, number> = {};
  const yearRows: string[] = [];
  for (let y = toYear; y >= fromYear; y--) {
    const q = `after:${y}/01/01 before:${y + 1}/01/01`;
    const n = await countQuery(q);
    years[String(y)] = n;
    yearRows.push(`| ${y} | ${n.toLocaleString()} |`);
    console.log(`  ${y}: ${n.toLocaleString()}`);
  }

  console.log("\n→ Counting Gmail-classified bulk buckets…");
  const buckets: Record<string, number> = {};
  const bucketRows: string[] = [];
  for (const cat of GMAIL_CATEGORIES) {
    const n = await countQuery(cat);
    buckets[cat] = n;
    bucketRows.push(`| \`${cat}\` | ${n.toLocaleString()} |`);
    console.log(`  ${cat}: ${n.toLocaleString()}`);
  }

  const total = Object.values(years).reduce((a, b) => a + b, 0);
  report.set("Mailbox messages counted", total.toLocaleString());

  report.add(`## By year\n\n| Year | Count |\n|---|---:|\n${yearRows.join("\n")}`);
  report.add(`## Gmail categories\n\n| Bucket | Count |\n|---|---:|\n${bucketRows.join("\n")}`);

  const json = {
    generatedAt: new Date().toISOString(),
    yearRange: { fromYear, toYear },
    years,
    buckets,
  };
  await writeFile("out/baseline.json", JSON.stringify(json, null, 2));
  const path = await report.finish();
  console.log(`\n✓ Wrote out/baseline.json. Report: ${path}`);
  console.log(
    "\nNext: in a Claude Code session, say \"analyze baseline\" — a Haiku sub-agent will read",
  );
  console.log(
    "  out/baseline.json and recommend which year ranges or categories to target first.",
  );
}
