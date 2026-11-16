# Operations runbook

Day-2 behaviour for the Melrose Cloud API bot: process layout, webhook contract, sessions, follow-ups, and failure modes. Pair with [META_SETUP.md](./META_SETUP.md) (plug-in) and [AGENT_DESK.md](./AGENT_DESK.md) (staff inbox).

## Process

```
node src/index.js
  createApp()                    src/app.js
  FollowUpScheduler.start()      30m then every 4h, max 3 (defaults)
  labelBackfill.start()          every 20s, batch 2, tick ≤1.5s (defaults)
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
| `webhook.postRejectedNoSecret` | Production POST with no `WHATSAPP_APP_SECRET` (503) |
| `webhook.lastInboundFrom` | Last extracted WA, last 4 digits visible |
| `webhook.lastCatalogError` / `lastCatalogMode` | Last Graph catalog/link/visibility failure |
| `webhook.inboundHandleErrors` | FSM/media handler throws after the HTTP 200 |
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
8. On bulk-select **hold-revive** hosts, `createWebhookRouter` receives `chatMetaStore`. After a desk placeholder or FSM append, `reviveChatMetaOnInbound` clears `deleted_at` / `archived_at` for that number (media, skip-FSM, and menu paths). Soft-delete does not erase transcripts; without revive, new inbound rows land in a list/search black hole. Live without bulk has no `chatMetaStore` and skips this step.

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
| Off-menu recovery | Buttons: Human-Handover / Main-Menu. A **second** unmatched free-text (`_handleInvalid` while already on this menu) is silent `HUMAN_HANDOVER` + `agentTakenOver`. |
| Desk bulk **Delete** | `FsmEngine.clearAgentHold` drops `agentTakenOver` **without** resume/restart. Required so a hidden thread cannot leave the customer in silent hold after the ~10s undo window. The bot will talk again on the next inbound unless staff Take over. Live without bulk never calls this. |

Terminal Graph failures persist `pendingTerminalOutbound`. The scheduler retries even if the customer never messages again (they already answered the last question).

`pendingLead` is written **before** `logLead`. If CRM write fails, the next inbound or scheduler tick flushes it. `lastLoggedLeadKey` prevents a double CRM row after restart **only when that marker actually lands on disk**. If every `sessionStore.set` that would persist the marker fails, live `FileLeadLogger` still double-appends on the next process (see Leads).

## Follow-ups

`FollowUpScheduler` polls `sessionStore.listAll()` every `FOLLOW_UP_POLL_MS`. A nudge is due only when **all** of these hold (`nextFollowUpDueAt`):

- `status=active` (not `new` / `soft_closed` / `quiet`)
- not `agentTakenOver`, not `followUpsExhausted`
- `currentState` is a **non-terminal** menu and `lastBotMessageAt` is set
- first nudge: `lastBotMessageAt + FOLLOW_UP_FIRST_MS`; later: `(lastFollowUpAt || lastBotMessageAt) + FOLLOW_UP_INTERVAL_MS`

| Env | Default | Role |
|---|---|---|
| `FOLLOW_UP_ENABLED` | `true` | Master switch |
| `FOLLOW_UP_FIRST_MS` | 30 min | First nudge |
| `FOLLOW_UP_INTERVAL_MS` | 4 h | Later nudges |
| `FOLLOW_UP_MAX` | 3 | Cap (`followUpsExhausted` after this many sends) |
| `FOLLOW_UP_POLL_MS` | 60 s | Scheduler tick |
| `FOLLOW_UP_INCLUDE_PROMPT` | `true` | Re-attach the current question + continue prompt |
| `FOLLOW_UP_NOTIFY_ON_EXHAUSTED` | `false` | After the last nudge, POST `type=follow_up_exhausted` to the agent notify webhook |

The follow-up **slot is persisted before Graph send**. Graph failure rolls the count / `lastFollowUpAt` / exhausted flag back so the next tick retries. Graph success with a later session-write failure cannot double-nudge — the slot already landed. Copy keys: `follow_up_first` then `follow_up_repeat`, plus `help_footer`. Interactive buttons from the current state are re-attached when `buildInteractiveFromState` can.

Each tick also flushes `pendingLead` and retries `pendingTerminalOutbound`. One session’s throw does not abort the rest of the tick. Overlapping ticks return `{ skipped: true, reason: 'overlap' }`.

## Agent notify webhook

Optional CRM/Slack ping when a customer needs a human. Implementation: `notifyAgent` in `src/transport/whatsapp.js`. The bot does **not** WhatsApp the handover number; it only POSTs JSON.

| Env | Role |
|---|---|
| `AGENT_NOTIFY_WEBHOOK_URL` | POST JSON here. Empty → log `[agent-notify]` only (`delivered: false`, `reason: no_webhook`) |
| `AGENT_HANDOVER_NUMBER` | Copied onto the body as `agentHandoverNumber` (informational) |

**Handover** fires from `_finalizeTerminal` after `pendingLead` is on disk, only when `state.notifyAgent` is true:

| State | `exitReason` | Also set |
|---|---|---|
| `LICENSE_NO_HANDOVER` | `no_license` | `quiet` + `agentTakenOver` |
| `CREDIT_BAD_HANDOVER` | `credit_bad` | `quiet` + `agentTakenOver` |
| `CONSENT_NO_HANDOVER` | `declined_self_serve` | `quiet` + `agentTakenOver` |
| `HUMAN_HANDOVER` | `human_requested` | `quiet` + `agentTakenOver` |

Not notified: `END_CHAT_*` (unqualified / not ready) and `SEND_LINK` (self-serve form). Desk **Take over** / reply also skip this webhook — they are silent.

```json
{
  "type": "handover",
  "exitReason": "human_requested",
  "waNumber": "2782XXXXXXXX",
  "path": ["GREETING", "EMPLOYED_INCOME_CHECK"],
  "interruptedFrom": "CREDIT_CHECK",
  "agentHandoverNumber": null,
  "timestamp": "2026-11-16T16:00:00.000Z"
}
```

**Follow-up exhausted** (only if `FOLLOW_UP_NOTIFY_ON_EXHAUSTED=true`) after the last successful nudge:

```json
{
  "type": "follow_up_exhausted",
  "waNumber": "2782XXXXXXXX",
  "path": ["GREETING", "LICENSE_CHECK"],
  "currentState": "LICENSE_CHECK",
  "followUpCount": 3,
  "timestamp": "2026-11-16T16:00:00.000Z"
}
```

Constraints (live `51127ee`):

- No HMAC, no auth header, no `fetch` timeout.
- Non-2xx and network errors return `{ delivered: false }` and are **not retried**. There is no `pendingAgentNotify` on this deploy branch (that retry lives on unmerged `main` PR #17).
- A hanging receiver holds the **per-number** session lock until Node aborts the fetch. Meta already got 200; later inbound / follow-up for that WA waits. Other numbers continue.
- Every event is `console.log('[agent-notify]', …)` even when the URL is unset.

## Label backfill

Background funnel tags (`src/agent/labelBackfill.js`). Never runs on `GET /api/chats`. Off when `AGENT_DESK_EMERGENCY=true` or `AGENT_DESK_LABEL_BACKFILL=false`.

| Env | Default | Role |
|---|---|---|
| `AGENT_DESK_LABEL_BACKFILL` | `true` | Master switch (also forced off in emergency) |
| `AGENT_DESK_LABEL_BACKFILL_MS` | `20000` | Tick interval |
| `AGENT_DESK_LABEL_BACKFILL_BATCH` | `2` | Max chats labelled per tick |
| `AGENT_DESK_LABEL_BACKFILL_TICK_MS` | `1500` | CPU/IO budget per tick |

Each tick labels sessions that already have inferred funnel tags, then walks `messageStore.listWaNumbers` (cursor, in-process `done` set). Same `syncInferredDeskLabels` as thread open — staff-cleared funnel names come back. See [AGENT_DESK.md](./AGENT_DESK.md).

## FSM pitfalls (do not “fix” without tests)

| Symptom | Actual rule |
|---|---|
| First “hello” showed off-menu | Must go to greeting when `status=new` / no `currentState` |
| Soft-closed “ok” / “yes” restarted stocklist qualify | Those words are stocklist fallbacks; they must not fire unless the session is actually on `STOCKLIST_CAROUSEL` |
| Staff reply, then bot menu | `takeOver({ silent: true })` on desk send; `releaseToBot` is the only resume |
| Taken-over chat talks again after a quiet day | File sessions TTL 24h and Render disk wipes clear `agentTakenOver` — Take over again |
| Staff bulk-deleted a taken-over chat; customer silent forever | `delete` must call `clearAgentHold` and keep `GET /api/chats/:wa` at 200. Without that, `deleted_at` hides every list, thread GET 404s, and leftover `agentTakenOver` ignores inbound after the ~10s undo. Hold-revive also undeletes/unarchives on the next customer message. |
| “help” / “hi” inside a normal sentence handed over or reopened | Live `matchesKeywordList`: punctuation is stripped (`Hello!` → `hello`), then single-word `HELP_INTENT_KEYWORDS` / `REOPEN_KEYWORDS` are whole-word-in-sentence (`please help me` matches). Multi-word phrases still use substring `includes`. |
| Soft-closed “when can I start the paperwork?” restarted greeting | Live reopen words (`restart,start,hello,hi`) match as a whole word **anywhere** in the message, so `start` inside that sentence calls `_restart()` → `GREETING` and can double-log a CRM lead if they qualify again. The exact-reopen change passes `{ exactSingleWord: true }` on every `reopenKeywords` check: exact messages still reopen (`hi`, `Hello!`, `restart`); in-sentence uses go to off-menu / quiet notice. Help keywords stay whole-word-in-sentence on live. |
| “can I opt outside …” handed over | Multi-word keywords still use substring `includes` (`opt out` matches inside `opt outside` / `adopt outlet`). Taps are safe; free-text that merely contains the phrase is not. |
| Free-text `Yes!` / `Good!` went to Human-Handover | `matchOption` compares exact `normalizeInput` strings and **keeps punctuation**. Button taps still work. Typed `Yes!` / `yes.` / `Good!` miss `Yes` / `Good`, hit off-menu (`MAX_INVALID_ATTEMPTS` default 1), then silent hold. |
| Typed `ok` / `sure` / `yeah` / `yep` at Yes/Good steps | Same exact-label matcher. `EMPLOYED_INCOME_CHECK` / `LICENSE_CHECK` / `FINAL_CONSENT` yes lists are `yes`/`y`/`1` (plus send-it variants on consent). `CREDIT_CHECK` good is `good`/`great`/`excellent`/`1`. Spoken acks miss, enter off-menu, then silent hold — no application link, extra `human_requested` lead. |
| Greeting typed `3` opted out | Greeting is two buttons now, but `optionLabels.opt_out` still includes leftover numeral `3`. Typed `3` is Human-Handover + quiet hold. Taps are safe. |
| Typed `1` on Human-Handover / Main-Menu | `OFF_MENU_RECOVERY` and `QUALIFY_CONSENT_NO` map free-text `1` to **human_handover** (same digit as Yes on qualify menus). After a Yes/No typo, repeating `1` silent-holds. |
| Off-menu `no` / `thanks` / `I'm done` silent-held | Decline/closing phrases are **not** on `main_menu` labels. First unmatched text opens recovery; a second miss (`no thanks`, repeating `thanks`, …) calls `_routeToHuman` immediately. |
| Release after a false handover re-traps | Second-miss `_routeToHuman(session, state.id)` overwrites `interruptedFrom` with `OFF_MENU_RECOVERY`. That menu is `type: choice`, so `_isResumableStateId` treats it as a valid Release target. Next free-text hands over again. |
| Release re-asked employment after Main-Menu | `_handleInvalid` sets `interruptedFrom`. `_enterState` only writes that field when `fromInterrupt` is passed — Main-Menu → GREETING (and later funnel steps) never clear it. Desk takeOver/`_rememberResumePoint` prefer the stale bookmark. |
| Mid-funnel catalog tap / order went to hold | `productRetailerId` is applied **only** when `state.catalogProductList` is true (`STOCKLIST_CAROUSEL`). On employment/license/credit/soft_closed it is invalid input → off-menu → silent hold. The car id is dropped. |
| Graph sent a reply but desk lost the bubble | `loggingSend` in `src/app.js` swallows `messageStore.append` errors. `/agent` `/reply` and `/reply-media` still return `ok: true` after Graph OK. Check `webhook.transcriptAppendFailures`. |
| Customer photo became `(media unavailable)` forever | Graph download runs after the webhook 200. One 502/timeout writes a text placeholder, drops the Graph media id, and Meta will not retry. Ask the customer to resend. |
| Funnel moved but desk missed the inbound line | FSM path appends, then `begin`/`handleInbound`/`commit`, and ignores append failure. Check `webhook.transcriptAppendFailures`. |
| Duplicate inbound bubbles for one tap | FSM appends **before** `dedupe.begin`. Meta redelivery after `commit` skips the engine but can append again. |
| Application link sent twice | `joinTextAndLink` skips the URL if copy already contains it |
| Desk tagged App-Link sent; no form URL on WhatsApp | FSM `FINAL_CONSENT` is exact-label. Live desk `isYesSendAnswer` uses `includes('send it')`, so `don't send it` stamps the label without `SEND_LINK`. [AGENT_DESK.md](./AGENT_DESK.md) |
| Duplicate CRM lead after restart | `pendingLead` + `lastLoggedLeadKey` skip a second `logLead` **when the marker write succeeded**. If **both** marker writes fail (`_persistLoggedLeadAndClearPending` and `_bestEffortPersistLeadLogMarker`), disk keeps `pendingLead` with `lastLoggedLeadKey: null`. In-process `_loggedLeadKeys` is gone after deploy. Live `FileLeadLogger.logLead` always `appendFileSync`s — same fingerprint, second jsonl row. `.env.example` launch default is `LEAD_LOGGER=file`. Open PR #104 indexes existing jsonl fingerprints (`wa\|exitReason\|path\|timestamp`, same as `FsmEngine._leadKey`) and skips. Console logger is unchanged. TTL must still not purge queued leads. |
| CRM/Slack never saw a handover | `AGENT_NOTIFY_WEBHOOK_URL` empty (console only), receiver non-2xx (no retry), or the exit was `END_CHAT_*` / `SEND_LINK` / desk takeover (those do not notify). Check Render logs for `[agent-notify]`. |
| One number stuck after a handover ping | Notify `fetch` has no timeout and holds that WA’s session lock. Other chats are fine. Point the URL at a fast receiver or leave it unset. |
| Interactive tap does nothing | Stale button ids from an older prompt are rejected; webhook must subscribe to **messages** |
| See our cars missing | Greeting `interactiveOptions` is Qualify Me + I saw a special only. Stocklist state still exists for leftover buttons / later re-enable |

