# CLAUDE.md

Project conventions and operational context for Claude Code sessions in this repo.
Read this first before making changes. README.md is the human-facing doc; this file
is the agent-facing one.

## What this project is

First tool in a planned multi-tool **Google Debloater Suite**. Current scope:
clean up a 200K+ Gmail mailbox with a tiered LLM classifier.

Future tools in the suite (planned, not built):
`claude-photos-debloater`, `claude-drive-debloater`, `claude-calendar-debloater`,
`claude-contacts-deduper`. Patterns established here (header-only safety, tiered
LLM routing, gws CLI, GCP project setup) get reused.

## Tech stack

- **Node.js ≥ 22**, ES modules (`"type": "module"` in package.json)
- **pnpm ≥ 9** — *not* npm. `packageManager` field pins this.
- **TypeScript** with `noUncheckedIndexedAccess`, run via `tsx` (no build step)
- **`@googleworkspace/cli`** (gws) — installed as a local devDep, called via
  `node_modules/.bin/gws`. **Do not assume gws is on PATH.**
- **Claude Code Agent tool** for LLM classification — *not* the Anthropic SDK.
  Classification runs as parallel sub-Agents spawned from this session
  (`Agent({ model: "haiku" | "sonnet" | "opus", ... })`). Billed via the user's
  Claude Code plan, no separate API key.
- **No frameworks.** Plain Node, dotenv, child_process. Resist adding deps.

## Architecture (pipeline)

```
Node:     pnpm fetch (Gmail headers, format=metadata) → out/headers.jsonl
              │
              ▼
Claude:   read headers.jsonl in 1000-batch chunks
          spawn 10× Agent(model:"haiku")  — one tool message, parallel
          → action: trash | keep | unsub | unclear → out/decisions.jsonl
              │
              │ when 500 unclear accumulate
              ▼
Claude:   spawn 10× Agent(model:"sonnet")
          → action: drop | keep | label | organize | unsub | unclear
              │
              │ when 100 unclear accumulate
              ▼
Claude:   spawn 4× Agent(model:"opus")
          → final ruling | needs_review (last resort)
              │
              ▼
Node:     pnpm plan → out/cleanup_plan.md (human-readable approval doc)
          pnpm execute --confirm → Gmail batchModify (TRASH labels)
```

Parallelism + batch sizes are user-confirmed (see this project's memory under
`~/.claude/projects/<project-slug>/memory/feedback_llm_tiering.md`):
10 Haiku / 10 Sonnet / 4 Opus, 1000 / 500 / 100. **Do not change without asking.**

The orchestration runs *in a Claude Code session*, not as a Node subprocess.
Closing the session pauses classification; resuming the session resumes it.

## Hard safety rules (non-negotiable)

1. **Headers + subject only.** Never feed email body content to any model.
   All Gmail reads use `format=metadata` with explicit `metadataHeaders=[...]`.
   This is API-enforced — Gmail will reject body requests with our scope.
2. **No `messages.delete`.** Ever. All deletions are `addLabelIds=["TRASH"]`.
   Trash retains 30 days; permanent delete is irreversible.
3. **No execution without `--confirm`.** The `pnpm execute` command is the only
   path to API writes. It refuses to run without the flag.
4. **OAuth scope is `gmail.modify`**, not `gmail.readonly` or `mail.google.com`.
   Don't expand it. If a tool needs more access, raise it with the user first.
5. **Body content extraction is forbidden via LLM.** If a future feature
   genuinely needs body parsing (e.g., OTP extraction), use deterministic regex
   on an allowlist of trusted senders. Never an LLM.

## Coding conventions

- **Pure functions in `src/lib/`.** No I/O in `classify.ts`, `queue.ts`, etc.
  I/O lives in the top-level command files (`fetch.ts`, `execute.ts`).
- **JSONL for streaming data**, not JSON arrays. 200K-message JSON arrays will
  OOM on iteration. Newline-delimited JSON streams cleanly.
- **Resumability is a feature, not a nice-to-have.** Every long-running step
  must check what's already on disk and skip it. Use ID-keyed Sets.
