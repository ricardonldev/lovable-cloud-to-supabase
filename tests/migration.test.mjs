// Unit tests of the migration toolkit (no Docker needed). The end-to-end rehearsal is rehearsal/rehearse.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze, planMarkdown, combinedSchema, findMigrations } from '../plan-migration.mjs';
import { extract } from '../extract-data.mjs';
import { parseSnapshot, compare, report } from '../compare-counts.mjs';
import { listUploads, authHeaders, upload } from '../upload-storage.mjs';

const fx = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const demo = fileURLToPath(new URL('../examples/demo-app', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'migration-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------- plan-migration
const old = analyze(fx('old-style-app'));
const oldPlan = planMarkdown(old);

test('plan: supabase/migrations ordered by timestamp, not by name', () => {
  assert.equal(old.mig.system, 'supabase');
  assert.deepEqual(old.mig.files, ['supabase/migrations/20251008155159_first.sql', 'supabase/migrations/20251008155215_second.sql']);
});
test('plan: drizzle migrations ordered by meta/_journal.json (newer Lovable apps)', () => {
  const d = findMigrations(demo);
  assert.equal(d.system, 'drizzle');
  assert.equal(d.journalUsed, true);
  assert.match(d.files[0], /0000_init\.sql$/);
});
test('plan: journal order wins over file names', () => {
  const dir = join(tmp, 'drz');
  mkdirSync(join(dir, 'drizzle', 'migrations', 'meta'), { recursive: true });
  writeFileSync(join(dir, 'drizzle', 'migrations', 'b_first.sql'), 'select 1;');
  writeFileSync(join(dir, 'drizzle', 'migrations', 'a_second.sql'), 'select 2;');
  writeFileSync(join(dir, 'drizzle', 'migrations', 'meta', '_journal.json'), JSON.stringify({ entries: [{ idx: 0, tag: 'b_first' }, { idx: 1, tag: 'a_second' }] }));
  assert.deepEqual(findMigrations(dir).files.map((f) => f.split(/[\\/]/).pop()), ['b_first.sql', 'a_second.sql']);
});
test('plan: buckets, extensions, cron jobs, realtime, auth triggers and vault', () => {
  assert.deepEqual(old.buckets, [{ id: 'invoices', public: false }, { id: 'logos', public: true }]);
  assert.ok(old.extensions.includes('pg_cron'));
  assert.deepEqual(old.cronJobs, ['nightly-cleanup']);
  assert.deepEqual(old.realtime, ['public.notes']);
  assert.deepEqual(old.authTriggers, ['on_auth_user_created (auth.users)']);
  assert.equal(old.vault, true);
});
test('plan: Edge Functions and their secrets (not the automatic ones, not _shared)', () => {
  assert.deepEqual(old.functions, [{ name: 'send-email', secrets: ['RESEND_API_KEY', 'LOVABLE_API_KEY'] }]);
  assert.deepEqual(old.noJwt, ['send-email']);
});
test('plan: Lovable-only services are flagged (managed sign-in, AI gateway, Jobs)', () => {
  assert.equal(old.auth.lovableManagedOAuth, true);
  assert.equal(old.lovableAi, true);
  assert.deepEqual(old.lovableJobs, ['src/routes/cron.ts']);
  assert.deepEqual(old.auth.oauth.sort(), ['apple', 'google']);
  assert.equal(old.auth.magicLink, true);
  assert.match(oldPlan, /Lovable AI gateway \| yes \| \*\*Only works on Lovable Cloud/);
});
test('plan: hard-coded project URL and variables, never values', () => {
  assert.deepEqual(old.hardcodedRefs, ['src/client.ts']);
  assert.deepEqual(old.supabaseVars, ['VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_URL']);
  assert.doesNotMatch(oldPlan, /abcdefghijklmnopqrst/);
});
test('plan: combined schema keeps the order and marks each file', () => {
  const s = combinedSchema(old);
  assert.ok(s.indexOf('1/2: supabase/migrations/20251008155159_first.sql') < s.indexOf('2/2: supabase/migrations/20251008155215_second.sql'));
  assert.match(s, /CREATE TABLE public\.notes/);
});
test('plan: a repo without migrations is a blocker in the plan', () => {
  const dir = join(tmp, 'nomig');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}');
  assert.match(planMarkdown(analyze(dir)), /\*\*Blocker:\*\*/);
});

// ---------------------------------------------------------------- extract-data
// A small export in the format pg_dump writes (headers, COPY blocks with tabs, setval, ACLs)
const T = '\t';
const dump = [
  'SET statement_timeout = 0;',
  "SELECT pg_catalog.set_config('search_path', '', false);",
  '--', '-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -', '--', '', 'CREATE EXTENSION pgcrypto WITH SCHEMA extensions;', '',
  '--', '-- Name: notes; Type: TABLE; Schema: public; Owner: postgres', '--', '', 'CREATE TABLE public.notes (', '    id bigint NOT NULL,', '    body text', ');', '',
  '--', '-- Name: users on_auth_user_created; Type: TRIGGER; Schema: auth; Owner: supabase_auth_admin', '--', '', 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.on_signup();', '',
  '--', '-- Name: objects update_objects_updated_at; Type: TRIGGER; Schema: storage; Owner: supabase_storage_admin', '--', '', 'CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();', '',
  '--', '-- Name: objects Read own; Type: POLICY; Schema: storage; Owner: supabase_storage_admin', '--', '', "CREATE POLICY \"Read own\" ON storage.objects FOR SELECT TO authenticated USING ((bucket_id = 'invoices'::text));", '',
  '--', '-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres', '--', '', 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;', '',
  '--', '-- Name: TABLE notes; Type: ACL; Schema: public; Owner: postgres', '--', '', 'GRANT SELECT ON TABLE public.notes TO authenticated;', '',
  '--', '-- Data for Name: identities; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin', '--', '',
  'COPY auth.identities (id, user_id, provider) FROM stdin;', `i1${T}u1${T}email`, '\\.', '',
  '--', '-- Data for Name: sessions; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin', '--', '',
  'COPY auth.sessions (id, user_id) FROM stdin;', `s1${T}u1`, `s2${T}u1`, '\\.', '',
  '--', '-- Data for Name: users; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin', '--', '',
  'COPY auth.users (id, email, encrypted_password) FROM stdin;', `u1${T}ana@example.com${T}$2a$10$abcdefghijklmnopqrstuv`, '\\.', '',
  '--', '-- Data for Name: notes; Type: TABLE DATA; Schema: public; Owner: postgres', '--', '',
  'COPY public.notes (id, body) FROM stdin;', `1${T}tab\\there, quote ' and line\\nbreak`, `2${T}\\N`, `3${T}back\\\\slash ñ`, '\\.', '',
  '--', '-- Data for Name: logs; Type: TABLE DATA; Schema: public; Owner: postgres', '--', '',
  'COPY public.logs (id) FROM stdin;', '1', '\\.', '',
  '--', '-- Data for Name: buckets; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin', '--', '',
  'COPY storage.buckets (id, name, owner, public, file_size_limit, allowed_mime_types, type) FROM stdin;', `invoices${T}invoices${T}\\N${T}f${T}\\N${T}\\N${T}STANDARD`, '\\.', '',
  '--', '-- Data for Name: objects; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin', '--', '',
  'COPY storage.objects (id, bucket_id, name) FROM stdin;', `o1${T}invoices${T}u1/a.pdf`, '\\.', '',
  "SELECT pg_catalog.setval('public.notes_id_seq', 3, true);",
  "SELECT pg_catalog.setval('auth.refresh_tokens_id_seq', 9, true);",
  "INSERT INTO public.tags (id, name) VALUES (1, 'it''s; fine');",
  'INSERT INTO public.tags (id, name) VALUES (2, \'multi', 'line\');',
  '',
].join('\n');
const dumpFile = join(tmp, 'export.sql');
writeFileSync(dumpFile, dump);
const run = async (file, opts) => { let out = ''; const r = await extract(file, { ...opts, write: (s) => { out += s; } }); return { out, r }; };

test('extract: keeps public tables and auth users/identities, drops sessions and storage objects', async () => {
  const { out, r } = await run(dumpFile, { exclude: ['public.logs'] });
  assert.deepEqual(r.kept.map((t) => t.table), ['auth.identities', 'auth.users', 'public.notes', 'public.tags']);
  assert.ok(r.skipped.some((t) => t.table === 'auth.sessions' && t.rows === 2));
  assert.ok(r.skipped.some((t) => t.table === 'storage.objects'));
  assert.ok(r.skipped.some((t) => t.table === 'public.logs'));
  assert.match(out, /^SET session_replication_role = replica;$/m);
  assert.match(out, /SET session_replication_role = origin;\n$/);
  assert.match(out, /\$2a\$10\$abcdefghijklmnopqrstuv/); // password hashes travel with the users
  assert.match(out, /setval\('public\.notes_id_seq', 3, true\)/);
  assert.doesNotMatch(out, /refresh_tokens_id_seq/);
  assert.match(out, /VALUES \(2, 'multi\nline'\);/);
  // sample rows created by the migrations are replaced, not duplicated (found with a real Lovable app)
  assert.match(out, /DELETE FROM public\.notes;\nCOPY public\.notes/);
  assert.match(out, /DELETE FROM public\.tags;\nINSERT INTO public\.tags/);
  assert.doesNotMatch(out, /DELETE FROM auth\./);
});
test('extract --no-clear keeps whatever the migrations inserted', async () => {
  const { out } = await run(dumpFile, { clear: false });
  assert.doesNotMatch(out, /DELETE FROM/);
});
test('plan: sample rows inserted by migrations (not inside functions or comments)', () => {
  assert.deepEqual(analyze(demo).seededTables, []);
  const dir = join(tmp, 'seeded');
  mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true });
  writeFileSync(join(dir, 'supabase', 'migrations', '1_x.sql'), "-- INSERT INTO public.nope (a) VALUES (1);\nCREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ INSERT INTO public.inside (a) VALUES (1) $$;\nINSERT INTO public.services (name) VALUES ('Cut');");
  assert.deepEqual(analyze(dir).seededTables, ['services']);
});
test('extract --inserts: COPY rows become INSERTs with correct escaping', async () => {
  const { out } = await run(dumpFile, { inserts: true });
  assert.match(out, /INSERT INTO public\.notes \(id, body\) VALUES \('1', 'tab\there, quote '' and line\nbreak'\);/);
  assert.match(out, /VALUES \('2', NULL\);/);
  assert.match(out, /VALUES \('3', 'back\\slash ñ'\);/);
  assert.match(out, /^BEGIN;$/m);
  assert.match(out, /^COMMIT;$/m);
  assert.doesNotMatch(out, /FROM stdin/);
});
test('extract --mode schema: app objects only; Supabase internals and default ACLs left out', async () => {
  const { out } = await run(dumpFile, { mode: 'schema' });
  assert.match(out, /CREATE TABLE public\.notes/);
  assert.match(out, /GRANT SELECT ON TABLE public\.notes TO authenticated/);
  assert.match(out, /CREATE TRIGGER on_auth_user_created/); // app trigger on auth.users
  assert.match(out, /CREATE POLICY "Read own" ON storage\.objects/); // app policy on storage
  assert.doesNotMatch(out, /update_objects_updated_at/); // Supabase's own trigger
  assert.doesNotMatch(out, /ALTER DEFAULT PRIVILEGES/);
  assert.doesNotMatch(out, /COPY /);
  assert.match(out, /CREATE EXTENSION IF NOT EXISTS pgcrypto/);
  assert.match(out, /INSERT INTO storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\) VALUES \('invoices', 'invoices', 'f', NULL, NULL\) ON CONFLICT \(id\) DO NOTHING;/);
});
test('extract: reads .gz exports and refuses custom-format dumps with instructions', async () => {
  const gz = join(tmp, 'export.sql.gz');
  writeFileSync(gz, gzipSync(dump));
  const { r } = await run(gz, {});
  assert.ok(r.kept.some((t) => t.table === 'public.notes' && t.rows === 3));
  const custom = join(tmp, 'export.dump');
  writeFileSync(custom, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(20)]));
  await assert.rejects(run(custom, {}), /pg_restore -f/);
});
test('extract CLI prints what was included and left out', () => {
  const cli = fileURLToPath(new URL('../extract-data.mjs', import.meta.url));
  const p = spawnSync(process.execPath, [cli, dumpFile, '--out', join(tmp, 'data.sql'), '--auth-tables', 'users'], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /auth\.users: 1 rows/);
  assert.match(p.stdout, /auth\.identities: 1 rows/); // left out with --auth-tables users
  assert.doesNotMatch(readFileSync(join(tmp, 'data.sql'), 'utf8'), /COPY auth\.identities/);
});

