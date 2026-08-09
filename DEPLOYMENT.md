# Deployment

**Status: not deployed yet.** This file is a placeholder until `web/`'s
roadmap reaches step 4 (Vercel + Neon deploy) — see
[`web/README.md`](./web/README.md#roadmap). Filling it in earlier would mean
writing setup instructions for a password gate and computed views that
don't exist yet, which isn't useful yet.

## What's already decided (from earlier conversation)

- **Frontend/backend**: Next.js on Vercel (`web/`)
- **Database**: Postgres — Neon in production (Vercel Postgres is Neon
  under the hood), a local Postgres for dev/test
- **Access**: public HTTPS + a single shared password (no per-user
  accounts — this is a single-user tool)
- **Cost**: intended to stay on free tiers (Vercel's hobby plan + Neon's
  free tier both comfortably cover a small single-user app like this)

## What this doc will cover once it's written for real

1. Creating the Neon (or Vercel Postgres) database and getting a
   `DATABASE_URL`
2. Connecting the GitHub repo to a Vercel project, setting `DATABASE_URL` +
   `DASHBOARD_PASSWORD` + any connector API keys as Vercel environment
   variables (never committed, never pasted into chat)
3. Verifying the deploy: import a CSV through the live URL, confirm the
   password gate actually blocks unauthenticated access
