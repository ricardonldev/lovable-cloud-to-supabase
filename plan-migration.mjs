#!/usr/bin/env node
// Migration plan for moving a Lovable app from Lovable Cloud (built-in backend) to your own Supabase project.
// Usage: node plan-migration.mjs <repo> [--out plan.md] [--schema schema.sql]
//   --schema  writes every migration, in the order they must run, into one SQL file for the new project
//
// Read-only: it never runs code from the repo and never prints secret values (only variable names).
// Based on Lovable's official guide: https://docs.lovable.dev/tips-tricks/external-deployment-hosting

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.output', '.vercel', '.netlify', '.wrangler', 'coverage']);
const CODE = /\.(m|c)?(j|t)sx?$/;
// Provided automatically to every Supabase Edge Function: no need to set them as secrets
const AUTO_SECRETS = new Set(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'SB_REGION', 'SB_EXECUTION_ID', 'DENO_REGION']);

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (st.size < 2_000_000) files.push(p);
  }
  return files;
}

/** Finds the migrations and the order they must run in. */
export function findMigrations(repo) {
  const read = (p) => readFileSync(p, 'utf8');
  const supaDir = join(repo, 'supabase', 'migrations');
  if (existsSync(supaDir)) {
    const files = readdirSync(supaDir).filter((f) => f.endsWith('.sql')).sort();
    if (files.length) return { system: 'supabase', dir: 'supabase/migrations', files: files.map((f) => join(supaDir, f)) };
  }
  // Newer Lovable apps (TanStack Start, from May 2026) keep Drizzle migrations; the order is in meta/_journal.json
  let out = 'drizzle/migrations';
  for (const cfg of ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs']) {
    const p = join(repo, cfg);
    if (existsSync(p)) { const m = read(p).match(/out\s*:\s*["'`]\.?\/?([^"'`]+)["'`]/); if (m) out = m[1].replace(/\/$/, ''); }
  }
  const drizDir = join(repo, out);
  if (existsSync(drizDir)) {
    const sql = readdirSync(drizDir).filter((f) => f.endsWith('.sql'));
    const journal = join(drizDir, 'meta', '_journal.json');
    let ordered = [...sql].sort();
    let journalUsed = false;
    if (existsSync(journal)) {
      try {
        const entries = JSON.parse(read(journal)).entries || [];
        const byTag = entries.sort((a, b) => a.idx - b.idx).map((e) => `${e.tag}.sql`).filter((f) => sql.includes(f));
        if (byTag.length) { ordered = [...byTag, ...sql.filter((f) => !byTag.includes(f)).sort()]; journalUsed = true; }
      } catch { /* unreadable journal: fall back to file names */ }
    }
    if (ordered.length) return { system: 'drizzle', dir: out, journalUsed, files: ordered.map((f) => join(drizDir, f)) };
  }
  return { system: null, dir: null, files: [] };
}

export function analyze(repo) {
  const files = walk(repo);
  const rel = (f) => relative(repo, f).replace(/\\/g, '/');
  const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
  const pkgPath = join(repo, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(read(pkgPath) || '{}') : {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const mig = findMigrations(repo);
  const sql = mig.files.map(read).join('\n');

  // Things the SQL creates that need attention on the new project
  const buckets = [...sql.matchAll(/insert\s+into\s+storage\.buckets\s*\(([^)]*)\)\s*values\s*\(\s*'([^']+)'(?:\s*,\s*'([^']+)')?([^;]*)/gi)]
    .map((m) => ({ id: m[2], public: /\btrue\b/i.test(m[4] || '') }));
  const extensions = [...new Set([...sql.matchAll(/create\s+extension\s+(?:if\s+not\s+exists\s+)?"?([\w-]+)"?/gi)].map((m) => m[1].toLowerCase()))];
  const cronJobs = [...sql.matchAll(/cron\.schedule\s*\(\s*'([^']+)'/gi)].map((m) => m[1]);
  const realtime = [...new Set([...sql.matchAll(/alter\s+publication\s+supabase_realtime\s+add\s+table\s+([\w."]+)/gi)].map((m) => m[1].replace(/"/g, '')))];
  const authTriggers = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?trigger\s+"?(\w+)"?[\s\S]{0,200}?\bon\s+auth\.(\w+)/gi)].map((m) => `${m[1]} (auth.${m[2]})`);
  const vault = /vault\.(create_secret|secrets|decrypted_secrets)/i.test(sql);
  // Sample rows inside migrations (Lovable does this): recreated with the schema, replaced by the data import
  const outsideFunctions = sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const seededTables = [...new Set([...outsideFunctions.matchAll(/insert\s+into\s+(?:public\.)?"?(\w+)"?\s*\(/gi)].map((m) => m[1]).filter((t) => !/^(buckets|objects)$/i.test(t)))];
  const netHttp = /\bnet\.http_(get|post)\b/i.test(sql);

  // Edge Functions and the secrets they read
  const fnDir = join(repo, 'supabase', 'functions');
  const functions = [];
  if (existsSync(fnDir)) {
    for (const name of readdirSync(fnDir)) {
      const p = join(fnDir, name);
      if (name.startsWith('_') || !statSync(p).isDirectory()) continue;
      const src = walk(p).filter((f) => CODE.test(f)).map(read).join('\n');
      const secrets = [...new Set([...src.matchAll(/Deno\.env\.get\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g)].map((m) => m[1]))].filter((s) => !AUTO_SECRETS.has(s));
      functions.push({ name, secrets });
    }
  }
  const config = existsSync(join(repo, 'supabase', 'config.toml')) ? read(join(repo, 'supabase', 'config.toml')) : '';
  const noJwt = [...config.matchAll(/\[functions\.([\w-]+)\][^[]*?verify_jwt\s*=\s*false/g)].map((m) => m[1]);

  // App code: env vars, auth methods and Lovable-only services
  const code = files.filter((f) => CODE.test(f) && !rel(f).startsWith('supabase/functions/'));
  const codeText = code.map(read).join('\n');
  const envFiles = files.filter((f) => /(^|[\\/])\.env[^\\/]*$/.test(f));
  const envNames = [...new Set(envFiles.flatMap((f) => [...read(f).matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1])))].sort();
  const supabaseVars = envNames.filter((v) => /SUPABASE|LOVABLE_DB/.test(v));
  const serverVars = [...new Set([...codeText.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]+)|\[['"]([A-Z][A-Z0-9_]+)['"]\])/g)].map((m) => m[1] || m[2]))]
    .filter((v) => !/^(NODE_ENV|MODE|DEV|PROD|SSR)$/.test(v)).sort();
  const oauth = [...new Set([...codeText.matchAll(/provider\s*:\s*['"](\w+)['"]|signInWithOAuth\(\s*['"](\w+)['"]/g)].map((m) => m[1] || m[2]))];
  const auth = {
    password: /signInWithPassword|signUp\s*\(/.test(codeText),
    magicLink: /signInWithOtp/.test(codeText),
    phone: /phone\s*:/.test(codeText) && /signInWithOtp|verifyOtp/.test(codeText),
    oauth,
    lovableManagedOAuth: Object.keys(deps).some((d) => d.startsWith('@lovable.dev/cloud-auth')) || /lovable\.auth|cloud-auth-js/.test(codeText),
  };
  const lovableAi = /ai\.gateway\.lovable\.dev|LOVABLE_API_KEY/.test(codeText + functions.map((f) => f.secrets.join(' ')).join(' ') + (existsSync(fnDir) ? walk(fnDir).filter((f) => CODE.test(f)).map(read).join('\n') : ''));
  // Lovable Jobs call server routes protected with LOVABLE_CRON_SECRET: outside Lovable nobody calls them
  const lovableJobs = code.filter((f) => /authenticateCronRequest\s*\(/.test(read(f)) && !/cron-auth\.[jt]s$/.test(f)).map(rel);
  const hardcodedRefs = [...new Set(code.flatMap((f) => [...read(f).matchAll(/https:\/\/([a-z]{20})\.supabase\.co/g)].map(() => rel(f))))];
  const tanstack = Boolean(deps['@tanstack/react-start'] || deps['@lovable.dev/vite-tanstack-config']);

  return { repo: basename(repo), mig: { ...mig, files: mig.files.map(rel) }, migAbs: mig.files, buckets, extensions, cronJobs, realtime, authTriggers, vault, netHttp, functions, noJwt, supabaseVars, serverVars, auth, lovableAi, lovableJobs, seededTables, hardcodedRefs, tanstack, projectId: (config.match(/^\s*project_id\s*=\s*"([^"]+)"/m) || [])[1] || null };
}

/** All migrations in order, in one file, with a header per migration. */
export function combinedSchema(a) {
  let out = `-- Schema for the new Supabase project, generated by plan-migration.mjs from ${a.mig.dir}\n-- Run it ONCE on an EMPTY project (SQL editor or psql), before importing any data.\n`;
  a.migAbs.forEach((f, i) => { out += `\n-- ---------------------------------------------------------------- ${i + 1}/${a.migAbs.length}: ${a.mig.files[i]}\n${readFileSync(f, 'utf8').trim()}\n`; });
  return out;
}

export function planMarkdown(a) {
  const yes = (b) => (b ? 'yes' : 'no');
  const L = [];
  L.push(`# Migration plan: ${a.repo} → your own Supabase`, '');
  L.push('Read-only analysis of the repository. Secret values are never shown, only variable names.', '');
  L.push('## 1. What was found', '');
  L.push('| Item | Found | What it means for the move |', '|---|---|---|');
  L.push(`| Migrations | ${a.mig.system ? `${a.mig.files.length} in \`${a.mig.dir}\` (${a.mig.system}${a.mig.system === 'drizzle' ? a.mig.journalUsed ? ', order from meta/_journal.json' : ', order from file names: CHECK IT' : ''})` : '**none**'} | ${a.mig.system ? 'They rebuild the schema on the new project (tables, RLS policies, functions, triggers)' : '**Blocker:** the schema only exists in the Cloud database. Restore it from the full export instead of from migrations'} |`);
  L.push(`| Storage buckets | ${a.buckets.length ? a.buckets.map((b) => `\`${b.id}\`${b.public ? ' (public)' : ''}`).join(', ') : 'none in migrations'} | Buckets come with the schema; the **files** are not in the database export: download them from More → Cloud → Storage and upload them again |`);
  L.push(`| Edge Functions | ${a.functions.length ? a.functions.map((f) => `\`${f.name}\``).join(', ') : 'none'} | Deploy with \`supabase functions deploy\`; set their secrets on the new project${a.noJwt.length ? `. Public (verify_jwt = false): ${a.noJwt.join(', ')}` : ''} |`);
  const secrets = [...new Set(a.functions.flatMap((f) => f.secrets))];
  L.push(`| Function secrets | ${secrets.length ? secrets.map((s) => `\`${s}\``).join(', ') : 'none'} | The client creates them again (Edge Functions → Secrets). Never sent by chat |`);
  L.push(`| Extensions | ${a.extensions.join(', ') || 'none declared'} | Enable any missing one in Database → Extensions before running the schema |`);
  L.push(`| Scheduled jobs (pg_cron) | ${a.cronJobs.join(', ') || 'none'} | ${a.cronJobs.length ? 'Recreated by the schema, but check they point to the new project URLs and keys' : '—'} |`);
  L.push(`| Realtime tables | ${a.realtime.join(', ') || 'none'} | ${a.realtime.length ? 'Check the publication after the import (Database → Publications)' : '—'} |`);
  L.push(`| Triggers on auth tables | ${a.authTriggers.join(', ') || 'none'} | ${a.authTriggers.length ? '**Import data with triggers disabled** (session_replication_role = replica), or every imported user fires them again' : '—'} |`);
  L.push(`| Rows inserted by migrations | ${a.seededTables.join(', ') || 'none'} | ${a.seededTables.length ? 'The schema recreates these sample rows; extract-data.mjs empties each table before loading the real rows, so they are not duplicated (do not use --no-clear)' : '—'} |`);
  L.push(`| Vault / pg_net | ${yes(a.vault)} / ${yes(a.netHttp)} | ${a.vault ? 'Vault secrets are encrypted per project: create them again. ' : ''}${a.netHttp ? 'HTTP calls from SQL: update the URLs.' : a.vault ? '' : '—'} |`);
  const authMethods = [a.auth.password && 'email + password', a.auth.magicLink && 'magic link / OTP', a.auth.phone && 'phone', ...a.auth.oauth.map((p) => `OAuth: ${p}`)].filter(Boolean);
  L.push(`| Sign-in methods | ${authMethods.join(', ') || 'not detected'} | Users and password hashes are in the export: users keep their passwords. Providers must be configured again${a.auth.oauth.length ? ' with the client\'s own OAuth apps and the new redirect URL' : ''} |`);
  L.push(`| Lovable-managed sign-in | ${yes(a.auth.lovableManagedOAuth)} | ${a.auth.lovableManagedOAuth ? '**Only works on Lovable Cloud.** Replace with Supabase Auth providers (client creates the Google/Apple OAuth apps)' : '—'} |`);
  L.push(`| Lovable AI gateway | ${yes(a.lovableAi)} | ${a.lovableAi ? '**Only works on Lovable Cloud.** Switch to the client\'s own AI provider key (OpenAI, Gemini, Anthropic…) and set a spending limit' : '—'} |`);
  L.push(`| Lovable Jobs (scheduled) | ${a.lovableJobs.join(', ') || 'none'} | ${a.lovableJobs.length ? '**Only run on Lovable.** Schedule these routes elsewhere (pg_cron + pg_net, or the hosting\'s cron) with a new secret' : '—'} |`);
  L.push(`| Supabase variables | ${a.supabaseVars.map((v) => `\`${v}\``).join(', ') || 'none in .env files'} | Point them to the new project${a.supabaseVars.includes('LOVABLE_DB_MIGRATION_URL') ? '. `LOVABLE_DB_MIGRATION_URL` is Lovable\'s own: not needed on your Supabase' : ''} |`);
  L.push(`| Server variables | ${a.serverVars.map((v) => `\`${v}\``).join(', ') || 'none'} | Set them in the hosting that runs the server code${a.tanstack ? ' (TanStack Start app: needs a host that runs server code)' : ''} |`);
  L.push(`| Project URL written in code | ${a.hardcodedRefs.join(', ') || 'no'} | ${a.hardcodedRefs.length ? 'Replace with the environment variable before switching' : '—'} |`);
  L.push('');
  L.push('## 2. Steps', '');
  const steps = [
    ['Client', 'Create the new Supabase project (same region as the users). Invite the developer to it while it is still empty.'],
    ['Developer', `Run the schema on the empty project: \`schema.sql\`${a.mig.system === 'supabase' ? ' or `supabase link` + `supabase db push`' : ''}. Enable extensions first if it fails.`],
    ['Developer', 'Configure Auth on the new project: site URL, redirect URLs, email templates and SMTP, sign-in providers (with the client\'s OAuth apps).'],
    ['Developer', secrets.length || a.functions.length ? 'Deploy the Edge Functions; the client adds their secrets.' : 'No Edge Functions to deploy.'],
    ['Client', 'In Lovable: More → Cloud → Overview → Advanced settings → Export project data → Database → Export. Download it (email link or More → Cloud → Storage). One export every 24 h.'],
    ['Client', a.buckets.length ? 'Download the storage files of every bucket (More → Cloud → Storage).' : 'No storage files to move (check More → Cloud → Storage anyway).'],
    ['Client (or developer with a signed data processing agreement)', 'Extract the data from the export (`extract-data.mjs`) and import it into the new project with triggers disabled.'],
    ...(a.buckets.length ? [['Client (or developer, same condition)', 'Upload the storage files keeping their paths (`upload-storage.mjs`).']] : []),
    ['Both', 'Run `counts.sql` (and `counts-auth.sql`) on the old and the new database and compare them with `compare-counts.mjs`. Every table must match.'],
    ['Developer', 'Point the app to the new project (.env / hosting variables), redeploy, and test: sign in with an existing account, read and write data, upload a file.'],
    ['Client', 'Keep Lovable Cloud untouched for a few days as a fallback. Only then remove it (it cannot be undone, and exports saved in Cloud storage are lost).'],
  ];
  steps.forEach(([who, what], i) => L.push(`${i + 1}. **${who}:** ${what}`));
  L.push('', '## 3. Things to tell the client before starting', '');
  L.push('- Everyone who is signed in will have to sign in again (different JWT secret). Passwords are kept.');
  L.push('- Plan a short freeze: data written in the old app after the export is not moved. Export → import → switch in one sitting.');
  L.push('- From then on, backups, monitoring and the security of the backend are the client\'s responsibility (Lovable no longer does it). Point-in-time recovery is a paid Supabase add-on.');
  if (a.auth.lovableManagedOAuth || a.lovableAi || a.lovableJobs.length) L.push('- Some features use Lovable-only services (see above): they stop working until replaced.');
  return L.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const repo = args.find((x, i) => !x.startsWith('--') && !['--out', '--schema'].includes(args[i - 1]));
  if (!repo || !existsSync(repo)) { console.error('Usage: node plan-migration.mjs <repo> [--out plan.md] [--schema schema.sql]'); process.exit(2); }
  const a = analyze(repo);
  const md = planMarkdown(a);
  const oi = args.indexOf('--out');
  if (oi !== -1) writeFileSync(args[oi + 1], md);
  const si = args.indexOf('--schema');
  if (si !== -1) {
    if (!a.migAbs.length) { console.error('No migrations found: cannot build schema.sql'); process.exit(1); }
    writeFileSync(args[si + 1], combinedSchema(a));
  }
  process.stdout.write(md);
}
