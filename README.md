# claude-gmail-cleaner

> Multi-tier LLM-driven Gmail cleanup for inboxes Google won't let you nuke yourself.

A header-only-safe, tiered (Haiku → Sonnet → Opus) email classifier and trash pipeline.
Designed for the case where you open Gmail, see a six-digit unread counter, and
realize Google does not ship a "delete most of this" button.

First tool in a planned [Google Debloater Suite](#roadmap) — Photos, Drive, Calendar
to follow.

---

## Table of Contents

- [What problem this solves](#what-problem-this-solves)
- [Architecture](#architecture)
- [Safety model](#safety-model)
- [Cost estimate](#cost-estimate)
- [Prerequisites](#prerequisites)
- [GCP Setup](#gcp-setup)
- [Setup](#setup)
- [Usage](#usage)
- [Outputs](#outputs)
- [File layout](#file-layout)
- [Tradeoffs & non-goals](#tradeoffs--non-goals)
- [Roadmap](#roadmap)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## What problem this solves

Real-world mailboxes look like this:

```
Inbox          ~5,000 – 10,000     actual correspondence
Updates       ~50,000 – 100,000    transactional, receipts, OTPs, status mails
Promotions    ~30,000 – 60,000     marketing
Social        ~20,000 – 50,000     social network notifications
Purchases       hundreds to low thousands
Forums          hundreds
Spam            hundreds           already handled by Google
                ──
TOTAL         ~100,000 – 250,000
```

Manually clearing six-figure bulk-classified messages would take weeks of `Select All →
Delete → confirm → next page → Select All ...` and Gmail throttles aggressive
selections. The official Gmail API can `batchModify` 1,000 messages per call but
exposes no decision-making. We add the missing piece: a layered LLM classifier
that decides **what to trash, what to keep, what to unsubscribe from, and what
to label**, then issues the API calls.

### Goals

1. **Be reversible.** All deletions go to Trash (Gmail retains 30 days). No
   `messages.delete`. Ever.
2. **Be cheap.** ~$100–$300 one-time LLM cost on a 200K mailbox, free thereafter.
3. **Be safe.** Never feed email bodies to a model — only headers and subject.
   Bodies are untrusted user content that can contain prompt-injection payloads.
4. **Be resumable.** A 2-hour fetch shouldn't have to start over because Wi-Fi
   blipped at minute 90.
5. **Be honest about what it can't do.** RFC 8058 one-click unsubscribe works
   for ~30% of senders. The rest need a human or a browser bot, and we say so.

### Non-goals

- Real-time inbox monitoring. This is a batch tool you run when you want to
  clean up, not a daemon.
- Spam *detection*. Gmail's classifier is already excellent; we trust the
  `Spam`/`Promotions`/`Updates`/`Social` buckets it produces and route from there.
- Replying or composing. Scope is strictly read-headers and modify-labels.
- Permanent deletion. We always Trash, never `expunge`.

---

## Architecture

### The pipeline

```
                              GMAIL API (gws CLI)
                                     │
                                     │  format=metadata, metadataHeaders=[...]
                                     │  ↳ enforced at API level — body never leaves Google
                                     ▼
                          ┌─────────────────────┐
                          │  Header Fetcher     │   resumable, 8-way concurrent
                          │  → headers.jsonl    │   streams to disk, no memory bloat
                          └──────────┬──────────┘
                                     │
                                     ▼
                          ┌─────────────────────┐
                          │  Bucket Router      │   free, deterministic
                          │  Inbox / Promotions │
                          │  Social / Updates   │
                          └──────────┬──────────┘
                                     │
                                     ▼
                ┌──────────────────────────────────────────┐
                │  HAIKU BASKET     drains at 1,000        │
                │  10 parallel Claude Haiku 4.5 agents     │
                │  Output: trash / keep / unsub / unclear  │
                └──────────┬───────────────────┬───────────┘
                  trash    │  keep │ unsub     │ unclear
                           ▼       ▼   ▼       ▼
                       [Gmail batchModify]  ┌──────────────────────────────┐
                                            │  SONNET BASKET   drains at 500 │
                                            │  10 parallel Sonnet 4.6        │
                                            │  drop/keep/label/organize/unsub│
                                            └──────────┬───────────┬─────────┘
                                                       │           │ unclear
                                                       ▼           ▼
                                                 [actions]   ┌──────────────────────┐
                                                             │  OPUS BASKET  drains @ 100│
                                                             │  4 parallel Opus 4.7      │
                                                             │  Final arbiter            │
                                                             └─────┬─────────┬───────────┘
                                                                   │         │ unclear
                                                                   ▼         ▼
                                                             [actions]  needs_review.csv
```

### Action types

Every classifier tier emits one of:

| Action | What we do | Reversible? |
|---|---|---|
| `trash` | `batchModify addLabelIds=["TRASH"]` | Yes — Trash retains 30 days |
| `keep` | No-op (leave in current state) | n/a |
| `unsubscribe` | RFC 8058 one-click POST to `List-Unsubscribe` URL, *then* trash | Partial — unsub is sticky |
| `label:<name>` | Apply or create label, leave in Inbox | Yes — relabel anytime |
| `archive` | Remove `INBOX` label, keep elsewhere | Yes |
| `unclear` | Escalate to next tier | n/a |

### Queue semantics

- **Batches drain at thresholds**, not on a timer. A basket waits until it has
  enough work to keep all parallel agents busy.
- **Backpressure**: if Sonnet falls behind, Haiku pauses. We never let an
  ambiguous-message queue grow unboundedly.
- **Failure isolation**: an LLM call that errors out marks its messages as
  `unclear` and they escalate naturally. No retry storms.
- **Idempotent**: every message ID is recorded in `out/decisions.jsonl` with
  tier and outcome. Re-running skips already-decided IDs.

---

## Safety model

This section describes the load-bearing safety properties of the tool. If you
skim anything in this README, skim this.

### 1. Header-only is enforced at the API, not just our code

Every Gmail read uses `format=metadata` with an explicit `metadataHeaders=[...]`
allowlist. Gmail's server never returns the body. Even if our code had a bug
that asked for the body, Gmail would reject the request.

The full list of headers we request:

```
From, Subject, Date, List-Unsubscribe, List-Unsubscribe-Post,
Precedence, X-Mailer, Reply-To, Authentication-Results
```

### 2. Body content never enters an LLM prompt

LLM tier prompts contain: sender email, sender domain, subject, date, plus
boolean flags derived from headers (has-list-unsubscribe, no-reply, etc.). No
snippets. No body. No attachment names.

### 3. Destructive operations require an approval gate

Until you explicitly approve `out/cleanup_plan.md`, no `batchModify` runs.
After approval, all moves go to Trash (Gmail's recoverable bucket) — never
`messages.delete` (permanent).

### 4. OAuth scope discipline

`gws auth login` requests `gmail.modify`, *not* `gmail.readonly` or `mail.google.com`.
This means:

- We can read metadata and move messages between labels (including Trash).
- We cannot read message bodies via the OAuth scope at all.
- We cannot permanently delete messages.

### 5. Reversibility checklist

- Trash retains messages for 30 days — recover via Gmail UI.
- Label additions/removals are reversed by removing/adding the label.
- Unsubscribe POSTs are *not* reversible at the protocol level. If you change
  your mind, you'll need to manually re-subscribe via the sender's website.

---

## Cost estimate

### Google APIs

**Free at this scale.** Gmail API daily quota is 1 billion quota units. A full
200K-message mailbox scan + cleanup uses approximately 250K units, well under
0.05% of the daily ceiling.

### Claude (LLM tiers)

Classification runs inside a **Claude Code session** via the Agent tool —
not via the Anthropic API SDK. There is no separate API key to manage and no
per-token bill outside your existing Claude Code plan. Usage counts against
your plan's monthly quota (Pro, Max, Team, etc.).

The orchestrator (Claude, in your session) reads `out/headers.jsonl` and
dispatches parallel sub-Agents with `model: "haiku" | "sonnet" | "opus"` —
ten Haiku in one wave, ten Sonnet when their basket fills, four Opus when
theirs does — all via tool calls in a single message, executed in parallel,
results streamed back to disk.

**Tradeoff**: classification only progresses while a Claude Code session is
open and attended. Closing the terminal mid-run pauses the pipeline. For a
one-shot inbox cleanup, that's fine — it's a few hours of attended work.
Heavy users on metered plans should consult their plan's usage caps before
running against a very large mailbox.

---

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| Node.js ≥ 22 | Runtime | `brew install node` |
| pnpm ≥ 9 | Package manager | `brew install pnpm` |
| gcloud CLI | OAuth bootstrap | `brew install --cask google-cloud-sdk` |
| A Google account | The mailbox to clean | — |
| A GCP project with an active billing account | Service Usage API requires it | `gcloud projects create ...` |
| Claude Code session | Runs the LLM classification tiers as parallel Agents | https://claude.com/code |

> **Note**: "Active billing" doesn't mean "you'll pay" — Gmail API is free.
> But Google requires an open billing account *exist* to authorize Service Usage
> calls. Free trial credit ($300) covers this comfortably.

---

## GCP Setup

You need a GCP project with OAuth credentials so the tool can call the Gmail
API on your behalf. The Gmail API itself is free, but Google requires an active
billing account before it will authorize any API consumption. You will not be
charged for normal use of this tool.

> **Time estimate:** 15–20 minutes, one-time.

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

This opens a browser window. Sign in with the Google account that owns the
Gmail inbox you want to clean.

### 3. Create a GCP project

```bash
gcloud projects create YOUR_PROJECT_ID --name="Gmail Cleaner"
```

Pick any globally unique `YOUR_PROJECT_ID` (e.g. `gmail-cleanup-2026`). You
will use it in every subsequent command, so choose something short.

### 4. Set it as the active project

```bash
gcloud config set project YOUR_PROJECT_ID
```

### 5. Link a billing account

Open the billing console and attach an active billing account to your project:

```
https://console.cloud.google.com/billing/linkedaccount?project=YOUR_PROJECT_ID
```

> **Why is billing required if the API is free?** Google's Service Usage API —
> which governs whether a project is allowed to consume any Google service —
> refuses to authorize API calls unless the project has an open billing
> account. The Gmail API costs $0 at this scale, but the billing account must
> exist and be **active** (not suspended, not pending). A free-trial account
> with the $300 credit is fine.
>
> **Propagation delay:** After linking billing, wait 2–3 minutes before
> running the next step. The Service Usage Consumer role can take a moment to
> propagate and you may see a `PERMISSION_DENIED` if you proceed immediately.

### 6. Enable the Gmail API

```bash
gcloud services enable gmail.googleapis.com --project=YOUR_PROJECT_ID
```

### 7. Configure the OAuth consent screen

Open the consent screen configuration:

```
https://console.cloud.google.com/apis/credentials/consent?project=YOUR_PROJECT_ID
```

Fill in the form:

- **User type:** External
- **App name:** anything descriptive (e.g. `Gmail Cleaner`)
- **User support email:** your-email@gmail.com
- **Developer contact email:** your-email@gmail.com
- Leave all other fields blank and click **Save and Continue** through Scopes.
- **Publishing status:** leave as **Testing** — this avoids a Google
  verification review that can take weeks.
- Under **Test users**, click **Add Users** and add your own Gmail address.
  Only listed test users can complete the OAuth flow while the app is in
  Testing mode.

> **"App not verified" warning:** When you complete the browser consent flow
> in step 10, Google will show a warning screen. This is expected for any app
> in Testing mode. Click **Advanced** → **Go to [App name] (unsafe)** to
> proceed. The warning disappears once the app is published, but you do not
> need to publish it for personal use.

### 8. Create OAuth client credentials

Open the credentials page:

```
https://console.cloud.google.com/apis/credentials?project=YOUR_PROJECT_ID
```

Click **Create Credentials → OAuth client ID**:

- **Application type:** Desktop app ← this is critical
- **Name:** anything (e.g. `gmail-cleaner-desktop`)
- Click **Create**

Copy your **Client ID** and **Client Secret** from the dialog that appears.

> **Desktop app is required.** If you choose Web application instead, the
> OAuth redirect flow will fail when `gws auth login` tries to receive the
> callback on `localhost`. Desktop app clients handle the local redirect
> correctly.

### 9. Hand the credentials to `gws auth setup`

```bash
./node_modules/.bin/gws auth setup
```

When prompted, paste the **Client ID** then the **Client Secret** you copied
in the previous step.

### 10. Complete the browser consent flow

```bash
./node_modules/.bin/gws auth login
```

A browser window opens, you sign in, grant the `gmail.modify` scope, and the
CLI writes an encrypted refresh token to `~/.config/gws/credentials.enc`.
You will not need to repeat this step unless you revoke the token.

---

## Setup

### One-time

```bash
# 1. Clone + install
git clone https://github.com/YOUR_GITHUB_USERNAME/claude-gmail-cleaner.git
cd claude-gmail-cleaner
pnpm install                               # installs gws CLI + tsx into node_modules

# 2. Complete all steps in GCP Setup above, then verify auth works:
pnpm preflight

# 3. Env vars
cp .env.example .env
# Edit .env:
#   GOOGLE_WORKSPACE_PROJECT_ID=YOUR_PROJECT_ID  (optional quota-project override)
#   CLEANUP_MAX_MESSAGES=2000                    (optional cap while iterating)
```

A successful `pnpm preflight` prints your mailbox total and confirms reads are
in metadata mode.

### Per-run

Nothing. Tokens are encrypted at `~/.config/gws/credentials.enc` and refresh
automatically.

---

## Usage

The pipeline mixes Node commands (deterministic I/O) with Claude orchestration
(LLM classification). Each step is resumable; each writes to `out/` and
`log_results/`.

### Step 1 — Node-side preparation

```bash
pnpm preflight                       # verify install, auth, env
pnpm labels                          # list user-defined Gmail labels
pnpm baseline                        # year/category counts (default: last 10 years)
pnpm baseline --years 5              # narrow to the last 5 years
pnpm baseline --years 2018-2026      # explicit range (either direction)
pnpm fetch                           # fetch headers for all messages (resumable)
pnpm fetch "category:promotions"     # or scope by Gmail search query
```

After `pnpm baseline`, in a Claude Code session say **"analyze baseline"** —
a Haiku sub-agent (prompt at `src/prompts/baseline-analyze.md`) reads the
deterministic counts and writes `out/baseline_analysis.md` with a recommended
first-sweep year range, category filter, and a ready-to-paste fetch query.

After `pnpm fetch`, `out/headers.jsonl` contains every message's headers,
ready for classification.

### Step 2 — Claude-side classification (in a Claude Code session)

Open a Claude Code session at the project root and say `classify`. The
orchestrator will:

1. Read `out/headers.jsonl` in batches of 1,000
2. Spawn **10 Haiku sub-Agents in parallel** (one tool message, ten calls)
3. Collect their JSON verdicts → write `out/decisions.jsonl`
4. When 500 "unclear" verdicts accumulate, spawn **10 Sonnet sub-Agents**
5. When 100 Sonnet-unclear accumulate, spawn **4 Opus sub-Agents**
6. Anything Opus still can't decide goes to `out/needs_review.csv`

Tier system prompts live in `src/prompts/{haiku,sonnet,opus}.md` — edit them
to tune behavior without re-fetching headers.

### Step 3 — Node-side execution

```bash
pnpm plan                # produce out/cleanup_plan.md from decisions.jsonl
# (review the plan)
pnpm execute --test      # apply first 100 actions, then prompt yes/no for the rest
pnpm execute --confirm   # full run, no prompt
```

`pnpm execute` refuses to run without `--test` or `--confirm`. Always start
with `--test` on a fresh dataset: it trashes the first 100 candidates, then
asks you to review your Trash folder before continuing. Type `yes` to
proceed with the remainder, `no` to abort. Trash is recoverable for 30 days
either way.

### Iteration loop

Re-classify a cached dataset cheaply (no Gmail calls) by tweaking the prompts
in `src/prompts/` and re-running classification in your Claude Code session.

This is the design point of separating fetch from classify: header fetching
costs Gmail quota; classification costs Claude usage. Keep them independent
so prompt iteration is free of Gmail calls.

---

## Outputs

Two directories, two lifecycles:

### `out/` — working data (gitignored)

Resumable artifacts. Re-running a command updates these in place.

| File | Purpose |
|---|---|
| `baseline.json` | Per-year + per-category counts before action |
| `headers.jsonl` | One header record per line, resumable cache |
| `decisions.jsonl` | Per-message: tier reached, action, model confidence |
| `sender_index.csv` | Aggregated per-sender: count, signals, recommendation |
| `cleanup_plan.md` | Human-readable approval document |
| `needs_review.csv` | Senders Opus couldn't confidently classify |

### `log_results/` — per-run history (gitignored)

Append-only. One file per command invocation, ISO 8601 timestamped for free
chronological sorting:

```
log_results/
├── 2026-05-23T10-30-45_preflight.md
├── 2026-05-23T10-31-12_baseline.md
├── 2026-05-23T10-45-09_fetch.md
├── 2026-05-23T12-15-22_classify.md
├── 2026-05-23T12-32-08_plan.md
└── 2026-05-23T13-01-50_execute.md
```

Each report contains the run's stat block — total messages touched, tier
breakdown, Gmail quota used, wall-clock duration, any errors. Example:

```markdown
# Run report — `execute`

**Started:**  2026-MM-DDTHH:MM:SSZ
**Finished:** 2026-MM-DDTHH:MM:SSZ
**Duration:** 14m 43s

## Metadata
- **Mode:** full
- **Trashed:** 89,234
- **Archived:** 1,805

## Outcome
| Action  | Messages |
|---------|---------:|
| Trash   |   89,234 |
| Archive |    1,805 |
| Label actions deferred | 412 |
```

---

## File layout

```
claude-gmail-cleaner/
├── README.md                       <- you are here
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── cli.ts                      <- subcommand dispatcher
│   ├── preflight.ts                <- step 1
│   ├── labels.ts                   <- step 2
│   ├── baseline.ts                 <- step 3
│   ├── fetch.ts                    <- step 4
│   ├── classify.ts                 <- step 5 — orchestrates Haiku→Sonnet→Opus
│   ├── plan.ts                     <- step 6
│   ├── execute.ts                  <- step 7
│   ├── prompts/
│   │   ├── haiku.md                <- tier 1 system prompt (loaded into sub-Agents)
│   │   ├── sonnet.md               <- tier 2 system prompt
│   │   └── opus.md                 <- tier 3 system prompt
│   └── lib/
│       ├── gws.ts                  <- Gmail API wrapper (header-only enforced)
│       ├── unsubscribe.ts          <- RFC 8058 one-click POST handler
│       ├── report.ts               <- per-run stat-report writer to log_results/
│       └── types.ts                <- shared types
├── out/                            <- gitignored — working data, resumable
└── log_results/                    <- gitignored — append-only run history
```

---

## Tradeoffs & non-goals

### Why pure LLM tiering instead of rules-first hybrid

A regex pre-filter could cheaply trash 70% of bulk before any LLM touches it.
This tool deliberately omits that pre-filter and routes every message through
the LLM tiers. The pure pipeline is easier to reason about, removes a class
of false-positive risk (regex misclassifying a real message as bulk), and
trusts LLM judgment uniformly. Users who want a faster, cheaper path can
fork and add the pre-filter.

### Why Haiku / Sonnet / Opus over multi-vendor model routing

Single-vendor dependency simplifies error handling, prompt caching, and
billing reconciliation. Cross-vendor model routing adds operational complexity
that doesn't pay off for a focused single-task tool.

### Why we don't unsubscribe everything

RFC 8058 one-click unsubscribe is supported by ~30% of bulk senders. The rest
either:
- Use the old RFC 2369 mailto form (we'd have to send mail back, easy to do
  badly)
- Require a browser visit to a hosted unsubscribe page (out of scope for a
  header-only tool)

We do what's safe and reliable, and we trash the rest. Future sender mail still
goes to Trash via a filter we install.

### Why not feature flags / staged rollout

This is a single-operator, attended-execution tool — not a service. Production-
style gating (canary slices, percentage rollouts, kill switches) would be
ceremony. The approval gate is `cleanup_plan.md`; the safety net is
`--test` mode + Gmail's 30-day Trash retention.

---

## Roadmap

This repo is the first of a planned **Google Debloater Suite**. Same patterns
(header-only safety, tiered LLM routing, gws CLI, GCP project) get reused for:

| Tool | Status | Notes |
|---|---|---|
| `claude-gmail-cleaner` | **In progress** (this repo) | |
| `claude-photos-debloater` | Planned | Photos API removed delete in 2025 — needs Takeout flow or browser automation |
| `claude-drive-debloater` | Planned | Mass file/folder cleanup with size+age scoring |
| `claude-calendar-debloater` | Planned | Old recurring events, spam invites |
| `claude-contacts-deduper` | Planned | Dedupe the inevitable duplicate-contact sprawl |

---

## Troubleshooting

### `PERMISSION_DENIED` / `Caller does not have required permission to use project`

Your GCP project is missing an active billing account, or the
`Service Usage Consumer` role hasn't propagated yet (can take up to ~15 minutes
on personal Google accounts). Two ways to fix:

1. Open https://console.cloud.google.com/billing and confirm an active
   billing account is linked to your project. Then wait ~5 minutes and retry.
2. As a workaround, route quota to a different project you own:
   ```bash
   echo "GOOGLE_WORKSPACE_PROJECT_ID=your-other-project-id" >> .env
   pnpm preflight
   ```
   You only need Gmail API enabled on the override project.

### `accessNotConfigured` / `API has not been used in project`

Gmail API isn't enabled on the project gws is routing quota to. Enable it:

```bash
gcloud services enable gmail.googleapis.com --project=YOUR_PROJECT_ID
```

### `Access blocked: ... has not completed the Google verification process`

Your OAuth consent screen is in Testing mode (correct for personal use) but
your Gmail address isn't on the Test Users list. Add it at
https://console.cloud.google.com/auth/audience?project=YOUR_PROJECT_ID

### `pnpm setup` fails on Homebrew-installed pnpm

Homebrew-managed pnpm can't self-install into `~/Library/pnpm`. You don't
need `pnpm setup` for this project — gws is a local devDep, not a global
binary. Just `pnpm install` is enough.

### `gws not found in node_modules/.bin`

You haven't run `pnpm install` yet, or the install failed. Verify:

```bash
ls node_modules/.bin/gws
```

If missing, run `pnpm install` again and watch for postinstall script errors.

---

## Security

This tool requests OAuth scope `gmail.modify`, which can move and label
messages in your mailbox. It cannot read message bodies (scope intentionally
excludes `gmail.readonly` and `mail.google.com`) and cannot permanently
delete anything (only `addLabelIds=["TRASH"]`, recoverable for 30 days).

### Reporting vulnerabilities

If you find a security issue — credential leakage, scope expansion,
classification-routing exploit, anything that could expose user data — please
**do not file a public issue**. Instead, contact the maintainer privately
through the repository's security advisory feature (if available) or via the
contact listed in the repository's metadata.

### Threat model

In scope:

- Prompt injection via email **header content** — mitigated by structured
  parsing and limiting LLM input to a fixed allowlist of header fields.
- Token exfiltration — mitigated by gws's AES-256-GCM encryption of
  credentials and OS keyring storage of the encryption key.
- Mistaken classification → mass trashing — mitigated by `--test` mode,
  approval gate, and Gmail's 30-day Trash retention.

Out of scope:

- A compromised local user account (anyone with access to `~/.config/gws/` and
  the OS keyring can call Gmail with your scope).
- A compromised GCP project (anyone who can modify the OAuth client
  configuration could redirect the consent flow).

---

## Contributing

Issues and pull requests welcome. Before submitting:

- Read `CLAUDE.md` for project conventions (header-only safety, JSONL
  streaming, ISO-8601 log filenames, no Anthropic SDK).
- Run `pnpm preflight` before opening a PR to confirm the basics still work.
- Keep changes scoped — large refactors should be discussed in an issue first.
- Don't introduce dependencies without a strong justification. The current
  `package.json` is intentionally minimal (`dotenv` only at runtime).

### Branching

Work off `main`. Feature branches named `<topic>` are fine. No need for
prefixes like `feat/` or `fix/`.

### Commit messages

Imperative present-tense, brief: "add labels-delete subcommand", "fix gws
binary resolution under non-cwd invocation". One commit per logical change.

---

## License

MIT. See [LICENSE](LICENSE).

---

## Acknowledgements

- [@googleworkspace/cli](https://github.com/googleworkspace/cli) — without
  dynamic-Discovery-Service command generation this would be a thousand lines
  of curl + jq.
- [RFC 8058](https://datatracker.ietf.org/doc/html/rfc8058) — one-click
  unsubscribe spec.
- Google for not shipping a "delete most of this" button, thereby creating the
  reason for this repo's existence.
