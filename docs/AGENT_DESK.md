# Agent desk (staff inbox)

Browser inbox at `/agent` for Cloud API chats. Independent of WhatsApp Business Coexistence: staff do not need the phone app to reply.

This page covers architecture, staff usage, APIs, storage, and the inbox pitfalls that recently changed.

## Intent

- Show every stored WhatsApp number so staff can search, label, and reply.
- Keep the **bot quiet** while a human is in the thread (`Take over` or any desk reply).
- Survive Render disk wipes for **transcripts and labels** when `DATABASE_URL` is set.
- Keep `GET /api/chats` cheap. Scanning every transcript on the inbox request used to time out and made the list look empty.

## Enable

| Env | Purpose |
|---|---|
| `AGENT_DESK_ENABLED` | Default `true`. Set `false` to disable the UI/API. |
| `AGENT_DESK_PASSWORD` | Required. Login cookie + `Authorization: Bearer`. |
| `DATABASE_URL` | Supabase/Postgres — transcripts **and** labels. See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md). |
| `AGENT_DESK_EMERGENCY` | Host-wide skip of unread/session enrichment on the inbox list. |
| `AGENT_DESK_INBOX_LIST_MS` | Inbox `listChats` timeout (default `8000`). |
| `AGENT_DESK_INBOX_ENRICH_MS` | Unread / label / session map timeout (default `1500`). |
| `AGENT_DESK_LABEL_BACKFILL` | Background funnel tags. Default on; off when emergency is on. |

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
   ├── shortcutStore  canned replies (file only today)
   ├── chatReadStore  last-opened / mark-unread (file only today)
   ├── sessionStore   FSM status, agentTakenOver (file sessions/)
   └── FsmEngine.takeOver / releaseToBot
```

`GET /health` → `agentDesk` reports `enabled`, `messageStore` (`postgres` vs `file`), `settingsStore` (labels backend), and `emergency`.

## Staff workflow

1. **Inbox** — newest last message first. Pills: `bot` / `agent` / `quiet` / `soft_closed`. Missing sessions are **bot**, never the string `unknown`.
2. **Search** — type 4+ digits. `064…`, `64…`, `2764…`, and `+27…` match the same SA mobile. A number lookup is global: Unread / Agent / label chips do not hide the hit.
3. **Open a chat** — marks it read (desk-only; the bot path is unchanged). Funnel labels may be inferred from this thread once.
4. **Take over** — silent. No WhatsApp notice. Bot menus and no-reply follow-ups stop until **Release to bot**.
5. **Reply** (text, paste image, or attach images) — also silent-takeover, then Graph send. Caption optional on images.
6. **Release to bot** — resumes the in-progress choice step when possible; otherwise greeting. Customer `hi` / `hello` does **not** restart a taken-over thread.
7. **Mark unread** — badge stays until the thread is opened again.
8. **Green +** — start / message a number even if it is not in the inbox yet (24h customer-service window still applies).

### Shortcuts (`/`)

**⋮ → Manage shortcuts**. In the composer type `/greeting` (no leading slash in the stored key). Newlines are preserved. On boot, old single-line shortcuts that used section emojis are auto-repaired.

Shortcuts live in `data/agent/shortcuts.json` today. A Render redeploy **wipes** them unless the host has a persistent disk.

### Labels

Cemented catalog (seeded once; staff renames/deletes/extras are left alone after first seed):

| Name | Typical funnel meaning |
|---|---|
| Pre-approved | Staff tag |
| Validated | Staff tag |
| App-Link sent | Customer got the application URL |
| No License | License = No |
| Bad Credit | Credit = Bad |
| Unqualified | Not employed / income under threshold |

Staff can add colours (including yellow `#ca8a04`). Filter chips sit above the inbox.

**Auto-tag** is additive (staff tags stay):

- On **thread open**, from session `path` / `lastExitReason` and bot copy in the transcript.
- In the **background** (`labelBackfill`) — never on `GET /api/chats`. Batch default 2 chats / 20s.

Empty inbox scans are remembered in-process so a chat with no funnel copy is not re-scanned every poll.

## Inbox performance and emergency mode

`GET /api/chats` lists latest-message rows only. It must **not** call `listMessages` per chat.

If labels/sessions/unread hang past `AGENT_DESK_INBOX_ENRICH_MS`, the list still returns. If `listChats` hangs past `AGENT_DESK_INBOX_LIST_MS`, the UI retries with `?emergency=1`.

**Emergency list** (`?emergency=1` or `AGENT_DESK_EMERGENCY=true`):

- Skips unread + session enrichment (pills may all look like `bot`).
- **Still attaches labels** so filter chips work.
- Stops label backfill so the inbox keeps the DB pool.

Toggle **Emergency inbox** in the desk menu to pin this mode in `localStorage`.

