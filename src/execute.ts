import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { batchModify } from "./lib/gws.ts";
import { Reporter } from "./lib/report.ts";
import {
  extractYearsArg,
  idsInYearRange,
  parseYearRange,
} from "./lib/years.ts";
import type { Action, Decision } from "./lib/types.ts";

const DECISIONS_FILE = "out/decisions.jsonl";
const HEADERS_FILE = "out/headers.jsonl";
const TEST_BATCH_SIZE = 100;

const TRASH_ACTIONS: Action[] = ["trash", "unsubscribe"];
const ARCHIVE_ACTIONS: Action[] = ["archive"];

async function loadDecisions(): Promise<Decision[]> {
  const txt = await readFile(DECISIONS_FILE, "utf8");
  return txt
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Decision);
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const ans = (await rl.question(`${question} [yes/no]: `)).trim().toLowerCase();
      if (ans === "yes" || ans === "y") return true;
      if (ans === "no" || ans === "n") return false;
      console.log("Please type 'yes' or 'no'.");
    }
  } finally {
    rl.close();
  }
}

function partitionByAction(decisions: Decision[]): { trash: string[]; archive: string[] } {
  return {
    trash: decisions.filter((d) => TRASH_ACTIONS.includes(d.action)).map((d) => d.id),
    archive: decisions.filter((d) => ARCHIVE_ACTIONS.includes(d.action)).map((d) => d.id),
  };
}

export async function execute(args: string[]): Promise<void> {
  const test = args.includes("--test");
  const confirm = args.includes("--confirm");

  if (test && confirm) {
    console.error("--test and --confirm are mutually exclusive. Pick one.");
    process.exit(1);
  }
  if (!test && !confirm) {
    console.log(
      [
        "Refusing to run without --test or --confirm. This applies destructive Gmail changes.",
        "",
        "  pnpm cleanup execute --test       # apply first 100 actions, then ask yes/no to continue",
        "  pnpm cleanup execute --confirm    # full run, no prompt",
      ].join("\n"),
    );
    process.exit(1);
  }

  const report = new Reporter("execute");
  report.set("Mode", test ? "test (100-message smoke)" : "full");

  const yearsArg = extractYearsArg(args);
  const yearRange = yearsArg ? parseYearRange(yearsArg) : undefined;

  let decisions = await loadDecisions().catch(() => {
    throw new Error(
      `No decisions found at ${DECISIONS_FILE}. Run classify in a Claude Code session first.`,
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
    const before = decisions.length;
    decisions = decisions.filter((d) => inRange.has(d.id));
    console.log(
      `→ Year filter ${yearRange.fromYear}–${yearRange.toYear}: ${decisions.length.toLocaleString()} of ${before.toLocaleString()} decisions targeted.`,
    );
    report.set("Year filter", `${yearRange.fromYear}–${yearRange.toYear}`);
    report.set("Decisions in range", decisions.length);
    report.set("Decisions filtered out", before - decisions.length);
  }

  const { trash: allTrash, archive: allArchive } = partitionByAction(decisions);
  const labeledTotal = decisions.filter((d) => d.action.startsWith("label:")).length;

  console.log(
    `Plan: trash ${allTrash.length.toLocaleString()}, archive ${allArchive.length.toLocaleString()}, label-actions deferred ${labeledTotal.toLocaleString()}.`,
  );

  if (test) {
    const sample = allTrash.slice(0, TEST_BATCH_SIZE);
    console.log(`\n→ TEST MODE: trashing first ${sample.length} messages…`);
    if (sample.length) await batchModify(sample, { addLabelIds: ["TRASH"] });
    console.log("✓ Test batch trashed (recoverable for 30 days in Gmail UI).");

    report.set("Test batch trashed", sample.length);

    const proceed = await promptYesNo(
      `\nReview your Trash now. Continue with the remaining ${
        (allTrash.length - sample.length).toLocaleString()
      } trash + ${allArchive.length.toLocaleString()} archive?`,
    );
    if (!proceed) {
      report.set("Continued after test", "no — aborted by user");
      report.add(
        "## Outcome\n\nUser aborted after test batch. " +
          `${sample.length} messages were trashed; the rest are untouched. ` +
          "Recover from Gmail Trash if the test batch was wrong.",
      );
      const path = await report.finish();
      console.log(`Aborted. Report: ${path}`);
      return;
    }

    const remainingTrash = allTrash.slice(sample.length);
    console.log(`\n→ Trashing remaining ${remainingTrash.length.toLocaleString()}…`);
    if (remainingTrash.length) await batchModify(remainingTrash, { addLabelIds: ["TRASH"] });
    console.log(`→ Archiving ${allArchive.length.toLocaleString()}…`);
    if (allArchive.length) await batchModify(allArchive, { removeLabelIds: ["INBOX"] });

    report.set("Trashed (total)", allTrash.length);
    report.set("Archived", allArchive.length);
    report.set("Continued after test", "yes");
  } else {
    console.log(`\n→ Trashing ${allTrash.length.toLocaleString()} messages…`);
    if (allTrash.length) await batchModify(allTrash, { addLabelIds: ["TRASH"] });
    console.log(`→ Archiving ${allArchive.length.toLocaleString()} messages…`);
    if (allArchive.length) await batchModify(allArchive, { removeLabelIds: ["INBOX"] });

    report.set("Trashed", allTrash.length);
    report.set("Archived", allArchive.length);
  }

  if (labeledTotal) {
    console.log(
      `\n  (${labeledTotal} label:* actions skipped — run \`pnpm cleanup label\` separately when implemented.)`,
    );
    report.set("Label actions skipped", labeledTotal);
  }

  report.add(
    `## Outcome\n\n` +
      `| Action | Messages |\n|---|---:|\n` +
      `| Trash | ${allTrash.length} |\n` +
      `| Archive | ${allArchive.length} |\n` +
      `| Label actions deferred | ${labeledTotal} |`,
  );
  const path = await report.finish();
  console.log(`\n✓ Executed. Report: ${path}`);
  console.log("Trash is recoverable for 30 days in the Gmail UI.");
}