// ---------------------------------------------------------------- compare-counts
const snap = {
  tables: { bookings: 3, profiles: 3 }, columns: { bookings: 6 }, rls_enabled: ['bookings', 'profiles'],
  policies: ['public.bookings: Read own'], functions: ['handle_new_user()'], triggers: ['auth.users: on_auth_user_created'],
};
const authSnap = { auth_users: 3, auth_identities: 3, identities_by_provider: { email: 3 }, storage_buckets: ['avatars'], storage_objects: { avatars: 2 } };

test('compare: identical snapshots pass', () => {
  const r = compare({ ...snap, ...authSnap }, { ...snap, ...authSnap });
  assert.equal(r.ok, true);
  assert.match(report(r), /Everything that was in the old database is in the new one/);
});
test('compare: missing rows, RLS, policies, users and files fail', () => {
  const after = { ...snap, tables: { bookings: 2, profiles: 3 }, rls_enabled: ['profiles'], policies: [], ...authSnap, auth_users: 2, storage_objects: { avatars: 1 } };
  const r = compare({ ...snap, ...authSnap }, after);
  assert.equal(r.ok, false);
  const fails = r.rows.filter((x) => x.estado === 'FAIL').map((x) => x.item);
  assert.ok(fails.includes('rows in bookings'));
  assert.ok(fails.includes('RLS enabled on bookings'));
  assert.ok(fails.includes('policy public.bookings: Read own'));
  assert.ok(fails.includes('auth users'));
  assert.ok(fails.includes('files in bucket avatars'));
});
test('compare: accepts the JSON as copied from the SQL editor (row objects, lists, several values)', () => {
  const pasted = `[{"counts": ${JSON.stringify(JSON.stringify(snap))}}]\n{"auth_counts": ${JSON.stringify(authSnap)}}`;
  const s = parseSnapshot(pasted);
  assert.equal(s.tables.bookings, 3);
  assert.equal(s.auth_users, 3);
  assert.throws(() => parseSnapshot('hello'), /No snapshot found/);
});

