import "dotenv/config";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { listMessageIds, getMessageHeaders } from "./lib/gws.ts";
import { Reporter } from "./lib/report.ts";
import {
  extractYearsArg,
  gmailYearClause,
  parseYearRange,
  stripYearsFlag,
} from "./lib/years.ts";

const OUTPUT_DIR = "out";
const HEADERS_FILE = `${OUTPUT_DIR}/headers.jsonl`;
const CONCURRENCY = Number(process.env.CLEANUP_CONCURRENCY ?? 8);
const DEFAULT_QUERY = "in:anywhere -in:chats";

async function loadAlreadyFetched(): Promise<Set<string>> {
  try {
    const txt = await readFile(HEADERS_FILE, "utf8");
    return new Set(
      txt
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).id as string),
    );
  } catch {
    return new Set();
  }
}

async function runPool<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const idx = i++;
      const item = items[idx]!;
      try {
        await worker(item);
      } catch (err) {
        console.warn(`  ⚠ failed ${String(item)}: ${(err as Error).message}`);
      }
    }
  });
  await Promise.all(runners);
}

/**
 * Build the effective Gmail query from CLI args. Positional argument
 * (if any) is treated as the base query; --years adds an after:/before:
 * clause on top.
 *
 *   pnpm fetch                                  → DEFAULT_QUERY
 *   pnpm fetch "category:promotions"            → that query
 *   pnpm fetch --years 2025                     → DEFAULT_QUERY + year clause
 *   pnpm fetch "category:promotions" --years 5  → both combined
 */
function buildQuery(args: string[]): string {
  const positional = stripYearsFlag(args)[0];
  const base = positional ?? DEFAULT_QUERY;
  const yearsArg = extractYearsArg(args);
  if (!yearsArg) return base;
  const { fromYear, toYear } = parseYearRange(yearsArg);
  return `${base} ${gmailYearClause(fromYear, toYear)}`;
}

export async function fetchHeaders(args: string[] = []): Promise<void> {
  const query = buildQuery(args);
  const report = new Reporter("fetch");
  report.set("Query", `\`${query}\``);
  report.set("Concurrency", CONCURRENCY);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const already = await loadAlreadyFetched();
  const max = Number(process.env.CLEANUP_MAX_MESSAGES ?? 0) || Infinity;

  console.log(`→ Listing message IDs (query: ${query})`);
  if (already.size) console.log(`  Resuming — ${already.size.toLocaleString()} already on disk`);

  const out = createWriteStream(HEADERS_FILE, { flags: "a" });
  let written = 0;
  let pageToken: string | undefined;

  do {
    const { ids, nextPageToken } = await listMessageIds(query, pageToken);
    pageToken = nextPageToken;
    const todo = ids.filter((id) => !already.has(id));
    if (!todo.length) continue;

    process.stdout.write(`  page: ${todo.length} new, fetching headers… `);
    await runPool(todo, async (id) => {
      if (written >= max) return;
      const msg = await getMessageHeaders(id);
      out.write(JSON.stringify(msg) + "\n");
      written++;
    });
    process.stdout.write(`total ${written}\n`);
    if (written >= max) {
      console.log(`  hit CLEANUP_MAX_MESSAGES=${max}, stopping`);
      break;
    }
  } while (pageToken);

  out.end();

  report.set("New headers written", written.toLocaleString());
  report.set("Total headers on disk", (already.size + written).toLocaleString());
  const path = await report.finish();
  console.log(`\n✓ Wrote ${written} new header records to ${HEADERS_FILE}. Report: ${path}`);
}
