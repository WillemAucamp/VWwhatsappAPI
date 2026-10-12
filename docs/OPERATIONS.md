# Operations runbook

Day-2 behaviour for the Melrose Cloud API bot: process layout, webhook contract, sessions, follow-ups, and failure modes. Pair with [META_SETUP.md](./META_SETUP.md) (plug-in) and [AGENT_DESK.md](./AGENT_DESK.md) (staff inbox).

## Process

```
node src/index.js
  createApp()                    src/app.js
  FollowUpScheduler.start()      30m then every 4h, max 3 (defaults)
  labelBackfill.start()          funnel tags off the inbox request
  prepareCatalogForMessaging()   link catalog to WABA + visibility
```

Listen: `GET /health`, `GET|POST /webhook`, `GET /agent`.

| Signal | Effect |
|---|---|
| `SIGINT` / `SIGTERM` | Stop scheduler + backfill, close HTTP, exit 0 |

`NODE_ENV=production` forces webhook HMAC even if you forget `WHATSAPP_APP_SECRET` (POST then returns 503).

## Health (`GET /health`)

No secrets. Process-local counters reset on every deploy.

Useful fields:

| Path | Meaning |
|---|---|
| `ok` | Process is up |
| `build.fsm` / `build.commit` | Deploy marker + Render git SHA when present |
| `meta.canSend` / `missing` | Token + phone-number ID + copy |
| `meta.webhookUrl` | `{PUBLIC_BASE_URL\|RENDER_EXTERNAL_URL}/webhook` |
| `catalog.ok` / `productCount` | Live Meta catalog probe (`ensureVisible`) |
| `webhook.lastSendError` | Last Graph failure (code 190 = bad/expired token) |
| `webhook.postRejectedSignature` | App secret mismatch |
| `webhook.transcriptAppendFailures` | Desk transcript writes that failed (also on `/agent/api/status`) |
| `webhook.lastTranscriptAppendError` | Last append error string (process-local; resets on deploy) |
| `webhook.lastSkippedInboundType` | Last inbound type stored as a desk placeholder (`audio`, `sticker`, …) |
| `agentDesk.messageStore` | `postgres` or `file` |
| `agentDesk.settingsStore` | Labels backend |
| `agentDesk.shortcutStore` | Shortcuts backend (`postgres` when `DATABASE_URL` is set) |
| `agentDesk.inboxList` | Deploy marker — currently `reads-survive-refresh-2026-09-17` |
| `agentDesk.emergency` | Host emergency inbox flag |

`PUBLIC_BASE_URL` wins; otherwise Render injects `RENDER_EXTERNAL_URL`. No trailing slash.

## Webhook

`GET /webhook` — Meta subscribe handshake (`hub.verify_token` must equal `WHATSAPP_VERIFY_TOKEN`).

`POST /webhook`:

1. Verify `X-Hub-Signature-256` against **raw** JSON (`req.rawBody`). Production without `WHATSAPP_APP_SECRET` → **503**. Bad signature → **403**.
2. Respond **200 immediately**, then process. Slow FSM/Graph work must not hold Meta’s retry timer. **A 200 means Meta will not redeliver.** Local `dedupe.release` only lets *this process* handle the same wamid if it arrives again; it does not summon a Meta retry.
3. Only `object=whatsapp_business_account` entries with `messages[]` are handled.
4. Extracted types: `text`, `interactive` (button/list reply), `order` (catalog cart), `image`, `document`. Other types (`audio`, `video`, `sticker`, `location`, …) are stored as a desk placeholder (`[Audio]`, …) with `skipFsm` — they never enter the menu. `/agent/api/status` → `lastSkippedInboundType`.
5. Customer **image/document** is stored for the desk (bytes when Graph download works) and **does not** enter the menu tree. Download runs **after** the 200. On failure the desk gets `[Image]` / `[Document: …] (media unavailable)` with **no Graph `mediaId`** — the bytes are gone unless the customer resends.
6. Text/interactive/order call `persistDeskRow` **before** `dedupe.begin`, then `FsmEngine.handleInbound`. The append result is **not** checked: a transcript failure still runs the funnel and `commit`s, so Meta will not retry and the desk can miss the inbound line. Redelivery after a successful `commit` can append a **duplicate** desk row (the first append already happened outside the begin/commit window).
7. Skip-FSM placeholders fail-closed: if the store cannot save, the wamid is `release`d. That only helps if Meta (or another worker) delivers the wamid again — the HTTP 200 already went out.

### Dedupe (`src/webhook/inboundDedupe.js`)

Meta delivers at-least-once **until it sees 200**. Dedupe key is WhatsApp `message.id` (wamid), in-memory, 48h TTL.

| Phase | Meaning |
|---|---|
| `begin(id)` | Reserve while handling. Duplicate in-flight/done → skip |
| `commit(id)` | Success — later deliveries of this wamid skip the engine |
| `release(id)` | Local failure — this process will handle the wamid if it is delivered again |

Committing **before** `handleInbound` finishes used to drop the only copy of a message when Graph/session write threw. Do not “optimize” that back. On the live FSM path, though, `commit` still fires even when the earlier desk append failed (see step 6).

No `message.id` → process anyway (cannot dedupe). Map is per process: two Render instances can double-handle; this host is assumed single-process.

## Sessions (`src/session/store.js`)

Default `SESSION_STORE=file` under `data/sessions/{wa}.json`. Atomic write (temp + rename). TTL `SESSION_TTL_MS` (24h).

