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
| `agentDesk.messageStore` | `postgres` or `file` |
| `agentDesk.settingsStore` | Labels backend |
| `agentDesk.emergency` | Host emergency inbox flag |

`PUBLIC_BASE_URL` wins; otherwise Render injects `RENDER_EXTERNAL_URL`. No trailing slash.

## Webhook

`GET /webhook` — Meta subscribe handshake (`hub.verify_token` must equal `WHATSAPP_VERIFY_TOKEN`).

`POST /webhook`:

1. Verify `X-Hub-Signature-256` against **raw** JSON (`req.rawBody`). Production without `WHATSAPP_APP_SECRET` → **503**. Bad signature → **403**.
2. Respond **200 immediately**, then process. Slow FSM/Graph work must not hold Meta’s retry timer.
3. Only `object=whatsapp_business_account` entries with `messages[]` are handled.
4. Extracted types: `text`, `interactive` (button/list reply), `order` (catalog cart), `image`, `document`. Anything else is skipped (no row, no FSM).
5. Customer media is stored for the desk and **does not** enter the menu tree.
6. Text/interactive/order are appended to the transcript, then `FsmEngine.handleInbound`.

### Dedupe (`src/webhook/inboundDedupe.js`)

Meta delivers at-least-once. Dedupe key is WhatsApp `message.id` (wamid), in-memory, 48h TTL.

| Phase | Meaning |
|---|---|
| `begin(id)` | Reserve while handling. Duplicate in-flight/done → skip |
| `commit(id)` | Success — retries of this wamid are ignored |
| `release(id)` | Failure — Meta may retry and we will handle again |

Committing **before** `handleInbound` finishes used to drop the only copy of a message when Graph/session write threw. Do not “optimize” that back.

No `message.id` → process anyway (cannot dedupe). Map is per process: two Render instances can double-handle; this host is assumed single-process.

## Sessions (`src/session/store.js`)

Default `SESSION_STORE=file` under `data/sessions/{wa}.json`. Atomic write (temp + rename). TTL `SESSION_TTL_MS` (24h).

**Not expired** while `pendingLead` or `pendingTerminalOutbound` is set — those are the only durable copies of a CRM row / undelivered application-link send.

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
