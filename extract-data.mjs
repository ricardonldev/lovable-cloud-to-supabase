#!/usr/bin/env node
// Takes the database export from Lovable Cloud (a plain-SQL pg_dump, optionally .gz) and writes what the new
// Supabase project needs:
//   data mode (default): the rows of your tables + auth.users/auth.identities (with password hashes),
//                        wrapped so triggers do not fire again on import (session_replication_role = replica).
//   schema mode:         the definitions of the public schema (tables, functions, policies, triggers on auth
//                        tables...), for projects whose migrations are missing or no longer match the database.
//
// Usage: node extract-data.mjs <export.sql[.gz]> --out data.sql [--inserts] [--auth-tables users,identities]
//                              [--exclude public.logs,...] [--schemas public]
//        node extract-data.mjs <export.sql[.gz]> --mode schema --out schema-from-export.sql
//   --no-clear do not empty each app table before loading it (by default it does: Lovable's migrations often
//              insert sample rows that would otherwise be duplicated)
//   --inserts  INSERT statements instead of COPY (for the Supabase SQL editor; small databases only).
//              COPY output needs psql: psql "<connection string>" --single-transaction -v ON_ERROR_STOP=1 -f data.sql
//
// Streams the file line by line (exports can be several GB). The output contains personal data: treat it like
// the export itself (encrypted disk, delete it when the migration is verified).

