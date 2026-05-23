import { readFile } from "node:fs/promises";

const DEFAULT_YEAR_LOOKBACK = Number(process.env.CLEANUP_YEAR_LOOKBACK ?? 10);

/**
 * Parse the --years flag value.
 *
 * Accepts:
 *   undefined        → last N years (env CLEANUP_YEAR_LOOKBACK, default 10)
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

/** Extract `--years VALUE` or `--years=VALUE` from a CLI argv array. */
export function extractYearsArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--years" || a === "-y") return args[i + 1];
    if (a.startsWith("--years=")) return a.slice("--years=".length);
  }
  return undefined;
}

/**
 * Read `headers.jsonl` and return the set of message IDs whose internalDate
 * falls inside [fromYear, toYear] inclusive (UTC).
 *
 * Used by `plan` and `execute` to filter `decisions.jsonl` by year range.
 */
export async function idsInYearRange(
  headersFile: string,
  fromYear: number,
  toYear: number,
): Promise<Set<string>> {
  const txt = await readFile(headersFile, "utf8");
  const ids = new Set<string>();
  for (const line of txt.split("\n")) {
    if (!line) continue;
    const m = JSON.parse(line);
    if (!m?.internalDate) continue;
    const year = new Date(Number(m.internalDate)).getUTCFullYear();
    if (year >= fromYear && year <= toYear) ids.add(m.id);
  }
  return ids;
}
