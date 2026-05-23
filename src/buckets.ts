import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { countMessagesMatching } from "./lib/gws.ts";
import { Reporter } from "./lib/report.ts";

const GMAIL_CATEGORIES = [
  "category:promotions",
  "category:social",
  "category:updates",
  "category:forums",
];

export async function buckets(): Promise<void> {
  const report = new Reporter("buckets");
  await mkdir("out", { recursive: true });

  console.log("→ Counting Gmail-classified bulk buckets…");
  const data: Record<string, number> = {};
  const rows: string[] = [];
  for (const cat of GMAIL_CATEGORIES) {
    const n = await countMessagesMatching(cat);
    data[cat] = n;
    rows.push(`| \`${cat}\` | ${n.toLocaleString()} |`);
    console.log(`  ${cat}: ${n.toLocaleString()}`);
  }

  const total = Object.values(data).reduce((a, b) => a + b, 0);
  report.set("Total in Gmail categories", total.toLocaleString());
  report.add(
    `## Gmail categories\n\n| Bucket | Count |\n|---|---:|\n${rows.join("\n")}`,
  );

  const json = { generatedAt: new Date().toISOString(), buckets: data };
  await writeFile("out/buckets.json", JSON.stringify(json, null, 2));
  const path = await report.finish();
  console.log(`\n✓ Wrote out/buckets.json. Report: ${path}`);
}
