# Agent desk (staff inbox)

Browser inbox at `/agent` for Cloud API chats. Independent of WhatsApp Business Coexistence: staff do not need the phone app to reply.

This page covers architecture, staff usage, APIs, storage, and the inbox pitfalls that recently changed.

## Intent

- Show every stored WhatsApp number so staff can search, label, and reply.
- Keep the **bot quiet** while a human is in the thread (`Take over` or any desk reply).
- Survive Render disk wipes for **transcripts, labels, shortcuts, and unread badges** when `DATABASE_URL` is set.
- Keep `GET /api/chats` cheap. Scanning every transcript on the inbox request used to time out and made the list look empty.

## Enable

| Env | Purpose |
|---|---|
| `AGENT_DESK_ENABLED` | Default `true`. Set `false` to disable the UI/API. |
| `AGENT_DESK_PASSWORD` | Required. Login cookie + `Authorization: Bearer`. |
| `DATABASE_URL` | Supabase/Postgres — transcripts, labels, shortcuts, unread. See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md). |
| `AGENT_DESK_EMERGENCY` | Host-wide skip of **session** enrichment on the inbox list (labels + read cursors still load). |
| `AGENT_DESK_INBOX_LIST_MS` | Inbox `listChats` timeout (default `8000`). |
| `AGENT_DESK_INBOX_ENRICH_MS` | Label / session map timeout (default `1500`). Read cursors wait `max(enrich×2, 6000)` so badges survive refresh. |
| `AGENT_DESK_LABEL_BACKFILL` | Background funnel tags. Default on; off when emergency is on. |
| `AGENT_DESK_SEND_READ_RECEIPTS` | Opt-in. When `true`, opening a chat sends the customer a WhatsApp read receipt (blue ticks). Default off. |

Open `https://your-host/agent`, sign in, pick a chat.

Docker images **must** include `public/` (`COPY public ./public` in the Dockerfile). If `/agent` says the UI file is missing, the image was built without that copy — redeploy.

## Architecture

```
Browser  /agent
   │  cookie / Bearer password
   ▼
src/agent/routes.js
   ├── messageStore   transcripts (file JSONL or Postgres chat_messages)
   ├── labelStore     catalog + per-chat tags (file or Postgres)
   ├── shortcutStore  canned replies (file or Postgres agent_shortcuts)
   ├── chatReadStore  last-opened / mark-unread (file or Postgres agent_chat_reads)
   ├── sessionStore   FSM status, agentTakenOver (file sessions/)
   └── FsmEngine.takeOver / releaseToBot
```

`GET /health` → `agentDesk` reports `enabled`, `messageStore` (`postgres` vs `file`), `settingsStore` (labels), `shortcutStore`, `inboxList` (`reads-survive-refresh-2026-09-17`), `imageDownload`, and `emergency`.

`resolveDeskSettingsBackend` in `src/agent/pg.js`: labels, shortcuts, and unread **prefer Postgres whenever `DATABASE_URL` is set**, even if `MESSAGE_STORE=file`.

## Staff workflow

1. **Inbox** — newest last message first. Pills: `bot` / `agent` / `quiet` / `soft_closed`. Missing sessions are **bot**, never the string `unknown`. Times: today `HH:MM`, yesterday `Yesterday HH:MM`, older `11 Sep, HH:MM` (year if not this year).
2. **Search** — type 4+ digits. `064…`, `64…`, `2764…`, and `+27…` match the same SA mobile. A number lookup is global: Unread / Agent / label chips do not hide the hit.
3. **Open a chat** — the UI `POST`s `/api/chats/:wa/read` with `{ force: true, at }`. `GET` of the transcript does **not** mark read (the 5s poll must not undo Mark unread). Funnel labels may be inferred from this thread once.
4. **Take over** — silent. No WhatsApp notice. Bot menus and no-reply follow-ups stop until **Release to bot**.
5. **Reply** (text, paste image, or attach images) — also silent-takeover, then Graph send. Caption optional on images. WhatsApp delivers the image; the desk transcript stores caption/`[Image]` only (no outbound bytes after refresh).
6. **Release to bot** — resumes the in-progress choice step when possible; otherwise greeting. Customer `hi` / `hello` does **not** restart a taken-over thread.
7. **Mark unread** — keeps the last-opened cursor and sets `forcedUnread` so the badge is at least `1` (not the whole history). Badge stays until staff click the thread again (`force` on `/read`).
8. **Green +** — start / message a number even if it is not in the inbox yet (24h customer-service window still applies).

