import { preflight } from "./preflight.ts";
import { baseline } from "./baseline.ts";
import { fetchHeaders } from "./fetch.ts";
import { plan } from "./plan.ts";
import { execute } from "./execute.ts";
import { deleteLabels, listUserLabels } from "./labels.ts";

const cmd = process.argv[2];
const rest = process.argv.slice(3);

const commands: Record<string, (args: string[]) => Promise<void>> = {
  preflight: () => preflight(),
  baseline: (args) => baseline(args),
  fetch: (args) => fetchHeaders(args[0]),
  labels: () => listUserLabels(),
  "labels-delete": (args) => deleteLabels(args),
  plan: () => plan(),
  execute: (args) => execute(args),
  classify: async () => {
    console.log(
      [
        "Classification runs as parallel Claude Code Agents — not as a Node script.",
        "",
        "1. Open a Claude Code session in this project directory.",
        "2. Say: \"classify\"",
        "",
        "Claude will read out/headers.jsonl in batches, dispatch parallel",
        "Haiku → Sonnet → Opus sub-agents, and write out/decisions.jsonl.",
        "Once that file exists, run `pnpm plan` to produce cleanup_plan.md.",
      ].join("\n"),
    );
  },
};

if (!cmd || !commands[cmd]) {
  console.error(
    "Usage: pnpm cleanup <preflight|baseline|fetch|labels|labels-delete|classify|plan|execute>",
  );
  process.exit(1);
}

commands[cmd]!(rest).catch((err) => {
  console.error(`\n✗ ${cmd} failed:`, err.message);
  process.exit(1);
});