## Unread (desk-only)

Unread is **not** WhatsApp’s tick. It is a last-opened cursor plus an optional forced-unread flag.

| Action | Effect |
|---|---|
| Open thread | `markRead` — cursor = now, clears forced unread |
| Mark unread | Cursor set to epoch + `forcedUnread` so the badge is at least `1` |
| Customer last message after cursor | Badge ≥ 1 |
| Never opened | Count of inbound rows (Postgres) / same floor on file store |

Stored in `data/agent/chat_reads.json` (file). Redeploys reset badges.

## Media

| Direction | Limits | Notes |
|---|---|---|
| Staff → customer image | JPEG/PNG/WebP, ≤16MB | Graph inline cap is 5MB; larger files upload as media then send by id. Multiple paste/attach allowed. JSON body limit 24MB. |
| Customer → desk image | JPEG/PNG/WebP, ≤16MB | Stored on the transcript; **FSM skipped** (not treated as a menu answer). |
| Customer → desk document | PDF/Office/text, ≤20MB | Same: desk only, no FSM. |

Failed media download still leaves a `[Image]` / `[Document: …] (media unavailable)` placeholder when the store is up.

Inbound types **not** handled (`audio`, `video`, `sticker`, `location`, …) are ignored: no transcript row, no FSM.

Serve bytes: `GET /agent/api/chats/:wa/messages/:id/media` (auth required). Postgres stores bytes in `chat_messages.media_bytes` so they survive disk wipes. File backend writes `data/media/`.

## HTTP API (all under `/agent`)

Auth: cookie `agent_desk` (set on `POST /api/login`) or `Authorization: Bearer <password>`. Timing-safe compare. Production cookie is `Secure`.

| Method | Path | Notes |
|---|---|---|
| GET | `/` | UI |
| GET | `/api/status` | No auth. Chat count, last Graph error, emergency flag. |
| POST | `/api/login` | `{ password }` |
| GET | `/api/chats` | `?q=` / `?search=` (≥4 digits filters). `?emergency=1` |
| GET | `/api/chats/:wa` | Transcript + session; marks read; may infer labels |
| POST | `/api/chats/:wa/unread` | Manual unread |
| POST | `/api/chats/:wa/reply` | Text; silent takeover |
| POST | `/api/chats/:wa/reply-media` | `{ imageBase64, mimeType, caption }` |
| POST | `/api/chats/:wa/takeover` | Silent |
| POST | `/api/chats/:wa/release` | Resume FSM |
| GET/PUT | `/api/chats/:wa/labels` | `{ labelIds }` |
| CRUD | `/api/shortcuts`, `/api/labels` | |

`:wa` is digits-only (non-digits stripped).

## Storage map

| Data | Backend when `DATABASE_URL` set | Wiped on Render free redeploy? |
|---|---|---|
| Transcripts + inbound media | Postgres `chat_messages` | No |
| Label catalog + chat tags | Postgres `agent_labels`, `agent_chat_labels` | No |
| Shortcuts | File `data/agent/shortcuts.json` | **Yes** |
| Unread cursors | File `data/agent/chat_reads.json` | **Yes** |
| Bot sessions (`agentTakenOver`, step) | File `data/sessions/` | **Yes** (TTL 24h anyway) |

Do not set `MESSAGE_STORE=file` on a host that has `DATABASE_URL` unless you intend local transcripts. Labels still prefer Postgres whenever `DATABASE_URL` is set (`resolveDeskSettingsBackend`).

## Troubleshooting

| Symptom | Check |
|---|---|
| `/agent` 503 / login fails | `AGENT_DESK_PASSWORD` set; `AGENT_DESK_ENABLED` not `false` |
| Blank UI / “UI missing from server image” | Dockerfile `COPY public ./public`; redeploy |
| Empty inbox, `/health` `chatCount` > 0 | Inbox timed out — emergency list should auto-enable; or labels/sessions hung |
| Empty inbox, `messageStore: "file"` | Ephemeral disk; set `DATABASE_URL` |
| Search says not stored | Need ≥4 digits; try last 9 digits or `27…` form. Hits bypass Unread/Agent filters |
| Labels vanish after deploy | `DATABASE_URL` missing so labels used `data/agent/labels.json` |
| Shortcuts reset after deploy | Expected on file store |
| Reply 401 / Graph `#190` | `GET /health` → `webhook.lastSendError`; refresh `WHATSAPP_TOKEN` |
| Bot keeps talking after staff reply | Session file lost (redeploy) so `agentTakenOver` was cleared — Take over again |
| Customer image never appears | Type not in the allow-list, or Graph media download failed (placeholder row) |
| Inbox looks slow / empty on Render | Confirm `inboxList` health marker `labels-in-emergency-2026-09-14`; do not add per-chat transcript scans back onto `GET /api/chats` |
