import "dotenv/config";
import { deleteLabel, listLabels } from "./lib/gws.ts";
import { Reporter } from "./lib/report.ts";

const SYSTEM_LABEL_IDS = new Set([
  "INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT",
  "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES", "CATEGORY_FORUMS",
]);

export async function listUserLabels(): Promise<void> {
  const report = new Reporter("labels-list");
  const labels = await listLabels();
  const userLabels = labels.filter(
    (l) => l.type === "user" || !SYSTEM_LABEL_IDS.has(l.id),
  );

  console.log(`Found ${userLabels.length} user-defined labels:\n`);
  const rows = ["| ID | Name | Messages |", "|---|---|---:|"];
  for (const l of userLabels) {
    const count = l.messagesTotal ?? 0;
    console.log(`  ${l.id.padEnd(40)} ${l.name.padEnd(35)} ${count}`);
    rows.push(`| \`${l.id}\` | ${l.name} | ${count} |`);
  }
  console.log(
    "\nTo delete labels:  pnpm cleanup labels-delete <id1> <id2> ...",
  );
  console.log("(deleting a label does NOT delete its messages — they keep other labels)");

  report.set("Total user labels", userLabels.length);
  report.add(`## Labels\n\n${rows.join("\n")}`);
  const path = await report.finish();
  console.log(`\nReport: ${path}`);
}

export async function deleteLabels(ids: string[]): Promise<void> {
  if (!ids.length) {
    console.error("Usage: pnpm cleanup labels-delete <id1> [id2 ...]");
    process.exit(1);
  }

  const report = new Reporter("labels-delete");
  report.set("Targets", ids.join(", "));
  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const id of ids) {
    if (SYSTEM_LABEL_IDS.has(id)) {
      console.warn(`  ⚠ Skipping system label ${id} (refused by Gmail)`);
      failed.push(`${id} (system label)`);
      continue;
    }
    try {
      await deleteLabel(id);
      console.log(`  ✓ Deleted ${id}`);
      succeeded.push(id);
    } catch (err) {
      console.warn(`  ⚠ Failed ${id}: ${(err as Error).message}`);
      failed.push(`${id} (${(err as Error).message})`);
    }
  }

  report.set("Deleted", succeeded.length);
  report.set("Failed", failed.length);
  if (succeeded.length) report.add(`## Deleted\n\n- ${succeeded.join("\n- ")}`);
  if (failed.length) report.add(`## Failed\n\n- ${failed.join("\n- ")}`);
  const path = await report.finish();
  console.log(`\nReport: ${path}`);
}
