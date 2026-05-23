import { readFile } from "node:fs/promises";

const DEFAULT_YEAR_LOOKBACK = Number(process.env.CLEANUP_YEAR_LOOKBACK ?? 10);

/**
 * Parse the --years flag value.
 *
 * Accepts:
 *   undefined                  → last N years (env CLEANUP_YEAR_LOOKBACK, default 10)
 *   "5", "10"                  → last N years (1–3 digit lookback)
 *   "5year", "10years"         → last N years (explicit unit, any magnitude)
 *   "2025"                     → just that single year (4-digit shorthand)
 *   "2010-2026", "2026-2010"   → inclusive range, either direction (auto-sorted)
 */
export function parseYearRange(arg: string | undefined): {
  fromYear: number;
  toYear: number;
} {
  const currentYear = new Date().getUTCFullYear();
  if (!arg) {
    return { fromYear: currentYear - DEFAULT_YEAR_LOOKBACK, toYear: currentYear };
  }

  const explicitLookback = arg.match(/^(\d+)years?$/i);
  if (explicitLookback) {
    const n = Number(explicitLookback[1]);
    return { fromYear: currentYear - n, toYear: currentYear };
  }

  const range = arg.match(/^(\d{4})[\s_-]+(\d{4})$/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return { fromYear: Math.min(a, b), toYear: Math.max(a, b) };
  }

  const pure = arg.match(/^(\d+)$/);
  if (pure) {
    const n = Number(pure[1]);
    if (pure[1]!.length === 4) {
      return { fromYear: n, toYear: n };
    }
    return { fromYear: currentYear - n, toYear: currentYear };
  }

  throw new Error(
    `Invalid --years value: "${arg}". Examples: "5", "10year", "2025", "2010-2026".`,
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

/** Return the positional (non-flag) args, dropping flag values like the one after `--years`. */
export function stripYearsFlag(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--years" || a === "-y") {
      i++; // skip the value too
      continue;
    }
    if (a.startsWith("--years=")) continue;
    out.push(a);
  }
  return out;
}

/** Build a Gmail search clause for an inclusive year range. */
export function gmailYearClause(fromYear: number, toYear: number): string {
  return `after:${fromYear}/01/01 before:${toYear + 1}/01/01`;
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
