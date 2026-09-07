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
  → See our cars → stocklist → (any selection) → employment_check
  → Qualify Me → employment_check
  → Promotions → (TBD) → main menu
  → Opt-Out → human_handover

employment_check → Yes → affordability_check | No → end_chat
affordability_check → >R15k / >R9k → license_check | <R5k → end_chat
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
4. Tap the green **+** to start a chat with a new number (optional first message, or an approved template for cold outreach outside the 24h window)

Transcripts are stored under `data/transcripts/`.
