import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const LOG_DIR = "log_results";

function timestampForFilename(d: Date): string {
  return d.toISOString().slice(0, 19).replace(/:/g, "-");
}

export class Reporter {
  private readonly startedAt = new Date();
  private readonly sections: string[] = [];
  private readonly metadata: Record<string, string | number> = {};

  constructor(private readonly command: string) {}

  add(markdownSection: string): void {
    this.sections.push(markdownSection.trim());
  }

  set(key: string, value: string | number): void {
    this.metadata[key] = value;
  }

  async finish(extra: { error?: Error } = {}): Promise<string> {
    const finishedAt = new Date();
    const ms = finishedAt.getTime() - this.startedAt.getTime();
    const duration =
      ms < 60_000 ? `${Math.round(ms / 100) / 10}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

    const filename = `${timestampForFilename(this.startedAt)}_${this.command}.md`;
    const path = resolve(LOG_DIR, filename);
    await mkdir(LOG_DIR, { recursive: true });

    const meta = Object.entries(this.metadata)
      .map(([k, v]) => `- **${k}:** ${v}`)
      .join("\n");

    const errorSection = extra.error
      ? `\n## Error\n\n\`\`\`\n${extra.error.stack ?? extra.error.message}\n\`\`\`\n`
      : "";

    const body = `# Run report — \`${this.command}\`

**Started:** ${this.startedAt.toISOString()}
**Finished:** ${finishedAt.toISOString()}
**Duration:** ${duration}
${meta ? `\n## Metadata\n\n${meta}\n` : ""}
${this.sections.join("\n\n")}
${errorSection}`;

    await writeFile(path, body);
    return path;
  }
}