- **Every command writes a run report** to `log_results/<ISO-timestamp>_<cmd>.md`
  with a stats block (counts, costs, durations, errors). Filename format:
  `YYYY-MM-DDTHH-MM-SS_<command>.md` (no colons — filesystem-safe ISO 8601).
  Use a small `lib/report.ts` helper; don't reinvent it per command.
- **No comments that explain *what*** — names should do that. Comments are for
  *why* something non-obvious is the way it is (hidden constraint, subtle
  invariant, workaround for a specific quirk).
- **`noUncheckedIndexedAccess`** is on. Every `arr[i]` is `T | undefined` —
  handle it.

## Environment & known gotchas

### GCP project state

- OAuth client lives in the GCP project the user picked during `gcloud init`.
- If that project ever enters a billing-frozen state (closed billing account,
  refused reactivation, suspended for policy), Service Usage API will reject
  calls — symptoms are `PERMISSION_DENIED` on calls that should succeed under
  Owner role.
- **Workaround**: set `GOOGLE_WORKSPACE_PROJECT_ID=<another-active-project>`
  in `.env` to route API quota to a different consumer project. OAuth
  identity and refresh token are unchanged.
- Don't strip the env var without verifying the original project's billing
  state first.

### gws CLI

- Installed as a devDep, called via `./node_modules/.bin/gws`.
- Wrapped by `src/lib/gws.ts` — always go through the wrapper, never shell out
  to gws from arbitrary files.
- Credentials encrypted at `~/.config/gws/credentials.enc` (AES-256-GCM, key in
  macOS Keychain).
- Auth refresh: `./node_modules/.bin/gws auth logout && ... auth login`.

### Mailbox scale (illustrative)

Real-world mailboxes the tool is designed for typically look like:

- Total: 100K–250K messages
- Inbox proper: 5K–10K (actual correspondence)
- `category:promotions` + `category:social` + `category:updates`: the bulk
  (often 80%+) — already pre-classified by Gmail's own ML
- Use those Gmail-native categories as the first router, not custom heuristics.

## Commands

```bash
pnpm preflight       # verify gws install, auth, env, mailbox reachable
pnpm labels          # list user-defined Gmail labels
pnpm cleanup labels-delete <id> [id ...]  # delete specific labels
pnpm baseline        # year + category counts (default 10y lookback)
pnpm baseline --years 5              # last N years
pnpm baseline --years 2018-2026      # explicit range
# Then in a Claude Code session: "analyze baseline" → Haiku writes out/baseline_analysis.md
pnpm fetch           # header fetch → out/headers.jsonl (resumable)
# (classification happens in a Claude Code session — say "classify")
pnpm plan            # produce out/cleanup_plan.md from decisions.jsonl
pnpm execute --test     # apply first 100 actions then prompt yes/no
pnpm execute --confirm  # full destructive run, no prompt
```

## What NOT to do

- **Don't add a rule-based pre-filter** before Haiku. User explicitly chose
  pure LLM tiering. Memory file:
  `~/.claude/projects/<project-slug>/memory/feedback_llm_tiering.md`.
- **Don't add `@anthropic-ai/sdk`** or any Anthropic API key handling. LLM tiers
  run as Claude Code Agents from the session, not via the SDK.
- **Don't switch to npm.** `packageManager` is pnpm. Lockfile is pnpm's.
- **Don't enable Model Armor** without checking the user's billing state.
  Model Armor requires an active billing account on the consumer project; the
  current setup doesn't have one. Header-only is the load-bearing safety
  property — Model Armor was defense-in-depth and is currently disabled.
- **Don't create new files for trivial features.** Prefer editing existing
  `src/lib/*` modules.
- **Don't write planning/decision docs** unless the user asks. This file and
  README.md are the only docs. Use conversation context and the user's memory
  system instead.

## Useful references

- Gmail API: https://developers.google.com/gmail/api
- gws CLI docs: https://github.com/googleworkspace/cli
- RFC 8058 (one-click unsubscribe): https://datatracker.ietf.org/doc/html/rfc8058
- User memory for this project lives under
  `~/.claude/projects/<project-slug>/memory/` (slug derived from the absolute
  path of the project directory — varies per machine).
