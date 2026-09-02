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

Set `APPLICATION_LINK` to the Melrose Google Form URL before go-live.

This repo is **not** whatsapp-web.js. Outbound is official Graph `/messages` only.
