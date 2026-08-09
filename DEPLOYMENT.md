# Deployment

Everything below happens on your accounts (Vercel, Neon) — I have no
credentials for either and can't click through their dashboards for you.
This doc is the exact sequence; I've flagged the two steps that are easy to
get wrong.

## 1. Create the database (Neon)

1. [neon.tech](https://neon.tech) → sign up / log in → **New Project**.
   Any region close to you; the free tier is plenty for this app.
2. On the project dashboard, copy the **pooled** connection string —
   the one whose hostname contains `-pooler` (Neon shows both a direct and
   a pooled string; pick pooled).

   > **Why pooled, specifically:** Vercel runs this app as serverless
   > functions — each request can spin up a fresh connection. A direct
   > Postgres connection has a low max-connections ceiling that serverless
   > concurrency can exhaust quickly; Neon's pooler (PgBouncer under the
   > hood) is built for exactly this. Using the direct string will *work*
   > in light testing and then mysteriously fail under any real concurrent
   > load — use the pooled one from the start.

3. Save that string somewhere — it's your `DATABASE_URL` for step 3. It
   already includes `sslmode=require`; don't strip that.

## 2. Create the Vercel project

1. [vercel.com](https://vercel.com) → **Add New → Project** → import
   `poullainjb-dot/jean-claude` from GitHub (grant Vercel's GitHub App
   access to the repo if it asks).
2. **Before deploying**, set **Root Directory** to `web`.

   > **This is the step most likely to trip you up.** The Next.js app
   > lives in `web/`, not the repo root — `portfolio-app-spec.md`,
   > `sample_data/`, and the old Python build are siblings of it. Without
   > this, Vercel looks for `package.json` at the repo root, doesn't find
   > a Next.js app, and either fails the build or deploys the wrong thing.
   > Vercel should auto-detect the Next.js framework once Root Directory
   > is set correctly — leave build/output settings on their defaults.

3. Don't hit Deploy yet — add the environment variables first (step 3),
   since a build without them will fail (the app throws on a missing
   `DASHBOARD_PASSWORD`, deliberately — see R3).

## 3. Set environment variables

In the Vercel project's **Settings → Environment Variables**, add for
**Production** (and Preview, if you want preview deploys to work too):

| Key | Value |
|---|---|
| `DATABASE_URL` | the pooled Neon connection string from step 1 |
| `DASHBOARD_PASSWORD` | a real password you choose now — pick it directly in Vercel's UI, don't paste it into any chat, including this one |

Leave every other key from `web/.env.example` unset for now — they're for
connectors that don't exist yet (later roadmap phases) and Vercel doesn't
need them until then.

## 4. Deploy

Click **Deploy**. First build takes a minute or two. Vercel gives you a
`*.vercel.app` URL when it's done.

**Which branch:** Vercel's default "Production" tracks whichever branch
you tell it to. Development on this project has been happening on
`claude/portfolio-app-spec-plan-pdjsod`, not `main`. Two options —
pick one before or right after deploying:
- Point Vercel's Production branch at `claude/portfolio-app-spec-plan-pdjsod`
  directly, and treat that as "production" for now, **or**
- Merge that branch into `main` first (say the word and I'll open a PR —
  I don't create one unless you ask) and point Vercel at `main`, the more
  conventional setup.

## 5. Verify the live deploy

1. Visit the `*.vercel.app` URL — expect an immediate redirect to `/login`
   (this confirms the proxy/auth gate is actually active in production,
   not just locally).
2. Log in with the password you set in step 3.
3. Expect "No holdings yet" with a link to `/import` (fresh database).
4. Upload `sample_data/transactions_sample.csv`, then
   `sample_data/prices_sample.csv` (both are in the repo, on your own
   machine — download them from GitHub or `git clone` the repo to have
   them locally to upload).
5. Back on `/`, expect the same numbers verified locally: **EUR 9,662.50**
   (+440.60 profit), **USD 975.00** (+71.75 profit), 4 positions.
6. From your phone: open the same URL over cellular data (not your home
   WiFi) to confirm it's genuinely internet-reachable, not just resolving
   because you're on the same network as something.
7. Click **Log out**, confirm you land back on `/login`.

If any step doesn't match, stop and tell me what you saw — don't keep
clicking forward on a deploy that's already behaving unexpectedly.

## Cost check

Both Vercel's Hobby plan and Neon's free tier are designed to comfortably
cover an app at this scale (single user, small dataset, occasional
requests). Nothing here should trigger a charge — if either dashboard ever
shows a paid-tier prompt, stop and check with me before accepting it.

## What's still local-only after this

Real transaction/price data still only goes in **through the deployed
app's `/import` page** (or your own machine's `npm run dev` against your
own DB, if you ever want that) — never through this chat. The sample CSVs
above are dummy data, safe to reference here.
