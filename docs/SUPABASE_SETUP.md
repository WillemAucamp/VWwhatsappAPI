# Persist chat history on Supabase (free cloud Postgres)

The agent desk can store WhatsApp transcripts in **Supabase** so history survives Render redeploys. You do **not** install Postgres on your laptop.

## What to do next (project already created)

### 1. Copy the database URI from Supabase

1. Open [supabase.com/dashboard](https://supabase.com/dashboard) → your project.
2. Click the **gear** (Project Settings) → **Database**.
3. Find **Connection string** → choose **URI**.
4. Select **Session pooler** if shown (host ends in `pooler.supabase.com`, port **5432**).  
   Avoid **Transaction** pooler (port **6543**) unless Session is unavailable.
5. Copy the URI. It looks like:

   ```text
   postgresql://postgres.[ref]:[YOUR-PASSWORD]@aws-0-….pooler.supabase.com:5432/postgres
   ```

6. Replace `[YOUR-PASSWORD]` with the database password from project creation.
   - If the password has `!`, `@`, `#`, `/`, etc., URL-encode it (e.g. `!` → `%21`, `@` → `%40`).
   - Example: password `Secret!23` → `…:Secret%2123@aws-…pooler.supabase.com:5432/postgres`
   - The bot also auto-encodes on connect, but Render is more reliable if you paste the encoded URI.
   - Forgot it? Same page → **Reset database password**, then update the URI.

You do **not** create tables by hand — on first message the bot creates `chat_messages`.

### 2. Paste it into Render

In the Render dashboard → your bot **Web Service** → **Environment**:

| Variable | Value |
|----------|--------|
| `DATABASE_URL` | The full URI from step 1 |
| `MESSAGE_STORE` | `postgres` (optional — auto-selected when `DATABASE_URL` is set) |

Save → **Manual Deploy** (or wait for auto-deploy of this branch).

### 3. Confirm

1. Open `https://your-host/health` → `agentDesk.messageStore` should be `"postgres"`.
2. Send a WhatsApp message (or reply from `/agent`).
3. Open `/agent` — the chat should remain **after the next Render deploy**.
4. Optional: Supabase → **Table Editor** → `chat_messages`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `/health` still says `"file"` | `DATABASE_URL` missing/empty on Render; redeploy after setting it |
| App crash / DB connection errors | Wrong password, or password not URL-encoded; try Session pooler URI |
| Empty agent desk after deploy | Confirm you deployed the branch that includes Postgres transcript support |

## Local development

```bash
# .env
DATABASE_URL=postgresql://postgres....pooler.supabase.com:5432/postgres
MESSAGE_STORE=postgres
```

Omit both to keep using local `data/transcripts/` files.
