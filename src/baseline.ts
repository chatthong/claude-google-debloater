import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { listMessageIds } from "./lib/gws.ts";
import { Reporter } from "./lib/report.ts";

const YEAR_LOOKBACK = Number(process.env.CLEANUP_YEAR_LOOKBACK ?? 10);

const GMAIL_CATEGORIES = [
  "category:promotions",
  "category:social",
  "category:updates",
  "category:forums",
];

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

export async function baseline(): Promise<void> {
  const report = new Reporter("baseline");
  await mkdir("out", { recursive: true });

  console.log(`→ Counting by year (last ${YEAR_LOOKBACK} years; this can take a minute)…`);
  const thisYear = new Date().getUTCFullYear();
  const years: Record<string, number> = {};
  const yearRows: string[] = [];
  for (let y = thisYear; y >= thisYear - YEAR_LOOKBACK; y--) {
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

  const json = { generatedAt: new Date().toISOString(), years, buckets };
  await writeFile("out/baseline.json", JSON.stringify(json, null, 2));
  const path = await report.finish();
  console.log(`\n✓ Wrote out/baseline.json. Report: ${path}`);
}
