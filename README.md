# claude-gmail-cleaner

> Multi-tier LLM-driven Gmail cleanup for inboxes Google won't let you nuke yourself.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

A header-only-safe, tiered (Haiku → Sonnet → Opus) email classifier and trash pipeline.
First tool in a planned [Google Debloater Suite](#roadmap) — Photos, Drive, Calendar, and Contacts to follow.

---

## Table of Contents

- [What it does](#what-it-does)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [Safety model](#safety-model)
- [Cost](#cost)
- [GCP Setup](#gcp-setup)
- [Configuration](#configuration)
- [Command reference](#command-reference)
- [`--years` reference](#--years-reference)
- [Outputs](#outputs)
- [Tradeoffs & non-goals](#tradeoffs--non-goals)
- [Roadmap](#roadmap)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## What it does

Real-world mailboxes look like this:

```
Inbox          ~5,000 – 10,000     actual correspondence
Updates       ~50,000 – 100,000    transactional, receipts, OTPs, status mail
Promotions    ~30,000 –  60,000    marketing
Social        ~20,000 –  50,000    social-network notifications
Purchases         hundreds – low thousands
Forums            hundreds
                  ──────────
TOTAL         ~100,000 – 250,000
```

Manually clearing a six-figure inbox takes weeks of `Select All → Delete → confirm
→ next page → ...` and Gmail throttles aggressive selections. Gmail's API can
`batchModify` 1,000 messages per call but provides no decision-making.

This tool adds the missing layer: a three-tier LLM classifier (Haiku for the obvious
bulk, Sonnet for ambiguous cases, Opus as final arbiter) that decides what to trash,
what to keep, what to unsubscribe from, and what to relabel — then issues the API
calls. Everything goes to Trash (recoverable for 30 days), never permanent delete.

> **Note:** Classification runs inside a Claude Code session, not via the Anthropic
> SDK. No separate API key is needed. Your existing Claude Pro / Max / Team plan
> covers it.

---

## Quickstart

Get to your first successful `pnpm preflight` in under 15 minutes.

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 22 | `brew install node` |
| pnpm | ≥ 9 | `brew install pnpm` |
| gcloud CLI | any | `brew install --cask google-cloud-sdk` |
| Claude Code | any | https://claude.ai/code |
| GCP project with active billing | — | [GCP Setup](#gcp-setup) |

> **Note:** "Active billing" does not mean you will be charged. Gmail API is free at
> this scale. Google requires a billing account to be linked before any API quota can
> be authorized. A free-trial account with the $300 credit qualifies.

### Step 1 — Clone and install

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/claude-gmail-cleaner.git
cd claude-gmail-cleaner
pnpm install
```

### Step 2 — GCP and OAuth setup

Follow the [GCP Setup](#gcp-setup) section (15–20 minutes, one-time). It covers:
creating a GCP project, linking billing, enabling the Gmail API, configuring an OAuth
consent screen, creating a Desktop-app OAuth client, and running `gws auth setup` +
`gws auth login`.

### Step 3 — Configure and verify

```bash
cp .env.example .env
# Optionally edit .env to set CLEANUP_MAX_MESSAGES=2000 while iterating

pnpm preflight
```

A successful `pnpm preflight` prints your mailbox total and confirms header-only reads
are working. If you see `PERMISSION_DENIED`, see [Troubleshooting](#troubleshooting).

### Step 4 — Baseline counts

```bash
pnpm count      # per-year message counts → out/count.json
pnpm buckets    # Gmail-category breakdown → out/buckets.json
```

Then open a Claude Code session at the project root and say **"analyze baseline"**.
A Haiku sub-agent reads both files and writes `out/baseline_analysis.md` with a
recommended year range and a ready-to-paste fetch query.

### Step 5 — Fetch headers

```bash
pnpm fetch                        # all mail, default 10-year lookback
pnpm fetch "category:promotions"  # or narrow by Gmail search query
pnpm fetch --years 2025           # or narrow by year
```

This writes `out/headers.jsonl`. Fetching 200K headers takes roughly 2 hours at the
default concurrency of 8. The command is resumable — interrupted runs pick up where
they left off.

### Step 6 — Classify (Claude Code session)

Open a Claude Code session at the project root and say **"classify"**.

The orchestrator reads `out/headers.jsonl` in 1,000-message batches and drives the
three-tier pipeline (see [How it works](#how-it-works)). Results stream to
`out/decisions.jsonl`. Leave the session open — classification pauses if you close
the terminal.

### Step 7 — Plan and execute

```bash
pnpm plan                  # produce out/cleanup_plan.md — review this before proceeding
pnpm execute --test        # trash the first 100, then prompt yes/no
pnpm execute --confirm     # full run, no further prompt
```

Always start with `--test`. After the first 100 are trashed, open Gmail and confirm
the results look right before typing `yes`. Everything that goes to Trash is
recoverable for 30 days.

---

## How it works

### Pipeline

```
                          GMAIL API (gws CLI)
                                 │
                                 │  format=metadata, metadataHeaders=[...]
                                 │  body never leaves Google servers
                                 ▼
                      ┌─────────────────────┐
                      │  Header Fetcher     │  resumable, 8-way concurrent
                      │  → headers.jsonl    │  streams to disk, no memory bloat
                      └──────────┬──────────┘
                                 │
                                 ▼
                      ┌─────────────────────┐
                      │  Bucket Router      │  free, deterministic
                      │  Inbox / Promotions │
                      │  Social / Updates   │
                      └──────────┬──────────┘
                                 │
                                 ▼
              ┌──────────────────────────────────────┐
              │  HAIKU BASKET     drains at 1,000    │
              │  10 parallel Claude Haiku sub-agents  │
              │  trash / keep / unsub / unclear       │
              └──────────┬───────────────────┬────────┘
               clear     │                   │ unclear
                         ▼                   ▼
              [Gmail batchModify]   ┌─────────────────────────────┐
                                   │  SONNET BASKET  drains at 500│
                                   │  10 parallel Sonnet agents   │
                                   │  drop/keep/label/unsub/unclear│
                                   └──────────┬──────────┬────────┘
                                    clear     │          │ unclear
                                              ▼          ▼
                                       [actions]  ┌─────────────────────────┐
                                                  │  OPUS BASKET  drains at 100│
                                                  │  4 parallel Opus agents   │
                                                  │  final ruling             │
                                                  └──────────┬────────┬───────┘
                                                   clear     │        │ unclear
                                                             ▼        ▼
                                                      [actions]  needs_review.csv
```

### Action types

| Action | What happens | Reversible? |
|--------|-------------|-------------|
| `trash` | `batchModify addLabelIds=["TRASH"]` | Yes — 30-day Gmail Trash |
| `keep` | No-op | n/a |
| `unsubscribe` | RFC 8058 one-click POST, then trash | Partial — unsub is sticky |
| `label:<name>` | Apply or create label, leave in Inbox | Yes |
| `archive` | Remove `INBOX` label | Yes |
| `unclear` | Escalate to next tier | n/a |

### Queue semantics

- **Drain thresholds, not timers.** A basket waits until it has enough work to keep
  all its parallel agents busy (1,000 / 500 / 100).
- **Backpressure.** If Sonnet falls behind, Haiku pauses — no unbounded queue growth.
- **Failure isolation.** An LLM call that errors marks its messages as `unclear` and
  they escalate naturally. No retry storms.
- **Idempotent.** Every message ID is recorded in `out/decisions.jsonl`. Re-running
  skips already-decided IDs.

---

## Safety model

### 1. Header-only is enforced at the API, not just in code

Every Gmail read uses `format=metadata` with an explicit `metadataHeaders` allowlist.
Gmail's server never returns the body. Even a bug in this code that requested the body
would be rejected at the API level.

Headers requested:
```
From, Subject, Date, List-Unsubscribe, List-Unsubscribe-Post,
Precedence, X-Mailer, Reply-To, Authentication-Results
```

### 2. Body content never enters an LLM prompt

LLM prompts contain only: sender address, sender domain, subject, date, and boolean
flags derived from headers (has-list-unsubscribe, no-reply, etc.). No snippets. No
body. No attachment names.

### 3. Destructive operations require an approval gate

`out/cleanup_plan.md` must be reviewed before any `batchModify` call runs. All moves
go to Trash — never `messages.delete` (permanent).

> **Warning:** Unsubscribe POSTs via RFC 8058 are not reversible at the protocol
> level. If you change your mind you will need to re-subscribe via the sender's
> website. Trash moves are always recoverable for 30 days.

### 4. OAuth scope discipline

`gws auth login` requests `gmail.modify` — not `gmail.readonly` or `mail.google.com`.
This scope permits reading metadata and moving messages between labels (including
Trash). It cannot read message bodies, and it cannot permanently delete anything.

### 5. `--test` mode

`pnpm execute --test` trashes the first 100 candidates and then prompts `yes/no`
before continuing. Always start here on a fresh dataset. Abort at `no`; the 100
already trashed are still recoverable for 30 days.

---

## Cost

### Google APIs

Free at this scale. Gmail API daily quota is 1 billion quota units. A full 200K
message scan and cleanup uses approximately 250K units — under 0.05% of the daily
ceiling.

### Claude (LLM tiers)

Classification runs inside a **Claude Code session** via the Agent tool — not via the
Anthropic SDK. There is no separate API key and no per-token bill outside your
existing Claude Code plan (Pro, Max, Team, etc.).

The session orchestrator reads `out/headers.jsonl` and dispatches sub-agents with
`model: "haiku" | "sonnet" | "opus"` — ten Haiku in one batch, ten Sonnet when their
basket fills, four Opus when theirs does — all as parallel tool calls in a single
message, results streamed back to disk.

**Rough estimate on a 200K mailbox:** $100–$300 equivalent plan usage, one-time.
Free thereafter (fetch is cached; re-classify by editing prompts in `src/prompts/`).

**Attended execution.** Classification only progresses while a Claude Code session is
open. Closing the terminal pauses the pipeline; reopening it resumes from where
`out/decisions.jsonl` left off.

---

## GCP Setup

One-time, 15–20 minutes. Do this before `pnpm preflight`.

### 1. Install the gcloud CLI

**macOS (Homebrew):**
```bash
brew install --cask google-cloud-sdk
```

**Linux (apt):**
```bash
sudo apt-get install apt-transport-https ca-certificates gnupg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
  | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg \
  | sudo apt-key --keyring /usr/share/keyrings/cloud.google.gpg add -
sudo apt-get update && sudo apt-get install google-cloud-cli
```

Verify: `gcloud --version`

### 2. Sign in

```bash
gcloud auth login
```

Sign in with the Google account that owns the Gmail inbox you want to clean.

### 3. Create a GCP project

```bash
gcloud projects create YOUR_PROJECT_ID --name="Gmail Cleaner"
gcloud config set project YOUR_PROJECT_ID
```

Pick a globally unique `YOUR_PROJECT_ID` (e.g. `gmail-cleanup-2026`). You will use it
in every subsequent command.

### 4. Link a billing account

```
https://console.cloud.google.com/billing/linkedaccount?project=YOUR_PROJECT_ID
```

> **Warning:** Google's Service Usage API refuses to authorize any API consumption
> unless the project has an active billing account (not suspended, not pending). The
> Gmail API costs $0 at this scale, but the billing account must exist.
>
> After linking billing, wait 2–3 minutes before proceeding. The Service Usage
> Consumer role can take a moment to propagate; you may see `PERMISSION_DENIED` if
> you proceed immediately.

### 5. Enable the Gmail API

```bash
gcloud services enable gmail.googleapis.com --project=YOUR_PROJECT_ID
```

### 6. Configure the OAuth consent screen

```
https://console.cloud.google.com/apis/credentials/consent?project=YOUR_PROJECT_ID
```

- **User type:** External
- **App name:** anything (e.g. `Gmail Cleaner`)
- **User support email / Developer contact:** your-email@example.com
- Leave all other fields blank and click **Save and Continue** through Scopes.
- **Publishing status:** leave as **Testing** — avoids a Google verification review.
- Under **Test users**, add your own Gmail address. Only listed test users can complete
  the OAuth flow while the app is in Testing mode.

> **Note:** During the browser consent flow (step 8), Google will show an "App not
> verified" warning. This is expected for apps in Testing mode. Click **Advanced →
> Go to [App name] (unsafe)** to proceed.

### 7. Create OAuth client credentials

```
https://console.cloud.google.com/apis/credentials?project=YOUR_PROJECT_ID
```

Click **Create Credentials → OAuth client ID**:

- **Application type:** Desktop app — this is required
- **Name:** anything (e.g. `gmail-cleaner-desktop`)
- Click **Create**

Copy the **Client ID** and **Client Secret** from the dialog.

> **Note:** Desktop app is required. Choosing Web application breaks the OAuth
> redirect flow — `gws auth login` expects a local redirect that only Desktop app
> clients handle correctly.

### 8. Hand credentials to `gws auth setup`

```bash
./node_modules/.bin/gws auth setup
```

Paste the Client ID then the Client Secret when prompted.

### 9. Complete the browser consent flow

```bash
./node_modules/.bin/gws auth login
```

A browser window opens, you sign in, grant `gmail.modify`, and the CLI writes an
encrypted refresh token to `~/.config/gws/credentials.enc`. You will not need to
repeat this unless you revoke the token.

---

## Configuration

All variables are optional. Copy `.env.example` to `.env` and uncomment what you need.

| Variable | Used by | Default | Notes |
|----------|---------|---------|-------|
| `GOOGLE_WORKSPACE_PROJECT_ID` | gws (all commands) | OAuth client's project | Override if primary project has billing issues |
| `GOOGLE_WORKSPACE_CLI_SANITIZE_TEMPLATE` | gws Model Armor | disabled | Requires Model Armor API enabled |
| `GOOGLE_WORKSPACE_CLI_SANITIZE_MODE` | gws Model Armor | `warn` | `warn` or `block` |
| `CLEANUP_MAX_MESSAGES` | `pnpm fetch` | unlimited | Useful cap while iterating (e.g. `2000`) |
| `CLEANUP_CONCURRENCY` | `pnpm fetch` | `8` | Concurrent gws requests |
| `CLEANUP_YEAR_LOOKBACK` | `--years` default | `10` | Years back when `--years` is omitted |
| `CLEANUP_SECONDS_PER_BATCH` | `pnpm plan` ETA | `2` | Wall-clock estimate per batch |
| `PLAN_TOP_N` | `pnpm plan` | `25` | Rows in cleanup_plan.md sender tables |

---

## Command reference

| Command | Purpose | `--years`? |
|---------|---------|:----------:|
| `pnpm preflight` | Verify gws install, auth, env vars, mailbox reachability. Run first. | — |
| `pnpm labels` | List user-defined Gmail labels with message counts. | — |
| `pnpm cleanup labels-delete <id> [id ...]` | Delete labels by ID (messages keep their other labels). | — |
| `pnpm count` | Per-year message counts. Writes `out/count.json`. | ✓ |
| `pnpm buckets` | Gmail-category counts (promotions/social/updates/forums). Writes `out/buckets.json`. | ✓ |
| `pnpm fetch [query]` | Fetch headers into `out/headers.jsonl` (resumable). Default query: `in:anywhere -in:chats`. | ✓ |
| `pnpm plan` | Roll up `out/decisions.jsonl` into `out/cleanup_plan.md`. | ✓ |
| `pnpm execute --test` | Trash first 100 candidates, prompt yes/no for the rest. | ✓ |
| `pnpm execute --confirm` | Full run, no prompt. Refuses without either flag. | ✓ |

**Claude Code session commands** (say these inside a `claude` session at the project root):

| Phrase | What happens |
|--------|-------------|
| `analyze baseline` | Haiku sub-agent reads `out/count.json` + `out/buckets.json`, writes `out/baseline_analysis.md` with a recommended fetch query. |
| `classify` | Drives the Haiku → Sonnet → Opus pipeline against `out/headers.jsonl`, writes `out/decisions.jsonl`. |

Tier system prompts live in `src/prompts/{haiku,sonnet,opus}.md`. Edit them to tune
behavior without re-fetching headers.

---

## `--years` reference

The `--years` flag is accepted by `count`, `buckets`, `fetch`, `plan`, and `execute`.
The same value parses identically on every command.

| Form | Meaning | Example |
|------|---------|---------|
| omitted | Default lookback (env `CLEANUP_YEAR_LOOKBACK`, default 10 years) | `pnpm count` |
| `N` (1–3 digits) | Last N years | `--years 5` |
| `Nyear` / `Nyears` | Last N years, explicit unit (any magnitude) | `--years 10years` |
| `YYYY` (4 digits) | Single calendar year | `--years 2025` |
| `YYYY-YYYY` | Inclusive range, auto-sorted (either direction) | `--years 2010-2026` |

Examples:

```bash
pnpm count   --years 5                       # last 5 years
pnpm count   --years 2025                    # just 2025
pnpm count   --years 2018-2026               # explicit range
pnpm buckets --years 2025                    # category counts for 2025
pnpm fetch   --years 2025                    # fetch one year's headers
pnpm fetch   "category:promotions" --years 5 # query + lookback combined
pnpm execute --test --years 2018-2024        # test-trash a year slice
```

Internally, values resolve to `{ fromYear, toYear }`. On `count` / `buckets` / `fetch`
the range becomes a Gmail query clause (`after:Y1/01/01 before:Y2+1/01/01`). On
`plan` / `execute` it filters decisions against the dates in `out/headers.jsonl`.

---

## Outputs

### `out/` — working data (gitignored)

Resumable artifacts. Re-running a command updates these in place.

| File | Written by | Purpose |
|------|-----------|---------|
| `count.json` | `pnpm count` | Per-year message counts |
| `buckets.json` | `pnpm buckets` | Gmail-category counts |
| `baseline_analysis.md` | Claude session | Recommended sweep strategy |
| `headers.jsonl` | `pnpm fetch` | One header record per message |
| `decisions.jsonl` | Claude session `classify` | Per-message tier, action, confidence |
| `sender_index.csv` | Claude session `classify` | Aggregated per-sender signals |
| `cleanup_plan.md` | `pnpm plan` | Human-readable approval document |
| `needs_review.csv` | Claude session `classify` | Senders Opus could not classify |

### `log_results/` — per-run history (gitignored)

Append-only. One Markdown file per command invocation, named
`YYYY-MM-DDTHH-MM-SS_<cmd>.md` for free chronological sorting:

```
log_results/
├── 2026-05-23T10-30-45_preflight.md
├── 2026-05-23T10-31-12_baseline.md
├── 2026-05-23T10-45-09_fetch.md
├── 2026-05-23T12-15-22_classify.md
├── 2026-05-23T12-32-08_plan.md
└── 2026-05-23T13-01-50_execute.md
```

Each report contains the run's stat block: messages touched, tier breakdown, Gmail
quota used, wall-clock duration, and any errors.

---

## File layout

```
claude-gmail-cleaner/
├── README.md
├── CLAUDE.md                   <- agent-facing project conventions
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── cli.ts                  <- subcommand dispatcher
│   ├── preflight.ts
│   ├── labels.ts
│   ├── baseline.ts
│   ├── fetch.ts
│   ├── classify.ts             <- Claude Code Agent orchestrator
│   ├── plan.ts
│   ├── execute.ts
│   ├── prompts/
│   │   ├── baseline-analyze.md
│   │   ├── haiku.md            <- tier 1 system prompt
│   │   ├── sonnet.md           <- tier 2 system prompt
│   │   └── opus.md             <- tier 3 system prompt
│   └── lib/
│       ├── gws.ts              <- Gmail API wrapper (header-only enforced)
│       ├── years.ts            <- --years flag parser
│       ├── unsubscribe.ts      <- RFC 8058 one-click POST handler
│       ├── report.ts           <- per-run stat-report writer
│       └── types.ts
├── out/                        <- gitignored, working data
└── log_results/                <- gitignored, append-only run history
```

---

## Tradeoffs & non-goals

### Why pure LLM tiering instead of a rules-first hybrid

A regex pre-filter could cheaply trash 70% of bulk before any LLM touches it. This
tool deliberately omits that pre-filter and routes every message through the LLM
tiers. The pure pipeline is easier to reason about, removes a class of false-positive
risk (regex misclassifying legitimate mail as bulk), and trusts LLM judgment
uniformly. Users who want a faster, cheaper path can fork and add the pre-filter.

### Why Haiku / Sonnet / Opus over multi-vendor routing

Single-vendor dependency simplifies error handling, prompt caching, and billing
reconciliation. Cross-vendor model routing adds operational complexity that doesn't
pay off for a focused single-task tool.

### Why we don't unsubscribe everything

RFC 8058 one-click unsubscribe is supported by roughly 30% of bulk senders. The rest
either use the older RFC 2369 mailto form (requires sending mail back — easy to do
badly) or require a browser visit to a hosted unsubscribe page (out of scope for a
header-only tool). We do what is safe and reliable and trash the rest.

### Non-goals

- **Real-time monitoring.** This is a batch tool you run when you want to clean up,
  not a daemon.
- **Spam detection.** Gmail's classifier is already excellent — we trust its
  Promotions / Updates / Social buckets and route from there.
- **Permanent deletion.** Always Trash, never `expunge`.
- **Replying or composing.** Scope is strictly read-headers and modify-labels.

---

## Roadmap

This repo is the first tool in a planned **Google Debloater Suite**. The same patterns
(header-only safety, tiered LLM routing, gws CLI, GCP project) get reused for:

| Tool | Status | Notes |
|------|--------|-------|
| `claude-gmail-cleaner` | **In progress** (this repo) | |
| `claude-photos-debloater` | Planned | Photos API removed delete in 2025 — needs Takeout flow or browser automation |
| `claude-drive-debloater` | Planned | Mass file/folder cleanup with size + age scoring |
| `claude-calendar-debloater` | Planned | Old recurring events, spam invites |
| `claude-contacts-deduper` | Planned | Deduplicate the inevitable contact sprawl |

---

## Troubleshooting

### `PERMISSION_DENIED` / `Caller does not have required permission`

Your GCP project is missing an active billing account, or the Service Usage Consumer
role hasn't propagated yet (can take up to 15 minutes on personal Google accounts).

1. Open `https://console.cloud.google.com/billing` and confirm an active billing
   account is linked. Wait 2–5 minutes, then retry.
2. As a workaround, route quota to a different project you own:
   ```bash
   # in .env
   GOOGLE_WORKSPACE_PROJECT_ID=your-other-project-id
   ```
   ```bash
   pnpm preflight
   ```
   You only need the Gmail API enabled on the override project.

### `accessNotConfigured` / `API has not been used in project`

Gmail API is not enabled on the project gws is routing quota to:

```bash
gcloud services enable gmail.googleapis.com --project=YOUR_PROJECT_ID
```

### `Access blocked: ... has not completed the Google verification process`

Your consent screen is in Testing mode (correct for personal use) but your Gmail
address is not on the Test Users list. Add it at:

```
https://console.cloud.google.com/auth/audience?project=YOUR_PROJECT_ID
```

### `pnpm setup` fails on Homebrew-installed pnpm

You don't need `pnpm setup` for this project — gws is a local devDep, not a global
binary. Running `pnpm install` is sufficient.

### `gws not found in node_modules/.bin`

You haven't run `pnpm install` yet, or the install failed. Check:

```bash
ls node_modules/.bin/gws
```

If missing, run `pnpm install` again and watch for postinstall script errors.

---

## Security

This tool requests OAuth scope `gmail.modify`. It can read metadata and move messages
between labels (including Trash). It cannot read message bodies (the scope excludes
`gmail.readonly` and `mail.google.com`) and it cannot permanently delete anything
(`addLabelIds=["TRASH"]` only, recoverable for 30 days).

### Threat model

**In scope:**
- Prompt injection via email header content — mitigated by structured parsing and an
  explicit `metadataHeaders` allowlist; no free-text field reaches an LLM unfiltered.
- Token exfiltration — mitigated by gws's AES-256-GCM encryption of credentials and
  OS keyring storage of the encryption key.
- Mistaken classification leading to mass trashing — mitigated by `--test` mode, the
  `cleanup_plan.md` approval gate, and Gmail's 30-day Trash retention.

**Out of scope:**
- Compromised local user account (access to `~/.config/gws/` plus the OS keyring can
  call Gmail with your scope).
- Compromised GCP project (an attacker who can modify the OAuth client could redirect
  the consent flow).

### Reporting vulnerabilities

Do not file a public issue for security vulnerabilities. Use the repository's security
advisory feature or contact the maintainer privately through the repository metadata.

---

## Contributing

Issues and pull requests welcome.

- Read `CLAUDE.md` before submitting — it documents the hard safety invariants
  (header-only, no Anthropic SDK, no permanent delete) that must not be broken.
- Run `pnpm preflight` before opening a PR to confirm the basics still work.
- Keep changes scoped — large refactors should be discussed in an issue first.
- Avoid new runtime dependencies. The current `package.json` runtime dep is `dotenv`
  only; that is intentional.

**Branching:** work off `main`. Short topic-branch names are fine; no `feat/` prefix
required.

**Commit style:** imperative present-tense, one logical change per commit.
Examples: `add labels-delete subcommand`, `fix gws binary resolution under non-cwd invocation`.

---

## License

MIT. See [LICENSE](LICENSE).

---

## Acknowledgements

- [@googleworkspace/cli](https://github.com/googleworkspace/cli) — without
  auto-generated Discovery Service commands this would be a thousand lines of curl and
  jq.
- [RFC 8058](https://datatracker.ietf.org/doc/html/rfc8058) — one-click unsubscribe
  spec.
- Google, for not shipping a "delete most of this" button, thereby creating the reason
  for this repo's existence.
