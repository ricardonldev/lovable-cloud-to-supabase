#!/usr/bin/env node
// End-to-end rehearsal of the move from Lovable Cloud to your own Supabase, on a LOCAL Supabase (Docker).
// Nothing leaves your machine and no account is needed. Used locally and in CI (GitHub Actions).
//
// Usage (from a folder with supabase/config.toml, after `supabase start`):
//   node rehearse.mjs [--app ../examples/demo-app] [--out rehearsal-report.md]
//
// What it proves, with made-up users and data:
//   1. "Old" project (plays Lovable Cloud): schema from the app's migrations, users created through Supabase Auth
//      (real password hashes), rows, a file in Storage. Full pg_dump = the database export Lovable gives you.
//   2. "New" project: schema from plan-migration.mjs, data from extract-data.mjs (COPY + psql), files with
//      upload-storage.mjs. Then: counts match, users sign in with their OLD password, RLS still isolates users,
//      serial ids continue after the last imported id, files are readable.
//   3. Control: the same import without session_replication_role = replica FAILS (pg_dump writes tables in
//      alphabetical order, so foreign keys and the app's triggers on auth.users break it), which is why
//      extract-data.mjs sets it.
//   4. SQL editor path: same import with --inserts.
//   5. No-migrations path: schema taken from the export itself (--mode schema).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, combinedSchema } from '../plan-migration.mjs';
import { extract } from '../extract-data.mjs';
import { listUploads, upload } from '../upload-storage.mjs';
import { parseSnapshot, compare, report } from '../compare-counts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };
const appDir = resolve(opt('--app', join(here, '..', 'examples', 'demo-app')));
const outFile = opt('--out', 'rehearsal-report.md');
const work = resolve('.rehearsal');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const cfg = readFileSync(join('supabase', 'config.toml'), 'utf8');
const projectId = (cfg.match(/^\s*project_id\s*=\s*"([^"]+)"/m) || [])[1];
const container = `supabase_db_${projectId}`;
const cli = spawnSync('supabase --version', { shell: true, encoding: 'utf8' }).status === 0 ? 'supabase' : 'npx supabase';