### Shortcuts (`/`)

**⋮ → Manage shortcuts**. In the composer type `/greeting` (no leading slash in the stored key). Newlines are preserved. On boot, old single-line shortcuts that used section emojis are auto-repaired.

When `DATABASE_URL` is set, shortcuts live in Postgres `agent_shortcuts`. First boot seeds defaults **once** (`agent_desk_meta.shortcuts_seeded`), or imports `data/agent/shortcuts.json` if that file exists — staff deletes are not reseeded on deploy. Without `DATABASE_URL`, they stay in `data/agent/shortcuts.json` and a Render free redeploy **wipes** them.

### Labels

Cemented catalog (seeded once). After `labels_seeded`, staff **renames, extra colours, and mixed catalogs** are left alone. Do **not** delete every cemented name and replace the whole catalog with only `VIP` / `Follow Up` / `Hot Lead` / `Complaint` — `isLegacyBuiltinCatalog` still runs on file read and Postgres `seedIfNeeded`, and that shape is treated as the pre-seed VIP catalog: labels and **all chat assignments are wiped**, then the funnel names are re-inserted.

| Name | Typical funnel meaning |
|---|---|
| Pre-approved | Staff tag |
| Validated | Staff tag |
| App-Link sent | Customer got the application URL |
| No License | License = No |
| Bad Credit | Credit = Bad |
| Unqualified | Not employed / income under threshold |

Staff can add colours (including yellow `#ca8a04`). Filter chips sit above the inbox.

**Auto-tag** is additive, but **not suppressible** on live: `GET /api/chats/:wa` → `syncChat` → `addChatLabelByName` re-applies Unqualified / No License / Bad Credit / App-Link sent from the session path and bot copy even after staff `PUT` cleared them. That GET runs on thread open **and** on the 5s selected-thread poll. Background `labelBackfill` does the same. Staff extras stay; staff-removed funnel tags come back.

Empty inbox scans are remembered in-process so a chat with no funnel copy is not re-scanned every poll.

**Postgres replace is not transactional.** `setChatLabels` (`PUT /api/chats/:wa/labels`) `DELETE`s every `agent_chat_labels` row for that number, then `INSERT`s one-by-one with no `BEGIN`/`COMMIT`. An INSERT failure or crash mid-loop leaves the chat with **zero** labels — the previous assignments are gone. The file backend writes the full JSON under one lock, so it does not have this gap.

## Inbox performance and emergency mode

`GET /api/chats` lists latest-message rows only. It must **not** call `listMessages` per chat.

If labels/sessions hang past `AGENT_DESK_INBOX_ENRICH_MS`, the list still returns. Read cursors wait longer (`max(enrich×2, 6000ms)`) and, on timeout, reuse the last in-process map — an empty map is what re-badged every chat after refresh. If `listChats` hangs past `AGENT_DESK_INBOX_LIST_MS`, the UI retries with `?emergency=1`.

**Emergency list** (`?emergency=1` or `AGENT_DESK_EMERGENCY=true`):

- Skips **session** enrichment (pills may all look like `bot`).
- **Still attaches labels** so filter chips work.
- **Still loads read cursors** so Unread badges stay cleared across refresh.
- Stops label backfill so the inbox keeps the DB pool.

Toggle **Emergency inbox** in the desk menu to pin this mode in `localStorage`.

## Unread (desk-only)

Unread is **not** WhatsApp’s tick. It is a last-opened cursor plus an optional forced-unread flag. The inbox **list** poll does not mark chats read. The **open** thread POSTs `/read` without `force` every 5s so new inbound stays cleared — unless `forcedUnread`.