import { createReadStream, createWriteStream, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const unquote = (s) => s.replace(/^"(.*)"$/, '$1').replace(/""/g, '"');
const splitName = (qualified) => {
  const m = qualified.match(/^("(?:[^"]|"")+"|[^.]+)\.("(?:[^"]|"")+"|.+)$/);
  return m ? [unquote(m[1]), unquote(m[2])] : ['public', unquote(qualified)];
};

// COPY text format → SQL literal
function copyValueToSql(v) {
  if (v === '\\N') return 'NULL';
  const s = v.replace(/\\(\d{1,3}|x[0-9a-fA-F]{1,2}|.)/g, (_, c) => {
    if (/^\d/.test(c)) return String.fromCharCode(parseInt(c, 8));
    if (c[0] === 'x' && c.length > 1) return String.fromCharCode(parseInt(c.slice(1), 16));
    return { t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v', '\\': '\\' }[c] ?? c;
  });
  return `'${s.replace(/'/g, "''")}'`;
}

function sniff(file) {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(5);
  readSync(fd, buf, 0, 5, 0);
  closeSync(fd);
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip';
  if (buf.toString('latin1') === 'PGDMP') return 'custom';
  return 'plain';
}

/**
 * @param {string} file
 * @param {{mode?: 'data'|'schema', schemas?: string[], authTables?: string[], exclude?: string[], inserts?: boolean, write: (s: string) => void}} opts
 * @returns {Promise<{kept: {table: string, rows: number}[], skipped: {table: string, rows: number}[], objects: number}>}
 */
export async function extract(file, opts) {
  const kind = sniff(file);
  if (kind === 'custom') {
    throw new Error('This export is in pg_dump custom format. Convert it to plain SQL first, e.g.:\n  docker run --rm -v "$PWD:/w" postgres:17 pg_restore -f /w/export.sql /w/' + file.split(/[\\/]/).pop());
  }
  const mode = opts.mode || 'data';
  const schemas = new Set(opts.schemas || ['public']);
  const authTables = new Set(opts.authTables || ['users', 'identities']);
  const exclude = new Set(opts.exclude || []);
  const w = opts.write;
  // Lovable's migrations often insert sample rows (e.g. a starter list of services). Applying the schema on the
  // new project recreates them, so each app table is emptied right before its rows are loaded; otherwise they
  // end up duplicated (found in the rehearsal with a real Lovable app). Replica mode keeps the DELETE from
  // cascading. Auth tables are never cleared: the new project must have no users, and a clash fails loudly.
  const clearFirst = (schema, target) => (opts.clear !== false && schemas.has(schema) ? `DELETE FROM ${target};\n` : '');
  const wanted = (schema, table) => !exclude.has(`${schema}.${table}`) && (schemas.has(schema) || (schema === 'auth' && authTables.has(table)));

  let input = createReadStream(file);
  if (kind === 'gzip') input = input.pipe(createGunzip());
  const rl = createInterface({ input, crlfDelay: Infinity });

  const kept = [], skipped = [];
  let objects = 0;
  let copy = null; // { table, keep, rows, cols }
  let insert = null; // { keep, text }
  // schema mode: pg_dump writes a "-- Name: x; Type: T; Schema: s; Owner: o" header before each object
  let entry = null; // { keep, lines }
  const flushEntry = () => {
    // On Supabase-managed tables, keep only what the app added (it points to the app's own functions or roles);
    // Supabase's internal triggers already exist on the new project.
    if (entry?.keep && entry.managed && !/\bpublic\.|auth\.uid\(\)|auth\.jwt\(\)|\bTO (authenticated|anon)\b/.test(entry.lines.join('\n'))) entry.keep = false;
    // Buckets are rows of storage.buckets, not definitions: recreate them (skipping any that already exist)
    if (entry?.buckets) {
      const i = entry.lines.findIndex((l) => /^COPY storage\.buckets \(/.test(l));
      if (i !== -1) {
        const cols = entry.lines[i].match(/\((.*)\)/)[1].split(',').map((c) => c.trim().replace(/"/g, ''));
        const keepCols = ['id', 'name', 'public', 'file_size_limit', 'allowed_mime_types'].filter((c) => cols.includes(c));
        for (const row of entry.lines.slice(i + 1)) {
          if (row === '\\.') break;
          const v = row.split('\t');
          w(`INSERT INTO storage.buckets (${keepCols.join(', ')}) VALUES (${keepCols.map((c) => copyValueToSql(v[cols.indexOf(c)])).join(', ')}) ON CONFLICT (id) DO NOTHING;\n`);
          objects++;
        }
      }
      entry = null;
      return;
    }
    if (entry?.keep) { w(entry.lines.join('\n') + '\n'); objects++; }
    entry = null;
  };

  if (mode === 'data') {
    w(`-- Data extracted from ${file.split(/[\\/]/).pop()} by extract-data.mjs\n-- Contains personal data. Import into the NEW project after the schema, then delete this file.\nSET session_replication_role = replica;\nSET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n`);
    if (opts.inserts) w('BEGIN;\n');
  } else {
    w(`-- Schema extracted from ${file.split(/[\\/]/).pop()} by extract-data.mjs (schemas: ${[...schemas].join(', ')})\n-- Run on an EMPTY Supabase project before importing data.\nSET check_function_bodies = false;\nSET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n`);
  }

  for await (const line of rl) {
    if (mode === 'schema') {
      const h = line.match(/^-- (?:Data for )?Name: (.*); Type: ([A-Z ]+); Schema: ([^;]+); Owner:/);
      if (h) {
        flushEntry();
        const [, name, type, schema] = h;
        let keep = false, managed = false;
        // DEFAULT ACL: Supabase already sets these on every new project, and only its admin role may change them
        if (type === 'TABLE DATA' || type === 'SEQUENCE SET' || type === 'DEFAULT ACL') keep = false;
        else if (schemas.has(schema) && type !== 'SCHEMA') keep = true;
        // custom triggers and policies that the app adds on Supabase-managed tables (auth.users, storage.objects)
        else if ((schema === 'auth' || schema === 'storage') && (type === 'TRIGGER' || type === 'POLICY')) { keep = true; managed = true; }
        else if (type === 'EXTENSION') keep = true;
        entry = { keep, managed, buckets: type === 'TABLE DATA' && schema === 'storage' && name === 'buckets', lines: [] };
        continue;
      }
      if (entry) {
        if (/^CREATE EXTENSION /.test(line)) entry.lines.push(line.replace(/^CREATE EXTENSION (?!IF NOT EXISTS)/, 'CREATE EXTENSION IF NOT EXISTS '));
        else entry.lines.push(line);
      }
      continue;
    }

    // ---- data mode
    if (copy) {
      if (line === '\\.') {
        (copy.keep ? kept : skipped).push({ table: copy.table, rows: copy.rows });
        if (copy.keep && !opts.inserts) w('\\.\n');
        copy = null;
        continue;
      }
      copy.rows++;
      if (copy.keep) {
        if (opts.inserts) w(`INSERT INTO ${copy.target} (${copy.cols}) VALUES (${line.split('\t').map(copyValueToSql).join(', ')});\n`);
        else w(line + '\n');
      }
      continue;
    }
    if (insert) {
      insert.text += '\n' + line;
      if (/;\s*$/.test(line) && (insert.text.match(/'/g) || []).length % 2 === 0) { if (insert.keep) w(insert.text + '\n'); insert = null; }
      continue;
    }
    const c = line.match(/^COPY (\S+) \((.*)\) FROM stdin;$/);
    if (c) {
      const [schema, table] = splitName(c[1]);
      const keep = wanted(schema, table);
      copy = { table: `${schema}.${table}`, target: c[1], cols: c[2], keep, rows: 0 };
      if (keep) w(`\n-- ${schema}.${table}\n${clearFirst(schema, c[1])}${opts.inserts ? '' : `${line}\n`}`);
      continue;
    }
    const ins = line.match(/^INSERT INTO (\S+)/);
    if (ins) {
      const [schema, table] = splitName(ins[1]);
      const keep = wanted(schema, table);
      const t = `${schema}.${table}`;
      const bucket = (keep ? kept : skipped);
      const row = bucket.find((x) => x.table === t) || (bucket.push({ table: t, rows: 0 }), bucket[bucket.length - 1]);
      row.rows++;
      if (keep && row.rows === 1) w(clearFirst(schema, ins[1]));
      insert = { keep, text: line };
      if (/;\s*$/.test(line) && (line.match(/'/g) || []).length % 2 === 0) { if (keep) w(line + '\n'); insert = null; }
      continue;
    }
    const sv = line.match(/^SELECT pg_catalog\.setval\('([^']+)'/);
    if (sv) {
      const [schema] = splitName(sv[1]);
      if (schemas.has(schema)) w(line + '\n');
    }
  }
  if (mode === 'schema') flushEntry();
  else { if (opts.inserts) w('COMMIT;\n'); w('SET session_replication_role = origin;\n'); }
  return { kept, skipped, objects };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const val = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
  const valued = ['--out', '--mode', '--auth-tables', '--exclude', '--schemas'];
  const file = args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
  const out = val('--out');
  if (!file || !existsSync(file) || !out) {
    console.error('Usage: node extract-data.mjs <export.sql[.gz]> --out data.sql [--inserts] [--auth-tables users,identities] [--exclude schema.table,...] [--schemas public]\n       node extract-data.mjs <export.sql[.gz]> --mode schema --out schema.sql');
    process.exit(2);
  }
  const list = (f) => (val(f) ? val(f).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  const ws = createWriteStream(out);
  try {
    const r = await extract(file, { mode: val('--mode') || 'data', inserts: args.includes('--inserts'), clear: !args.includes('--no-clear'), schemas: list('--schemas'), authTables: list('--auth-tables'), exclude: list('--exclude'), write: (s) => ws.write(s) });
    await new Promise((res) => ws.end(res));
    if ((val('--mode') || 'data') === 'schema') console.log(`${r.objects} objects written to ${out}`);
    else {
      console.log(`Written to ${out}\n\nIncluded:`);
      for (const t of r.kept) console.log(`  ${t.table}: ${t.rows} rows`);
      const other = r.skipped.filter((t) => t.rows > 0);
      if (other.length) { console.log('\nLeft out (not needed or recreated by Supabase):'); for (const t of other) console.log(`  ${t.table}: ${t.rows} rows`); }
    }
  } catch (e) { ws.destroy(); console.error(e.message); process.exit(1); }
}