const steps = [];
const log = (ok, name, detail = '') => { steps.push({ ok, name, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const sh = (cmd, input) => {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', input, maxBuffer: 512 * 1024 * 1024 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};
const psql = (sql, extra = '') => sh(`docker exec -i ${container} psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -t -A ${extra}`, sql);
const env = () => Object.fromEntries(sh(`${cli} status -o env`).out.split(/\r?\n/).map((l) => l.match(/^([A-Z_]+)="?([^"]*)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const firstError = (s) => (s.split(/\r?\n/).find((l) => /ERROR/.test(l)) || s.split(/\r?\n/)[0] || '').trim();
const reset = () => { const r = sh(`${cli} db reset --local`); if (r.code !== 0) throw new Error(`db reset failed:\n${r.out}\n${r.err}`); };
const snapshot = () => {
  const a = psql(readFileSync(join(here, '..', 'counts.sql'), 'utf8'));
  const b = psql(readFileSync(join(here, '..', 'counts-auth.sql'), 'utf8'));
  if (a.code || b.code) throw new Error(`counts failed: ${a.err}${b.err}`);
  return { ...parseSnapshot(a.out), ...parseSnapshot(b.out) };
};
async function api(e, path, { method = 'GET', key, token, body, raw } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${token || key}` };
  if (body && !raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${e.API_URL}${path}`, { method, headers, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* binary or empty */ }
  return { status: res.status, ok: res.ok, json, text };
}
const signIn = (e, email, password) => api(e, '/auth/v1/token?grant_type=password', { method: 'POST', key: e.ANON_KEY, body: { email, password } });
async function writeExtract(file, out, opts) {
  const ws = createWriteStream(out);
  const r = await extract(file, { ...opts, write: (s) => ws.write(s) });
  await new Promise((res) => ws.end(res));
  return r;
}

const USERS = [
  { email: 'ana@example.com', password: 'Rehearsal-Ana-1!', name: 'Ana Example' },
  { email: 'luis@example.com', password: 'Rehearsal-Luis-2!', name: 'Luis Example' },
  { email: 'owner@example.com', password: 'Rehearsal-Owner-3!', name: 'Owner Example' },
];

async function newProject(schemaSql, dataFile, label, { expectFail = false } = {}) {
  reset();
  const s = psql(schemaSql);
  if (s.code) { log(false, `${label}: schema on the new project`, firstError(s.err)); return null; }
  const d = psql(readFileSync(dataFile, 'utf8'), '--single-transaction');
  if (expectFail) return d;
  if (d.code) { log(false, `${label}: data import`, firstError(d.err)); return null; }
  return d;
}

try {
  // ---------------------------------------------------------------- 1. Old project ("Lovable Cloud")
  const a = analyze(appDir);
  const schemaSql = combinedSchema(a);
  writeFileSync(join(work, 'schema.sql'), schemaSql);
  log(a.mig.files.length > 0, 'plan-migration: migrations found and ordered', `${a.mig.system}, ${a.mig.files.length} files`);
  reset();
  const s0 = psql(schemaSql);
  log(s0.code === 0, 'old project: schema from the app migrations', s0.code ? firstError(s0.err) : '');
  let e = env();
  const ids = {};
  for (const u of USERS) {
    const r = await api(e, '/auth/v1/admin/users', { method: 'POST', key: e.SERVICE_ROLE_KEY, body: { email: u.email, password: u.password, email_confirm: true, user_metadata: { full_name: u.name } } });
    ids[u.email] = r.json?.id;
    if (!r.ok) throw new Error(`creating user failed: ${r.text}`);
  }
  const [ana, luis] = USERS.map((u) => ids[u.email]);
  // With another app (--app), only what every app has is checked: schema, users (and whatever their sign-up
  // triggers create), export, import, counts and sign-in. Rows, files and RLS checks are specific to the demo.
  const isDemo = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).name === 'demo-bookings-app';
  if (isDemo) psql(`
    INSERT INTO public.services (name, minutes, price_cents, tags, details) VALUES
      ('Haircut', 30, 1500, '{hair,quick}', '{"note": "tab\\there, quote '' and line\\nbreak"}'),
      ('Colour', 90, 4500, '{}', '{}');
    INSERT INTO public.bookings (user_id, service_id, starts_at, notes)
      SELECT '${ana}', id, now() + interval '1 day', 'Ana''s first booking' FROM public.services WHERE name = 'Haircut';
    INSERT INTO public.bookings (user_id, service_id, starts_at, notes)
      SELECT '${ana}', id, now() + interval '2 day', NULL FROM public.services WHERE name = 'Colour';
    INSERT INTO public.bookings (user_id, service_id, starts_at, notes)
      SELECT '${luis}', id, now() + interval '3 day', 'Luis: ñ, é, 😀' FROM public.services WHERE name = 'Haircut';
    INSERT INTO public.audit_log (action) SELECT 'event ' || g FROM generate_series(1, 5) g;
  `);
  if (isDemo) {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');
    const up = await api(e, `/storage/v1/object/avatars/${ana}/photo.png`, { method: 'POST', key: e.SERVICE_ROLE_KEY, raw: true, body: png });
    log(up.ok, 'old project: users, rows and a private file created', `${USERS.length} users via Auth, 3 bookings, 5 log rows`);
  } else {
    const rows = Object.entries(snapshot().tables).map(([t, n]) => `${t} ${n}`).join(', ');
    log(true, `old project (${a.repo}): users created through Auth`, `${USERS.length} users; rows created by sign-up triggers: ${rows || 'none'}`);
  }
  const before = snapshot();
  writeFileSync(join(work, 'before.json'), JSON.stringify(before, null, 1));
  const oldLogin = await signIn(e, USERS[0].email, USERS[0].password);
  log(oldLogin.ok, 'old project: user can sign in');

  // The export Lovable gives you: a full plain-SQL pg_dump of the database
  let dump = sh(`docker exec ${container} pg_dump -U supabase_admin -d postgres`);
  if (dump.code) dump = sh(`docker exec ${container} pg_dump -U postgres -d postgres`);
  writeFileSync(join(work, 'export.sql'), dump.out);
  log(dump.code === 0 && dump.out.includes('COPY auth.users'), 'export: full database dump (structure + data + auth users)', `${(dump.out.length / 1024).toFixed(0)} KB`);
  // What the client downloads from More → Cloud → Storage
  for (const name of psql(`select name from storage.objects where bucket_id = 'avatars'`).out.split(/\r?\n/).filter(Boolean)) {
    const r = await fetch(`${e.API_URL}/storage/v1/object/avatars/${name}`, { headers: { apikey: e.SERVICE_ROLE_KEY, Authorization: `Bearer ${e.SERVICE_ROLE_KEY}` } });
    const dest = join(work, 'storage-download', 'avatars', ...name.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  }
  const maxLogId = isDemo ? Number(psql('select max(id) from public.audit_log').out.trim()) : 0;

  // ---------------------------------------------------------------- 2. New project: migrations + COPY + files
  const ex = await writeExtract(join(work, 'export.sql'), join(work, 'data.sql'), {});
  log(ex.kept.some((t) => t.table === 'auth.users' && t.rows === USERS.length), 'extract-data: tables and users extracted', ex.kept.map((t) => `${t.table} ${t.rows}`).join(', '));
  if (await newProject(schemaSql, join(work, 'data.sql'), 'COPY path')) {
    e = env();
    if (existsSync(join(work, 'storage-download'))) {
      const res = await upload(listUploads(join(work, 'storage-download')), { url: e.API_URL, key: e.SERVICE_ROLE_KEY });
      log(res.every((r) => r.ok), 'upload-storage: files uploaded to the new project', `${res.length} file(s)`);
    }
    const after = snapshot();
    writeFileSync(join(work, 'after.json'), JSON.stringify(after, null, 1));
    const cmp = compare(before, after);
    writeFileSync(join(work, 'compare.md'), report(cmp));
    log(cmp.ok, 'compare-counts: everything from the old database is in the new one', `${cmp.rows.filter((r) => r.estado === 'OK').length} checks OK`);
    const login = await signIn(e, USERS[0].email, USERS[0].password);
    log(login.ok, 'users sign in on the new project with their OLD password');
    const wrong = await signIn(e, USERS[0].email, 'not-the-password');
    log(!wrong.ok, 'a wrong password is still rejected');
  }
  if (isDemo && existsSync(join(work, 'after.json'))) {
    const login = await signIn(e, USERS[0].email, USERS[0].password);
    const mine = await api(e, '/rest/v1/bookings?select=id,notes', { key: e.ANON_KEY, token: login.json?.access_token });
    log(mine.ok && mine.json?.length === 2, 'RLS on the new project: Ana sees only her 2 bookings (3 exist)', `got ${mine.json?.length}`);
    const special = await api(e, '/rest/v1/services?select=details&name=eq.Haircut', { key: e.ANON_KEY });
    log(special.json?.[0]?.details?.note === "tab\there, quote ' and line\nbreak", 'special characters survive (tabs, quotes, line breaks, jsonb)');
    const accents = psql(`select notes from public.bookings where user_id = '${luis}'`).out.trim();
    log(accents === 'Luis: ñ, é, 😀', 'accents and emoji survive');
    const nextId = Number(psql(`insert into public.audit_log (action) values ('after migration') returning id`).out.trim().split(/\r?\n/)[0]);
    log(nextId === maxLogId + 1, 'serial ids continue after the last imported id', `last ${maxLogId}, next ${nextId}`);
    const file = await api(e, `/storage/v1/object/authenticated/avatars/${ana}/photo.png`, { key: e.ANON_KEY, token: login.json?.access_token });
    log(file.ok, 'Ana can read her own file on the new project (storage policies migrated)');
    const profiles = Number(psql('select count(*) from public.profiles').out.trim());
    log(profiles === USERS.length, 'the auth trigger did not run again on import (one profile per user)', `${profiles} profiles`);
  }

  // ---------------------------------------------------------------- 3. Control: same import WITH triggers
  const withTriggers = readFileSync(join(work, 'data.sql'), 'utf8').replace('SET session_replication_role = replica;', 'SET session_replication_role = origin;');
  writeFileSync(join(work, 'data-with-triggers.sql'), withTriggers);
  const ctl = await newProject(schemaSql, join(work, 'data-with-triggers.sql'), 'control', { expectFail: true });
  // pg_dump writes tables alphabetically (auth.identities before auth.users): without replica mode the foreign
  // keys and the app's triggers on auth.users break the import
  log(ctl && ctl.code !== 0, 'control: the same import WITHOUT replica mode fails', firstError(ctl?.err || '').slice(0, 140));

  // ---------------------------------------------------------------- 4. SQL editor path (INSERT statements)
  await writeExtract(join(work, 'export.sql'), join(work, 'data-inserts.sql'), { inserts: true });
  if (await newProject(schemaSql, join(work, 'data-inserts.sql'), 'INSERT path')) {
    e = env();
    const cmp = compare(before, snapshot());
    // Files are not part of this path; ignore the storage check here
    const ok = cmp.rows.filter((r) => !/^files in bucket/.test(r.item)).every((r) => r.estado !== 'FAIL');
    log(ok, 'INSERT path (SQL editor): rows and users match', ok ? '' : cmp.rows.filter((r) => r.estado === 'FAIL').map((r) => r.item).join(', '));
    log((await signIn(e, USERS[1].email, USERS[1].password)).ok, 'INSERT path: users sign in with their old password');
  }

  // ---------------------------------------------------------------- 5. No migrations: schema from the export
  const sx = await writeExtract(join(work, 'export.sql'), join(work, 'schema-from-export.sql'), { mode: 'schema' });
  if (await newProject(readFileSync(join(work, 'schema-from-export.sql'), 'utf8'), join(work, 'data.sql'), 'schema-from-export path')) {
    e = env();
    const cmp = compare(before, snapshot());
    const ok = cmp.rows.filter((r) => !/^files in bucket/.test(r.item)).every((r) => r.estado !== 'FAIL');
    log(ok, 'schema taken from the export (no migrations): schema, rows and users match', `${sx.objects} objects${ok ? '' : `; ${cmp.rows.filter((r) => r.estado === 'FAIL').map((r) => r.item).join(', ')}`}`);
    log((await signIn(e, USERS[2].email, USERS[2].password)).ok, 'schema-from-export path: users sign in with their old password');
  }
} catch (err) {
  log(false, 'rehearsal aborted', err.message.split('\n')[0]);
}

const passed = steps.filter((s) => s.ok).length;
const md = `# Migration rehearsal: Lovable Cloud → own Supabase\n\n${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · local Supabase (Docker) · made-up data only\n\n**${passed}/${steps.length} checks passed.**\n\n| | Check | Detail |\n|---|---|---|\n${steps.map((s) => `| ${s.ok ? '✅' : '❌'} | ${s.name} | ${s.detail.replace(/\|/g, '\\|')} |`).join('\n')}\n`;
writeFileSync(outFile, md);
console.log(`\n${passed}/${steps.length} passed. Report: ${outFile}`);
process.exitCode = passed === steps.length ? 0 : 1;
