# VWwhatsappAPI — VW Melrose WhatsApp bot

Single-tenant **WhatsApp Cloud API** bot for VW Melrose (**Coexistence**: Business App + API on the same number).

Script and branching menu match **VW Melrose WhatsApp Bot Flow** (interactive reply buttons / lists).

Start here:

1. **Plug into Meta:** [docs/META_SETUP.md](docs/META_SETUP.md)
2. **Customer copy:** `src/content/copy.js` (Melrose script verbatim)
3. **Menu tree + button ids:** `src/fsm/states.js`
4. **Staff inbox:** [docs/AGENT_DESK.md](docs/AGENT_DESK.md)
5. **Webhook / sessions / follow-ups:** [docs/OPERATIONS.md](docs/OPERATIONS.md)

## Flow (Melrose)

```
greeting
  → Qualify Me → employed_income_check
  → I saw a special → Payment Holiday / Lower Interest Rate / Discount
       → (brief description) → employed_income_check
  → (type Opt-Out) → human_handover

employed_income_check → Yes → license_check | No → end_chat (not ready)
license_check → Yes → credit_check | No → human_handover
credit_check → Good → final_consent | Bad → human_handover
final_consent → Yes, send it → send_link | Not right now → human_handover
```

Greeting uses **2 reply buttons** for now (See our cars temporarily hidden). Opt-Out stays text-matchable.

## Run

```bash
cp .env.example .env
# fill Meta values + APPLICATION_LINK / WHATSAPP_CATALOG_ID — see docs/META_SETUP.md
npm install
npm test
npm start
```

```bash
npm run check:meta
npm run check:catalog
npm run send:test -- --to 2782XXXXXXXX --template hello_world
```

`STOCK_LINK` is only a fallback if the catalog is empty or product_list send fails.

## Agent desk

Staff browser inbox (Cloud API chats, no Coexistence required). Full runbook: [docs/AGENT_DESK.md](docs/AGENT_DESK.md).

1. Set on Render: `AGENT_DESK_PASSWORD=…` (and `AGENT_DESK_ENABLED=true`)
2. Open `https://your-host/agent`
3. Sign in → pick a chat → **Take over** / reply / **Release to bot**

Desk replies and **Take over** are **silent**: the bot sends no handover copy and stays quiet until **Release to bot** (customer `hi` does not resume the menu).

### Shortcuts (type `/`)

Create canned replies under **⋮ → Manage shortcuts**. In the composer, type `/` then a shortcut name (e.g. `/greeting`). Newlines are kept. Stored in `data/agent/shortcuts.json` — **wiped on Render redeploy** unless you attach a disk.

### Labels

Cemented funnel tags (Pre-approved, Validated, App-Link sent, No License, Bad Credit, Unqualified) plus any staff extras. **⋮ → Manage labels**, then **Labels** on a thread. Chips above the inbox filter the list.

When `DATABASE_URL` is set, the catalog and per-chat tags live in Postgres (survive deploys). Funnel labels are inferred on thread open and by a **background** backfill — never by scanning every transcript on `GET /api/chats`.

### Where chats are stored

| Data | Path / backend | Survive Render free redeploy? |
|---|---|---|
| Message transcripts + inbound media | `data/transcripts/` **or Postgres** `chat_messages` when `DATABASE_URL` is set | Yes, if Postgres |
| Labels | `data/agent/labels.json` **or Postgres** `agent_labels` / `agent_chat_labels` | Yes, if Postgres |
| Shortcuts | `data/agent/shortcuts.json` | No |
| Unread cursors | `data/agent/chat_reads.json` | No |
| Bot sessions | `data/sessions/` | No (24h TTL besides queued leads) |
| Lead log | `data/logs/leads.jsonl` | No |

**Keep chat history + labels:** [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md) — set `DATABASE_URL` on Render.

Number search accepts `064…` / `64…` / `27…`. If the inbox hangs, the UI falls back to an **emergency list** (still shows labels; skips unread/session enrichment).

### If the menu never arrives / Send says 401

`GET /health` → `webhook.lastSendError` with **code 190** means `WHATSAPP_TOKEN` is expired or wrong. Paste a fresh token (prefer a permanent **system user** token) into Render env and redeploy. Also keep `WHATSAPP_APP_SECRET` matched to the same Meta app (signature rejects drop inbound messages).