// ---------------------------------------------------------------- upload-storage
test('upload: folder layout, new-style keys and a mocked upload', async () => {
  const dir = join(tmp, 'files');
  mkdirSync(join(dir, 'avatars', 'u1'), { recursive: true });
  writeFileSync(join(dir, 'avatars', 'u1', 'photo one.png'), 'x');
  writeFileSync(join(dir, 'avatars', 'Thumbs.db'), 'x');
  const items = listUploads(dir);
  assert.deepEqual(items.map((i) => `${i.bucket}/${i.path}`), ['avatars/u1/photo one.png']);
  assert.deepEqual(authHeaders('sb_secret_abc'), { apikey: 'sb_secret_abc' });
  assert.equal(authHeaders('eyJx').Authorization, 'Bearer eyJx');
  const calls = [];
  const res = await upload(items, { url: 'https://new.example.co/', key: 'k', fetchImpl: async (u, o) => { calls.push({ u, o }); return { ok: true, status: 200, text: async () => '' }; } });
  assert.equal(res[0].ok, true);
  assert.equal(calls[0].u, 'https://new.example.co/storage/v1/object/avatars/u1/photo%20one.png');
  assert.equal(calls[0].o.headers['Content-Type'], 'image/png');
});
test('upload CLI refuses the key as an argument', () => {
  const cli = fileURLToPath(new URL('../upload-storage.mjs', import.meta.url));
  const p = spawnSync(process.execPath, [cli, tmp, '--key', 'secret'], { encoding: 'utf8' });
  assert.equal(p.status, 2);
  assert.match(p.stderr, /Do not pass the key as an argument/);
});
