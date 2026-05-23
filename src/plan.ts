import { readFile, writeFile, mkdir } from "node:fs/promises";
import { GMAIL_MODIFY_BATCH_SIZE } from "./lib/gws.ts";
import { Reporter } from "./lib/report.ts";
import {
  extractYearsArg,
  idsInYearRange,
  parseYearRange,
} from "./lib/years.ts";
import type { Action, Decision } from "./lib/types.ts";

const PLAN_TOP_N = Number(process.env.PLAN_TOP_N ?? 25);
const SECONDS_PER_BATCH = Number(process.env.CLEANUP_SECONDS_PER_BATCH ?? 2);
const DECISIONS_FILE = "out/decisions.jsonl";
const HEADERS_FILE = "out/headers.jsonl";

interface SenderRollup {
  senderEmail: string;
  count: number;
  actions: Partial<Record<Action, number>>;
  topAction: Action;
  exampleReasons: string[];
}

function senderFromHeaders(_msg: unknown, decision: Decision, fromIndex: Map<string, string>): string {
  return fromIndex.get(decision.id) ?? "unknown";
}

async function loadDecisions(): Promise<Decision[]> {
  const txt = await readFile(DECISIONS_FILE, "utf8");
  return txt
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Decision);
}

async function loadFromMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const txt = await readFile("out/headers.jsonl", "utf8");
    for (const line of txt.split("\n").filter(Boolean)) {
      const h = JSON.parse(line);
      const from: string | undefined = h.headers?.from;
      if (from) {
        const match = from.match(/<([^>]+)>/) ?? from.match(/([\w.+-]+@[\w.-]+)/);
        map.set(h.id, (match?.[1] ?? from).toLowerCase());
      }
    }
  } catch {
    // headers cache missing — sender rollup will be empty
  }
  return map;
}

function rollupBySender(
  decisions: Decision[],
  fromMap: Map<string, string>,
): SenderRollup[] {
  const map = new Map<string, SenderRollup>();
  for (const d of decisions) {
    const sender = senderFromHeaders(null, d, fromMap);
    let row = map.get(sender);
    if (!row) {
      row = {
        senderEmail: sender,
        count: 0,
        actions: {},
        topAction: d.action,
        exampleReasons: [],
      };
      map.set(sender, row);
    }
    row.count++;
    row.actions[d.action] = (row.actions[d.action] ?? 0) + 1;
    if (row.exampleReasons.length < 2 && d.reason) {
      row.exampleReasons.push(d.reason);
    }
  }
  for (const row of map.values()) {
    const best = (Object.entries(row.actions) as [Action, number][]).sort(
      ([, a], [, b]) => b - a,
    )[0];
    if (best) row.topAction = best[0];
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function table(rollup: SenderRollup[]): string {
  if (!rollup.length) return "_(none)_";
  const head = "| Sender | Count | Top action | Reasons |\n|---|---:|---|---|";
  const rows = rollup.slice(0, PLAN_TOP_N).map((r) => {
    const actions = (Object.entries(r.actions) as [Action, number][])
      .map(([a, n]) => `${a}:${n}`)
      .join(" ");
    const reasons = r.exampleReasons.join("; ").slice(0, 120);
    return `| \`${r.senderEmail}\` | ${r.count} | ${actions} | ${reasons} |`;
  });
  return [head, ...rows].join("\n");
}

export async function plan(args: string[] = []): Promise<void> {
  const report = new Reporter("plan");
  await mkdir("out", { recursive: true });

  const yearsArg = extractYearsArg(args);
  const yearRange = yearsArg ? parseYearRange(yearsArg) : undefined;

  let allDecisions = await loadDecisions().catch(() => {
    throw new Error(
      `No decisions found at ${DECISIONS_FILE}. Run the classification step in a Claude Code session first.`,
    );
  });

  if (yearRange) {
    const inRange = await idsInYearRange(
      HEADERS_FILE,
      yearRange.fromYear,
      yearRange.toYear,
    ).catch(() => {
      throw new Error(
        `--years requires ${HEADERS_FILE} to resolve message dates. Run pnpm fetch first.`,
      );
    });
    const before = allDecisions.length;
    allDecisions = allDecisions.filter((d) => inRange.has(d.id));
    console.log(
      `→ Year filter ${yearRange.fromYear}–${yearRange.toYear}: ${allDecisions.length.toLocaleString()} of ${before.toLocaleString()} decisions kept.`,
    );
    report.set("Year filter", `${yearRange.fromYear}–${yearRange.toYear}`);
    report.set("Decisions in range", allDecisions.length.toLocaleString());
    report.set("Decisions filtered out", (before - allDecisions.length).toLocaleString());
  }

  const decisions = allDecisions;
  const fromMap = await loadFromMap();

  const byAction = new Map<Action, Decision[]>();
  for (const d of decisions) {
    if (!byAction.has(d.action)) byAction.set(d.action, []);
    byAction.get(d.action)!.push(d);
  }

  const trashIds = byAction.get("trash") ?? [];
  const unsubIds = byAction.get("unsubscribe") ?? [];
  const archiveIds = byAction.get("archive") ?? [];
  const reviewIds = byAction.get("needs_review") ?? [];

  const destructiveTotal = trashIds.length + unsubIds.length;
  const batches = Math.ceil(destructiveTotal / GMAIL_MODIFY_BATCH_SIZE);
  const etaSec = batches * SECONDS_PER_BATCH;
  const etaMin = Math.ceil(etaSec / 60);

  const rollup = rollupBySender(decisions, fromMap);
  const trashRollup = rollup.filter((r) => r.topAction === "trash");
  const reviewRollup = rollup.filter((r) => r.topAction === "needs_review");

  const md = `# Gmail Cleanup Plan

_Generated ${new Date().toISOString()}_

## Summary

| Action | Messages |
|---|---:|
| Trash | ${trashIds.length.toLocaleString()} |
| Unsubscribe (then trash) | ${unsubIds.length.toLocaleString()} |
| Archive | ${archiveIds.length.toLocaleString()} |
| Needs review | ${reviewIds.length.toLocaleString()} |
| **Total decisions** | **${decisions.length.toLocaleString()}** |

- **Execution estimate:** ${batches} batches of ${GMAIL_MODIFY_BATCH_SIZE} (~${etaMin} min)
- **All moves go to Trash** — Gmail retains for 30 days, fully recoverable.

## Top ${PLAN_TOP_N} trash senders

${table(trashRollup)}

## Senders that need manual review

${table(reviewRollup)}

## Approval gate

This plan is **read-only**. No messages have been modified. To execute:

\`\`\`
pnpm cleanup execute --confirm
\`\`\`

Re-run \`pnpm cleanup plan\` any time \`out/decisions.jsonl\` changes.
`;

  await writeFile("out/cleanup_plan.md", md);

  report.set("Total decisions", decisions.length);
  report.set("Trash", trashIds.length);
  report.set("Unsubscribe", unsubIds.length);
  report.set("Archive", archiveIds.length);
  report.set("Needs review", reviewIds.length);
  report.add(`## Top trash senders\n\n${table(trashRollup)}`);
  const path = await report.finish();
  console.log(`✓ Wrote out/cleanup_plan.md. Report: ${path}`);
}
