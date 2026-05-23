import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { countMessagesMatching } from "./lib/gws.ts";
import { Reporter } from "./lib/report.ts";
import { extractYearsArg, parseYearRange } from "./lib/years.ts";

export async function count(args: string[] = []): Promise<void> {
  const report = new Reporter("count");
  await mkdir("out", { recursive: true });

  const { fromYear, toYear } = parseYearRange(extractYearsArg(args));
  report.set("Year range", `${fromYear}–${toYear}`);

  console.log(
    `→ Counting by year (${fromYear}–${toYear}, ${toYear - fromYear + 1} years; this can take a minute)…`,
  );
  const years: Record<string, number> = {};
  const rows: string[] = [];
  for (let y = toYear; y >= fromYear; y--) {
    const q = `after:${y}/01/01 before:${y + 1}/01/01`;
    const n = await countMessagesMatching(q);
    years[String(y)] = n;
    rows.push(`| ${y} | ${n.toLocaleString()} |`);
    console.log(`  ${y}: ${n.toLocaleString()}`);
  }

  const total = Object.values(years).reduce((a, b) => a + b, 0);
  report.set("Mailbox messages counted", total.toLocaleString());
  report.add(`## By year\n\n| Year | Count |\n|---|---:|\n${rows.join("\n")}`);

  const json = {
    generatedAt: new Date().toISOString(),
    yearRange: { fromYear, toYear },
    years,
  };
  await writeFile("out/count.json", JSON.stringify(json, null, 2));
  const path = await report.finish();
  console.log(`\n✓ Wrote out/count.json. Report: ${path}`);
  console.log(
    "\nNext: `pnpm buckets` for Gmail-category counts, or in a Claude Code session say",
  );
  console.log(
    "  \"analyze baseline\" to get a Haiku recommendation on which slice to clean first.",
  );
}