| Action | Effect |
|---|---|
| Staff click a thread | `POST /api/chats/:wa/read` `{ force: true, at }` — cursor = `max(at, latest stored message)`, clears `forcedUnread` |
| Background poll `/read` without `force` | Intended to leave a Mark-unread chat alone (`skipped: forced_unread`). The skip is **not atomic**: the route checks `isForcedUnread`, then later calls `markRead`, which always writes `forced_unread = FALSE`. A Mark unread that lands between those steps is wiped and the cursor can jump. |
| Mark unread | Cursor **kept**; `forcedUnread=true` so the badge is at least `1` (not a rewind of history) |
| Customer last message after cursor | Badge ≥ 1 |
| Never opened (no cursor) | Floor of 1 if last row is not staff (`applyUnreadFloor`). Once a cursor exists, trust the count — do not re-compare `lastAt > lastReadAt` (that re-badged chats after refresh on timestamp skew) |

When `DATABASE_URL` is set, rows live in `agent_chat_reads` and survive redeploys. File backend: `data/agent/chat_reads.json`.

Customer-visible blue ticks are **off** unless `AGENT_DESK_SEND_READ_RECEIPTS=true`. Then open sends Graph `read` for the latest inbound `wamid`. A receipt failure never fails the desk open.

## Media

| Direction | Limits | Notes |
|---|---|---|
| Staff → customer image | JPEG/PNG/WebP, ≤16MB | Graph inline cap is 5MB; larger files upload as media then send by id. Multiple paste/attach allowed. JSON body limit 24MB. Transcript is caption/`[Image]` only — bytes are not stored. |
| Customer → desk image | JPEG/PNG/WebP, ≤16MB | Bytes stored when Graph download works; **FSM skipped**. Download failure → `(media unavailable)` after the webhook 200. |
| Customer → desk document | PDF/Office/text, ≤20MB | Same: desk only, no FSM. |

Failed Graph download still leaves a `[Image]` / `[Document: …] (media unavailable)` placeholder when the store is up. Download runs **after** the webhook 200, the Graph media id is **not** kept on the failure row, and Meta will not redeliver — license scans / quotes / car pics in that placeholder are gone unless the customer resends.

**Staff → customer images** (`POST /reply-media`, paste/attach): Graph send can succeed while `loggingSend` in `src/app.js` appends **caption or `[Image]` only** (no `mediaBuffer`). After refresh, `hasMedia` is false and `GET .../media` has nothing. Customer **inbound** bytes are stored; agent-sent bytes are not.

Inbound types the menu does not handle (`audio`, `video`, `sticker`, `location`, `contacts`, `reaction`, `button`, `system`, …) still get a **desk placeholder** (`[Audio]`, `[Video]`, …) with `skipFsm`. They do **not** enter the menu tree.

Serve bytes: `GET /agent/api/chats/:wa/messages/:id/media` (auth required) — this is the **inbound** store. Images default `Content-Disposition: inline`; `?download=1` (or `?disposition=attachment`) forces a save-as. Non-images always attach. Postgres stores inbound bytes in `chat_messages.media_bytes` so they survive disk wipes. File backend writes `data/media/`.

## HTTP API (all under `/agent`)

Auth: cookie `agent_desk` (set on `POST /api/login`) or `Authorization: Bearer <password>`. Timing-safe compare. Production cookie is `Secure`.

| Method | Path | Notes |
|---|---|---|
| GET | `/` | UI |
| GET | `/api/status` | No auth. Chat count, last Graph error, emergency flag, `transcriptAppendFailures`, `unreadCountMode`. |
| POST | `/api/login` | `{ password }` |
| POST | `/api/logout` | Clears the `agent_desk` cookie |
| GET | `/api/stored/:wa` | Whether that number already has transcript rows (green + new-chat UI) |
| GET | `/api/chats` | `?q=` / `?search=` (≥4 digits filters). `?emergency=1` |
| GET | `/api/chats/:wa` | Transcript + session; does **not** mark read; may infer labels |
| POST | `/api/chats/:wa/read` | `{ force, at }` — staff open. Without `force`, skips forced-unread chats |
| POST | `/api/chats/:wa/unread` | Manual unread (`forcedUnread`, cursor kept) |
| POST | `/api/chats/:wa/reply` | Text; silent takeover. Graph success still returns `ok: true` if the desk append failed |
| POST | `/api/chats/:wa/reply-media` | `{ imageBase64, mimeType, caption }` — Graph send; transcript is text-only; same `ok: true` after append failure |
| POST | `/api/chats/:wa/takeover` | Silent |
| POST | `/api/chats/:wa/release` | Resume FSM |
| GET | `/api/chats/:wa/messages/:id/media` | Bytes. `?download=1` → attachment |
| PUT | `/api/chats/:wa/labels` | `{ labelIds }` — Postgres DELETE then INSERT, no transaction |
| CRUD | `/api/shortcuts`, `/api/labels` | |

