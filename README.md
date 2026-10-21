# Lovable Cloud → your own Supabase

[![tests](https://github.com/ricardonldev/lovable-cloud-to-supabase/actions/workflows/test.yml/badge.svg)](https://github.com/ricardonldev/lovable-cloud-to-supabase/actions/workflows/test.yml)

A small, tested toolkit to move a Lovable app from the built-in backend (**Lovable Cloud**) to a **Supabase project you own**: schema, data, users *with their passwords*, storage files, and a check that nothing was left behind.

Lovable has no one-click transfer. Its [official guide](https://docs.lovable.dev/tips-tricks/external-deployment-hosting) lists what moves and how, but leaves the hard parts to you: importing the export, keeping users able to sign in, restoring files, and proving the result matches. These scripts cover exactly those parts. Every step is rehearsed end to end on a local Supabase in CI.

## When you need this
- **Since October 5, 2026, each Lovable Cloud project runs on a single database** ([Lovable docs](https://docs.lovable.dev/features/environments)). Test and Live are retired, so what you try while building runs against your real data. With your own Supabase you can have separate development and production projects again.
- You need direct database access, your own backups and point-in-time recovery, a specific region, or clearer ownership before selling or handing over the app.

## What it does
| Script | What for |
|---|---|
| `plan-migration.mjs <repo> --out plan.md --schema schema.sql` | Reads the repo (read-only) and writes a step-by-step plan: migrations in the right order (`supabase/migrations` or Drizzle's `meta/_journal.json` in apps created since May 2026), buckets, Edge Functions and their secrets, pg_cron jobs, triggers on `auth.users`, and the **Lovable-only services that stop working outside Lovable** (managed Google/Apple sign-in, the Lovable AI gateway, Lovable Jobs). Also writes one `schema.sql` for the new project.<br>It flags two traps found in a real move:<br>- **Functions with no `verify_jwt` entry in `config.toml`:** Lovable runs them without JWT checks, but the Supabase CLI requires a JWT, so Stripe webhooks, email links and public endpoints would return 401. `--jwt-toml` writes the entries to add.<br>- **App code that compares `location.hostname` with its own list of hosts:** add the new domain there, or the app may treat it as an unknown tenant. |
| `extract-data.mjs export.sql --out data.sql [--inserts]` | Takes Lovable's database export (plain SQL, `.gz` too) and keeps what the new project needs: your tables, `auth.users` and `auth.identities` (password hashes included), sequences. Wraps it in `session_replication_role = replica`: without that the import fails (see the rehearsal). Empties each app table right before loading it, because Lovable's migrations often insert sample rows that would otherwise end up duplicated (`--no-clear` to skip). `--inserts` for the SQL editor; `--mode schema` rebuilds the schema from the export when migrations are missing or out of date. Streams the file, so multi-GB exports are fine. |
| `upload-storage.mjs <folder>` | Uploads the files you downloaded from Lovable's Storage tab to the new project, keeping their paths. The key is read from the environment only. |
| `counts.sql`, `counts-auth.sql` | Run in the old and the new database: rows per table, columns, RLS, policies, functions, triggers, users, identities, files per bucket. Counts and names only, never row contents. |
| `compare-counts.mjs before.json after.json` | Compares both snapshots and fails if anything is missing. |

## Rehearsal (what is actually proven)
`rehearsal/rehearse.mjs` runs the whole move on a local Supabase (Docker) with a made-up app ([`examples/demo-app`](examples/demo-app)) and made-up users:

- users created through Supabase Auth sign in on the new project **with their old password**, and a wrong password is still rejected;
- row level security still isolates users; storage policies still work (a user can read only their own file);
- serial ids continue after the last imported id; tabs, quotes, line breaks, accents, emoji and `jsonb` survive;
- the app's trigger on `auth.users` does not run again on import;
- **control:** the same import without replica mode fails;
- the SQL-editor path (`--inserts`) and the no-migrations path (`--mode schema`) also end with every table, user and bucket matching.

It also runs against real apps (`--app <repo>`): with the schema of a real Lovable app (TanStack Start + Drizzle migrations) it found that the migrations insert sample rows, which the first version duplicated. The comparison caught it; the fix is in `extract-data.mjs`.

```bash
supabase init && supabase start
node rehearsal/rehearse.mjs --out rehearsal-report.md
```

## Before you start
- The export contains **all your users' data and password hashes**. Keep it off shared folders and delete it (and `data.sql`) once the move is verified. If someone else runs these steps for you, under the GDPR they act as a data processor and need a written agreement.
- Everyone signed in will have to sign in again (the new project has a different JWT secret). Passwords are kept.
- Freeze the app during the switch: data written after the export is not moved.
- Keep Lovable Cloud for a few days as a fallback before removing it; removal cannot be undone.
- On your own Supabase, backups, monitoring and backend security are your responsibility.

## Requirements
Node 20+. `psql` for the COPY import (or `--inserts` and the Supabase SQL editor for small databases). Docker only for the rehearsal.

```bash
node --test tests/     # unit tests, no Docker needed
```

## About
Not affiliated with Lovable or Supabase. Built with AI assistance (Claude Code); every script is reviewed and tested by me, and the rehearsal runs on every push.
Need this done for your app? I offer it as a fixed-price service on [Fiverr](https://www.fiverr.com/ricardonldev).

MIT License.
