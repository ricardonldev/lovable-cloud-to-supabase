#!/usr/bin/env node
// Compares the snapshots taken with counts.sql / counts-auth.sql on the old and the new database.
// Usage: node compare-counts.mjs before.json after.json [--out report.md]
// Exit code 1 if something is missing on the new project (rows, users, files, RLS, policies, functions, triggers).
// Accepts the JSON as copied from the SQL editor: the bare value, a row object ({"counts": {...}}) or a list of rows.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Pulls every snapshot object out of whatever the SQL editor gave us and merges them. */
export function parseSnapshot(text) {
  const values = [];
  const tryParse = (s) => { try { values.push(JSON.parse(s)); return true; } catch { return false; } };
  if (!tryParse(text.trim())) {
    for (const chunk of text.split(/\r?\n(?=\s*[[{"])/)) if (chunk.trim()) tryParse(chunk.trim());
  }
  const out = {};
  const visit = (v) => {
    if (typeof v === 'string' && /^\s*[{[]/.test(v)) { try { return visit(JSON.parse(v)); } catch { return; } }
    if (Array.isArray(v)) return v.forEach(visit);
    if (v && typeof v === 'object') {
      if ('tables' in v || 'auth_users' in v) return Object.assign(out, v);
      Object.values(v).forEach(visit);
    }
  };
  values.forEach(visit);
  if (!Object.keys(out).length) throw new Error('No snapshot found (expected the JSON returned by counts.sql or counts-auth.sql)');
  return out;
}

/** @returns {{ok: boolean, rows: {estado: 'OK'|'FAIL'|'WARN', item: string, before: any, after: any}[]}} */
export function compare(before, after) {
  const rows = [];
  const add = (estado, item, b, a) => rows.push({ estado, item, before: b, after: a });
  if (before.tables) {
    for (const [t, n] of Object.entries(before.tables)) {
      const m = after.tables?.[t];
      if (m === undefined) add('FAIL', `table ${t}`, n, 'missing');
      else add(Number(m) === Number(n) ? 'OK' : 'FAIL', `rows in ${t}`, n, m);
    }
    for (const t of Object.keys(after.tables || {})) if (!(t in before.tables)) add('WARN', `table ${t} only in the new project`, '—', after.tables[t]);
  }
  for (const [t, n] of Object.entries(before.columns || {})) {
    const m = after.columns?.[t];
    if (m !== undefined && Number(m) !== Number(n)) add('WARN', `columns in ${t}`, n, m);
  }
  const lists = [['rls_enabled', 'RLS enabled on'], ['policies', 'policy'], ['functions', 'function'], ['triggers', 'trigger'], ['storage_buckets', 'bucket']];
  for (const [key, label] of lists) {
    if (!before[key]) continue;
    const a = new Set(after[key] || []);
    const missing = before[key].filter((x) => !a.has(x));
    if (missing.length) missing.forEach((x) => add('FAIL', `${label} ${x}`, 'yes', 'missing'));
    else add('OK', `${label}: all ${before[key].length} present`, before[key].length, (after[key] || []).length);
    const extra = (after[key] || []).filter((x) => !before[key].includes(x));
    extra.forEach((x) => add('WARN', `${label} ${x} only in the new project`, '—', 'yes'));
  }
  for (const key of ['auth_users', 'auth_users_confirmed', 'auth_users_with_password', 'auth_identities']) {
    if (before[key] === undefined) continue;
    add(Number(after[key]) === Number(before[key]) ? 'OK' : 'FAIL', key.replace(/_/g, ' '), before[key], after[key] ?? 'missing');
  }
  for (const [p, n] of Object.entries(before.identities_by_provider || {})) {
    const m = after.identities_by_provider?.[p];
    add(Number(m) === Number(n) ? 'OK' : 'FAIL', `identities (${p})`, n, m ?? 0);
  }
  for (const [b, n] of Object.entries(before.storage_objects || {})) {
    const m = after.storage_objects?.[b] ?? 0;
    add(Number(m) >= Number(n) ? 'OK' : 'FAIL', `files in bucket ${b}`, n, m);
  }
  return { ok: !rows.some((r) => r.estado === 'FAIL'), rows };
}

export function report(r) {
  const icon = { OK: '✅', FAIL: '❌', WARN: '⚠️' };
  const fails = r.rows.filter((x) => x.estado === 'FAIL').length;
  let md = `# Migration check\n\n**${r.ok ? 'Everything that was in the old database is in the new one.' : `${fails} item(s) missing or different in the new project.`}**\n\n| | Item | Before | After |\n|---|---|---|---|\n`;
  const order = { FAIL: 0, WARN: 1, OK: 2 };
  for (const x of [...r.rows].sort((a, b) => order[a.estado] - order[b.estado])) md += `| ${icon[x.estado]} | ${x.item} | ${x.before} | ${x.after} |\n`;
  return md;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  if (files.length !== 2) { console.error('Usage: node compare-counts.mjs before.json after.json [--out report.md]'); process.exit(2); }
  let r;
  try { r = compare(parseSnapshot(readFileSync(files[0], 'utf8')), parseSnapshot(readFileSync(files[1], 'utf8'))); } catch (e) { console.error(e.message); process.exit(2); }
  const md = report(r);
  const oi = args.indexOf('--out');
  if (oi !== -1) writeFileSync(args[oi + 1], md);
  process.stdout.write(md);
  process.exitCode = r.ok ? 0 : 1;
}
