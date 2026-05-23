import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GmailLabel, MessageHeaders } from "./types.ts";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const GWS_BIN = resolve(__dirname, "../../node_modules/.bin/gws");

const GMAIL_PAGE_SIZE = 500;
const GMAIL_MODIFY_BATCH_SIZE = 1000;
const GWS_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

const METADATA_HEADERS = [
  "From",
  "Subject",
  "Date",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "Precedence",
  "X-Mailer",
  "Reply-To",
  "Authentication-Results",
];

async function gws(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(GWS_BIN, args, {
    maxBuffer: GWS_MAX_BUFFER_BYTES,
  });
  return stdout;
}

export async function listMessageIds(
  query: string,
  pageToken?: string,
): Promise<{ ids: string[]; nextPageToken?: string }> {
  const params: Record<string, unknown> = {
    userId: "me",
    q: query,
    maxResults: GMAIL_PAGE_SIZE,
  };
  if (pageToken) params.pageToken = pageToken;

  const raw = await gws([
    "gmail",
    "users",
    "messages",
    "list",
    "--params",
    JSON.stringify(params),
  ]);
  const json = JSON.parse(raw);
  return {
    ids: (json.messages ?? []).map((m: { id: string }) => m.id),
    nextPageToken: json.nextPageToken,
  };
}

export async function getMessageHeaders(id: string): Promise<MessageHeaders> {
  const params = {
    userId: "me",
    id,
    format: "metadata",
    metadataHeaders: METADATA_HEADERS,
  };
  const raw = await gws([
    "gmail",
    "users",
    "messages",
    "get",
    "--params",
    JSON.stringify(params),
  ]);
  const msg = JSON.parse(raw);
  const headerMap = new Map<string, string>(
    (msg.payload?.headers ?? []).map(
      (h: { name: string; value: string }) =>
        [h.name.toLowerCase(), h.value] as const,
    ),
  );

  return {
    id: msg.id,
    threadId: msg.threadId,
    internalDate: msg.internalDate,
    labelIds: msg.labelIds ?? [],
    headers: {
      from: headerMap.get("from"),
      subject: headerMap.get("subject"),
      date: headerMap.get("date"),
      listUnsubscribe: headerMap.get("list-unsubscribe"),
      listUnsubscribePost: headerMap.get("list-unsubscribe-post"),
      precedence: headerMap.get("precedence"),
      xMailer: headerMap.get("x-mailer"),
      replyTo: headerMap.get("reply-to"),
      authenticationResults: headerMap.get("authentication-results"),
    },
  };
}

export async function getProfile(): Promise<{ messagesTotal: number }> {
  const raw = await gws([
    "gmail",
    "users",
    "getProfile",
    "--params",
    JSON.stringify({ userId: "me" }),
  ]);
  return JSON.parse(raw);
}

export async function listLabels(): Promise<GmailLabel[]> {
  const raw = await gws([
    "gmail",
    "users",
    "labels",
    "list",
    "--params",
    JSON.stringify({ userId: "me" }),
  ]);
  const json = JSON.parse(raw);
  return (json.labels ?? []) as GmailLabel[];
}

export async function getLabel(id: string): Promise<GmailLabel> {
  const raw = await gws([
    "gmail",
    "users",
    "labels",
    "get",
    "--params",
    JSON.stringify({ userId: "me", id }),
  ]);
  return JSON.parse(raw) as GmailLabel;
}

export async function deleteLabel(id: string): Promise<void> {
  await gws([
    "gmail",
    "users",
    "labels",
    "delete",
    "--params",
    JSON.stringify({ userId: "me", id }),
  ]);
}

export async function batchModify(
  ids: string[],
  changes: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<void> {
  for (let i = 0; i < ids.length; i += GMAIL_MODIFY_BATCH_SIZE) {
    const slice = ids.slice(i, i + GMAIL_MODIFY_BATCH_SIZE);
    await gws([
      "gmail",
      "users",
      "messages",
      "batchModify",
      "--params",
      JSON.stringify({ userId: "me" }),
      "--json",
      JSON.stringify({ ids: slice, ...changes }),
    ]);
  }
}

export async function verifyInstalled(): Promise<string> {
  const { stdout } = await execFileAsync(GWS_BIN, ["--version"]);
  return stdout.trim();
}

export { GMAIL_PAGE_SIZE, GMAIL_MODIFY_BATCH_SIZE };