Menu tree: `src/fsm/states.js`. Copy: `src/content/copy.js`. Engine: `src/engine/fsmEngine.js`. Tests: `npm test` (`tests/run.js`). Bulk-select / hold-revive / exact-reopen suites ship with those PRs (`tests/agent-bulk-actions.test.js`, `tests/soft-delete-hold-revive.test.js`, `tests/reopen-keyword-exact.test.js`). File-logger restart upsert: `tests/pending-lead-restart-idempotency.test.js` on PR #104. Desk switch races: `tests/desk-unread.test.js` / `tests/agent-desk.test.js` on PRs #100 / #102 / #103 / #106 / #107 (`testDeskUiDisarmsComposerAfterEmergencySend`, `testDeskUiPinsAssignLabelsDestinationWa`).

## Catalog

Boot calls `prepareCatalogForMessaging()` (link catalog to WABA, commerce visibility). **See our cars** (when shown) sends a live Meta `product_list`.

`src/config.js` and `.env.example` ship Melrose defaults (`WHATSAPP_WABA_ID=1777270766733626`, `WHATSAPP_CATALOG_ID=1067415159340072`). Override both before pointing this process at another WABA — `prepareCatalogForMessaging` / `check:catalog` will otherwise link or list the Melrose catalog.

A product inquiry / cart `order` stores `selectedProductRetailerId` and advances to `EMPLOYED_INCOME_CHECK` **only while the session is on `STOCKLIST_CAROUSEL`** (`catalogProductList: true`). The same inbound on any other active step, or after `soft_closed`, is treated as unmatched text (off-menu, then silent hold). Greeting still hides See our cars; leftover stocklist buttons and catalog messages can still arrive.

