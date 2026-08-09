# Deployment

**Status: live.** Deployed on Vercel + Neon, verified reachable from a
phone over cellular data. Two real mistakes happened on the way (Framework
Preset defaulted to "Other" instead of "Next.js," and a database password
got exposed in a screenshot and had to be rotated) — both noted inline
below, since they're the two most likely to recur on a future redeploy or
for anyone else following this doc.

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

   > The Next.js app lives in `web/`, not the repo root —
   > `portfolio-app-spec.md`, `sample_data/`, and the old Python build are
   > siblings of it. Without this, Vercel looks for `package.json` at the
   > repo root and doesn't find a Next.js app.

3. **Check Framework Preset is set to "Next.js," don't assume it.** This
   is the step that actually broke the first real deploy: Root Directory
   was correct, the build itself succeeded, but Vercel had Framework
   Preset set to **"Other"** instead of auto-detecting Next.js, so it went
   looking for a static `public/` output folder that doesn't exist and
   failed with *"No Output Directory named 'public' found after the Build
   completed."* Fix: Project → **Settings → Build and Deployment** →
   Framework Preset → **Next.js** → leave Build Command/Output
   Directory/Install Command on their defaults (Override off) → Save.

4. Don't hit Deploy yet — add the environment variables first (section 3
   below), since a build without them will fail (the app throws on a
   missing `DASHBOARD_PASSWORD`, deliberately — see R3).

## 3. Set environment variables

In the Vercel project's **Settings → Environment Variables**, add for
**Production** (and Preview, if you want preview deploys to work too):

| Key | Value |
|---|---|
| `DATABASE_URL` | the pooled Neon connection string from step 1 |
| `DASHBOARD_PASSWORD` | a real password you choose now — pick it directly in Vercel's UI, don't paste it into any chat, including this one |

Double check the connection string actually landed in the **Value** field,
not the **Key** field — easy to swap by accident, and Vercel doesn't
validate that for you.

Leave every other key from `web/.env.example` unset for now — they're for
connectors that don't exist yet (later roadmap phases) and Vercel doesn't
need them until then.

**If a real secret ever ends up somewhere it shouldn't** (pasted into a
chat, screenshotted, committed by accident) — treat it as compromised
immediately, not "probably fine": in Neon, open the connection panel for
your database → **Reset password** → copy the new pooled connection string
→ update `DATABASE_URL` in Vercel with it → redeploy so the new value
takes effect. Takes under a minute; there's no reason to leave an exposed
credential live while you decide whether it matters.

## 4. Deploy

Click **Deploy**. First build takes a minute or two. Vercel gives you a
`*.vercel.app` URL when it's done.

**Which branch:** point Vercel's Production branch at `main`. The repo had
no `main` branch until now — all development had been happening directly on
`claude/portfolio-app-spec-plan-pdjsod` since the repo started empty. `main`
now exists and points at the same commit, so it's current and ready to
deploy from. (A normal PR-based merge wasn't possible here since there was
no `main` to merge into — GitHub doesn't allow a PR with no diff between
identical branches, so `main` was created directly instead.)

## 5. Verify the live deploy

**Done — all of the below passed**, including from a phone on cellular
data, confirming the app is genuinely internet-reachable and not just
resolving via a shared network. Kept as a checklist for the next redeploy
or anyone else following this doc.

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
