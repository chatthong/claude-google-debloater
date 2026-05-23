import "dotenv/config";
import { verifyInstalled, getProfile } from "./lib/gws.ts";
import { Reporter } from "./lib/report.ts";

export async function preflight(): Promise<void> {
  const report = new Reporter("preflight");

  console.log("→ Checking gws CLI install…");
  const version = await verifyInstalled().catch(() => {
    throw new Error(
      "gws not found in node_modules/.bin. Run your package manager's install (e.g. `pnpm install`).",
    );
  });
  console.log(`  ${version}`);
  report.set("gws version", version);

  console.log("→ Checking Model Armor configuration…");
  const tmpl = process.env.GOOGLE_WORKSPACE_CLI_SANITIZE_TEMPLATE?.trim();
  const mode = process.env.GOOGLE_WORKSPACE_CLI_SANITIZE_MODE?.trim();
  const looksLikePlaceholder = !!tmpl && /YOUR_PROJECT|YOUR_TEMPLATE/i.test(tmpl);

  if (!tmpl || looksLikePlaceholder) {
    console.warn(
      "  ⚠ Model Armor disabled (no template configured). Header-only reads remain the primary safety mechanism.",
    );
    report.set("Model Armor", "disabled");
  } else if (mode !== "block") {
    console.warn(
      `  ⚠ GOOGLE_WORKSPACE_CLI_SANITIZE_MODE=${mode ?? "unset"} — recommended: block`,
    );
    report.set("Model Armor", `${mode ?? "warn (default)"} mode`);
  } else {
    console.log("  Model Armor: block mode active");
    report.set("Model Armor", "block mode active");
  }

  console.log("→ Checking Gmail auth (calling users.getProfile)…");
  const profile = await getProfile();
  console.log(`  ${profile.messagesTotal.toLocaleString()} total messages in mailbox`);
  report.set("Mailbox total", profile.messagesTotal.toLocaleString());

  report.add("## Status\n\nPreflight passed. Reads will use `format=metadata` (headers only).");
  const path = await report.finish();
  console.log(`\n✓ Preflight complete. Report: ${path}`);
}