`STOCK_LINK` is fallback only when the catalog is empty or Graph product_list fails. Confirm with `npm run check:catalog` and `/health` → `catalog`.

## Leads

`LEAD_LOGGER=file` → `data/logs/leads.jsonl` (also ephemeral on Render free). `.env.example` sets `file` for launch; `src/config.js` falls back to `console` if the env var is unset. Console/json alternatives exist. Qualification still depends on session `pendingLead` until flush succeeds.

Fingerprint (`FsmEngine._leadKey`): `waNumber|exitReason|pathJoinedBy>|timestamp`. Terminal persist writes `pendingLead` **before** `logLead`, then:

1. `_logLeadOnce` — skip if in-memory `_loggedLeadKeys` or `session.lastLoggedLeadKey` already has the key; otherwise call `leadLogger.logLead`.
2. `_persistLoggedLeadAndClearPending` — write `lastLoggedLeadKey` while `pendingLead` is still set, then clear it.
3. On failure, `_bestEffortPersistLeadLogMarker` tries once more to leave the marker on disk.

| Disk after a crash | Next process / `flushPendingLead` |
|---|---|
| `pendingLead` set, `lastLoggedLeadKey` = fingerprint | Skip `logLead`, clear the queue. Covered on live. |
| `pendingLead` set, `lastLoggedLeadKey` null, same process | In-memory `_loggedLeadKeys` still skips. |
| `pendingLead` set, `lastLoggedLeadKey` null, **new process** | Live `FileLeadLogger` appends a second jsonl row for the same qualification. Staff/CRM see a duplicate lead. PR #104 upserts by fingerprint (lazy-index existing lines). |

`ConsoleLeadLogger` has no disk index — duplicates only show up as extra `[lead]` lines, which is why the gap matters on the file backend used for launch.

## Local commands

```bash
cp .env.example .env
npm install
npm test
npm start
npm run check:meta
npm run check:catalog
npm run send:test -- --to 2782XXXXXXXX --template hello_world
npm run send:test -- --to 2782XXXXXXXX --text "Hello"
```

`--text` only works inside the 24h customer-care window. `--template` works before they message you (needs an approved template). Node 18+ (Docker uses 20-slim). Dockerfile copies `src/`, `data/`, `public/` — not `docs/`.
