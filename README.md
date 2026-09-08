# VWwhatsappAPI — VW Melrose WhatsApp bot

Single-tenant **WhatsApp Cloud API** bot for VW Melrose (**Coexistence**: Business App + API on the same number).

Script and branching menu match **VW Melrose WhatsApp Bot Flow** (interactive reply buttons / lists).

Start here:

1. **Plug into Meta:** [docs/META_SETUP.md](docs/META_SETUP.md)
2. **Customer copy:** `src/content/copy.js` (Melrose script verbatim)
3. **Menu tree + button ids:** `src/fsm/states.js`

## Flow (Melrose)

```
greeting
  → See our cars → stocklist → (any selection) → qualify_consent
  → Qualify Me → qualify_consent
  → I saw a special → Payment Holiday / Lower Interest Rate / Discount
       → (brief description) → qualify_consent
  → (type Opt-Out) → human_handover

qualify_consent → Yes → employed_income_check | No → Human-Handover / Main-Menu
employed_income_check → Yes → license_check | No → end_chat (not ready)
license_check → Yes → credit_check | No → human_handover
credit_check → Good → final_consent | Bad → human_handover
final_consent → Yes, send it → send_link | Not right now → human_handover
```

Greeting has **4 options** → WhatsApp **list** message. Other steps use reply buttons (≤3).

## Run

```bash
cp .env.example .env
# fill Meta values + APPLICATION_LINK / STOCK_LINK — see docs/META_SETUP.md
npm install
npm test
npm start
```

```bash
npm run check:meta
npm run send:test -- --to 2782XXXXXXXX --template hello_world
```

## Agent desk

Staff browser inbox (Cloud API chats, no Coexistence required):

1. Set on Render: `AGENT_DESK_PASSWORD=…` (and `AGENT_DESK_ENABLED=true`)
2. Open `https://your-host/agent`
3. Sign in → pick a chat → **Take over** / reply / **Release to bot**

### Shortcuts (type `/`)

Create canned replies under **⋮ → Manage shortcuts**. In the composer, type `/` then a shortcut name (e.g. `/greeting`) and pick from the list — same idea as WhatsApp Business quick replies.

### Labels

Create labels under **⋮ → Manage labels**. Open a chat → **Labels** to tag it (VIP, Follow-up, etc.). Filter the chat list with the chips above the inbox.

### Where chats are stored

| Data | Path / backend | Purpose |
|---|---|---|
| Message transcripts | `data/transcripts/` **or Supabase Postgres** when `DATABASE_URL` is set | Agent desk chat history |
| Bot sessions | `data/sessions/` | FSM state (greeting step, quiet, takeover, etc.) |
| Shortcuts & labels | `data/agent/` | Agent desk canned replies and chat labels |
| Lead log | `data/logs/leads.jsonl` | Qualified / exited leads |

**Keep chat history forever (free):** create a [Supabase](https://supabase.com) project and follow [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md) — set `DATABASE_URL` on Render.

Local file transcripts are wiped on ephemeral hosts (Render free) unless you use Supabase or attach a persistent disk.

### If the menu never arrives / Send says 401

`GET /health` → `webhook.lastSendError` with **code 190** means `WHATSAPP_TOKEN` is expired or wrong. Paste a fresh token (prefer a permanent **system user** token) into Render env and redeploy. Also keep `WHATSAPP_APP_SECRET` matched to the same Meta app (signature rejects drop inbound messages).