**Not expired** while `pendingLead` or `pendingTerminalOutbound` is set — those are the only durable copies of a CRM row / undelivered application-link send. `agentTakenOver` is **not** TTL-exempt: after 24h (or a Render free disk wipe) the hold is gone and the bot will talk again until staff Take over.

`SESSION_STORE=redis` exists in code but `ioredis` is not a package.json dependency. Production on Render is the file store (ephemeral unless you attach a disk).

Status values: `new` → `active` → `soft_closed` | `quiet`. `agentTakenOver` is a separate flag.

| Situation | Bot behaviour |
|---|---|
| First inbound ever | Always **greeting** (free text never skips to off-menu on a brand-new session) |
| `agentTakenOver` | Ignore inbound except retry of `pendingTerminalOutbound`. No `hi` restart |
| `quiet` without takeover | `hi`/`hello`/`restart`/`start` reopen; else a quiet notice |
| `soft_closed` | Qualify Me / specials / opt-out taps honoured; other free text → off-menu recovery |
| Off-menu recovery | Buttons: Human-Handover / Main-Menu |

Terminal Graph failures persist `pendingTerminalOutbound`. The scheduler retries even if the customer never messages again (they already answered the last question).

`pendingLead` is written **before** `logLead`. If CRM write fails, the next inbound or scheduler tick flushes it. `lastLoggedLeadKey` prevents a double CRM row after restart.

## Follow-ups

While `status=active`, waiting on a non-terminal question, not taken over:

| Env | Default | Role |
|---|---|---|
| `FOLLOW_UP_ENABLED` | `true` | Master switch |
| `FOLLOW_UP_FIRST_MS` | 30 min | First nudge |
| `FOLLOW_UP_INTERVAL_MS` | 4 h | Later nudges |
| `FOLLOW_UP_MAX` | 3 | Cap |
| `FOLLOW_UP_POLL_MS` | 60 s | Scheduler tick |
| `FOLLOW_UP_INCLUDE_PROMPT` | `true` | Re-attach the current question |

Each tick also flushes `pendingLead` and retries `pendingTerminalOutbound`. One session’s throw does not abort the rest of the tick.

## FSM pitfalls (do not “fix” without tests)

| Symptom | Actual rule |
|---|---|
| First “hello” showed off-menu | Must go to greeting when `status=new` / no `currentState` |
| Soft-closed “ok” / “yes” restarted stocklist qualify | Those words are stocklist fallbacks; they must not fire unless the session is actually on `STOCKLIST_CAROUSEL` |
| Staff reply, then bot menu | `takeOver({ silent: true })` on desk send; `releaseToBot` is the only resume |
| Taken-over chat talks again after a quiet day | File sessions TTL 24h and Render disk wipes clear `agentTakenOver` — Take over again |
| “help” / “hi” inside a normal sentence handed over or reopened | Single-word `HELP_INTENT_KEYWORDS` / `REOPEN_KEYWORDS` are whole-word-in-sentence (`please help me` matches). Punctuation is stripped for keywords (`Hello!` matches `hello`). |
| “can I opt outside …” handed over | Multi-word keywords still use substring `includes` (`opt out` matches inside `opt outside` / `adopt outlet`). Taps are safe; free-text that merely contains the phrase is not. |
| Free-text `Yes!` / `Good!` went to Human-Handover | `matchOption` compares exact `normalizeInput` strings and **keeps punctuation**. Button taps still work. Typed `Yes!` / `yes.` / `Good!` miss `Yes` / `Good`, hit off-menu (`MAX_INVALID_ATTEMPTS` default 1), then silent hold. |
| Customer photo became `(media unavailable)` forever | Graph download runs after the webhook 200. One 502/timeout writes a text placeholder, drops the Graph media id, and Meta will not retry. Ask the customer to resend. |
| Funnel moved but desk missed the inbound line | FSM path appends, then `begin`/`handleInbound`/`commit`, and ignores append failure. Check `webhook.transcriptAppendFailures`. |
| Duplicate inbound bubbles for one tap | FSM appends **before** `dedupe.begin`. Meta redelivery after `commit` skips the engine but can append again. |
| Application link sent twice | `joinTextAndLink` skips the URL if copy already contains it |
| Duplicate CRM lead after restart | `pendingLead` + `lastLoggedLeadKey`; TTL must not purge queued leads |
| Interactive tap does nothing | Stale button ids from an older prompt are rejected; webhook must subscribe to **messages** |
| See our cars missing | Greeting `interactiveOptions` is Qualify Me + I saw a special only. Stocklist state still exists for leftover buttons / later re-enable |

Menu tree: `src/fsm/states.js`. Copy: `src/content/copy.js`. Engine: `src/engine/fsmEngine.js`. Tests: `npm test` (`tests/run.js`).

## Catalog

Boot calls `prepareCatalogForMessaging()` (link catalog to WABA, commerce visibility). **See our cars** sends a live Meta `product_list`. Customer product inquiry/order stores `selectedProductRetailerId` and continues into `EMPLOYED_INCOME_CHECK`.

`STOCK_LINK` is fallback only when the catalog is empty or Graph product_list fails. Confirm with `npm run check:catalog` and `/health` → `catalog`.

## Leads

`LEAD_LOGGER=file` → `data/logs/leads.jsonl` (also ephemeral on Render free). Console/json alternatives exist. Qualification still depends on session `pendingLead` until flush succeeds.

## Local commands

```bash
cp .env.example .env
npm install
npm test
npm start
npm run check:meta
npm run check:catalog
npm run send:test -- --to 2782XXXXXXXX --template hello_world
```

Node 18+ (Docker uses 20-slim).
