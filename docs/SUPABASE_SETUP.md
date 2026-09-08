# Persist chat history on Supabase (free cloud Postgres)

The agent desk can store WhatsApp transcripts in **Supabase** so history survives Render redeploys. You do **not** install Postgres on your laptop.

## 1. In Supabase (you already created a project)

1. Open your project → **Project Settings** (gear) → **Database**.
2. Under **Connection string**, choose **URI**.
3. Copy the URI. It looks like:

   ```text
   postgresql://postgres.[ref]:YOUR_PASSWORD@aws-0-….pooler.supabase.com:6543/postgres
   ```

4. Replace `[YOUR-PASSWORD]` with the database password you set when creating the project.
   - Prefer the **Session pooler** URI (port **5432**) for a long-running Render web service.
   - **Transaction** pooler (port **6543**) also works for this bot.

If you forgot the password: Database settings → **Reset database password**, then update the URI.

You do **not** need to create tables by hand — the bot creates `chat_messages` on first use.

## 2. On Render (or your host)

Add these environment variables to the bot service:

| Variable | Value |
|----------|--------|
| `DATABASE_URL` | The Supabase URI from step 1 |
| `MESSAGE_STORE` | `postgres` (optional if `DATABASE_URL` is set — auto-selected) |

Keep your existing WhatsApp and agent-desk vars. Redeploy after saving.

## 3. Confirm it works

1. Open `https://your-host/health` — `agentDesk.messageStore` should be `"postgres"`.
2. Send a WhatsApp message to the business number (or reply from `/agent`).
3. Open `/agent` — the chat should appear and **stay after the next Render deploy**.

Optional: in Supabase → **Table Editor**, you should see `chat_messages` filling up.

## Local development

```bash
# .env
DATABASE_URL=postgresql://postgres....supabase.com:5432/postgres
MESSAGE_STORE=postgres
```

Leave `MESSAGE_STORE` unset and omit `DATABASE_URL` to keep using local `data/transcripts/` files.