`:wa` is digits-only (non-digits stripped).

## Storage map

| Data | Backend when `DATABASE_URL` set | Wiped on Render free redeploy? |
|---|---|---|
| Transcripts + **inbound** media bytes | Postgres `chat_messages` (`media_bytes`) | No (staff outbound images are text-only — see Media) |
| Label catalog + chat tags | Postgres `agent_labels`, `agent_chat_labels` | No |
| Shortcuts | Postgres `agent_shortcuts` (seed once) | No |
| Unread / read cursors | Postgres `agent_chat_reads` | No |
| Bot sessions (`agentTakenOver`, step) | File `data/sessions/` | **Yes** (TTL 24h anyway; `agentTakenOver` is **not** TTL-exempt) |

Do not set `MESSAGE_STORE=file` on a host that has `DATABASE_URL` unless you intend local transcripts. Labels, shortcuts, and unread still prefer Postgres whenever `DATABASE_URL` is set (`resolveDeskSettingsBackend`).

## Troubleshooting

| Symptom | Check |
|---|---|
| `/agent` 503 / login fails | `AGENT_DESK_PASSWORD` set; `AGENT_DESK_ENABLED` not `false` |
| Blank UI / “UI missing from server image” | Dockerfile `COPY public ./public`; redeploy |
| Empty inbox, `/health` `chatCount` > 0 | Inbox timed out — emergency list should auto-enable; or labels/sessions hung |
| Empty inbox, `messageStore: "file"` | Ephemeral disk; set `DATABASE_URL` |
| Search says not stored | Need ≥4 digits; try last 9 digits or `27…` form. Hits bypass Unread/Agent filters |
| Labels vanish after deploy | `DATABASE_URL` missing so labels used `data/agent/labels.json` |
| Labels snapped back to Pre-approved / App-Link sent | Catalog was **only** VIP / Follow Up / Hot Lead / Complaint after seed — that still triggers the legacy wipe. Keep at least one non-legacy name, or do not rebuild the whole catalog from those four. |
| Staff removed Unqualified / App-Link sent, it came back | Expected on live: thread open and label backfill re-apply funnel names. There is no per-chat suppress list. |
| Chat lost every label after one failed save | Postgres `setChatLabels` deleted first. Check `agent_chat_labels` for that `wa_number`; re-tag the thread. |
| Mark unread cleared itself a few seconds later | Inbox poll `POST /read` without `force` can win the race against `/unread` (check-then-write). Click the thread, then Mark unread again. |
| Desk showed a sent bubble that vanished after refresh | Graph delivered; `loggingSend` swallowed the transcript append. `/reply` still returned `ok: true`. Check `webhook.transcriptAppendFailures` / `/agent/api/status`. |
| Shortcuts reset after deploy | Same — need `agentDesk.shortcutStore: "postgres"` |
| Unread badges come back after refresh | Need Postgres `agent_chat_reads`; emergency list must still load reads (`inboxList` = `reads-survive-refresh-2026-09-17`). Do not skip cursors in emergency |
| Reply 401 / Graph `#190` | `GET /health` → `webhook.lastSendError`; refresh `WHATSAPP_TOKEN` |
| Bot keeps talking after staff reply | Session file lost (redeploy / 24h TTL) so `agentTakenOver` was cleared — Take over again |
| Customer image never appears | Type not in the image/document allow-list (then you should still see `[Audio]` / `[Video]` / …), or Graph download failed after the webhook 200 (`(media unavailable)` — ask them to resend) |
| Staff-sent image missing after refresh | Expected on live: `loggingSend` stores `[Image]`/caption only. WhatsApp still delivered it; the desk of record did not keep bytes. |
| Customer blue ticks on open | Only if `AGENT_DESK_SEND_READ_RECEIPTS=true` |
| Inbox looks slow / empty on Render | Confirm `inboxList` health marker `reads-survive-refresh-2026-09-17`; do not add per-chat transcript scans back onto `GET /api/chats` |
