#!/usr/bin/env node
// Uploads the storage files downloaded from Lovable Cloud (More → Cloud → Storage) to the new Supabase project,
// keeping their paths so the links stored in your tables keep working.
// Usage:
//   SUPABASE_URL=https://<new-project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<new project secret key> \
//     node upload-storage.mjs <folder> [--bucket name] [--dry-run] [--upsert]
//   Without --bucket, every sub-folder of <folder> is a bucket: <folder>/<bucket>/<path/to/file>
// The key is read from the environment only (never pass it as an argument: it would stay in the shell history).
// The buckets must already exist (they are created by the schema).

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (!/^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name)) out.push(p);
  }
  return out;
}

/** @returns {{bucket: string, path: string, file: string}[]} */
export function listUploads(folder, bucket) {
  const toKey = (f, base) => relative(base, f).split(/[\\/]/).join('/');
  if (bucket) return walk(folder).map((f) => ({ bucket, path: toKey(f, folder), file: f }));
  return readdirSync(folder).filter((b) => statSync(join(folder, b)).isDirectory())
    .flatMap((b) => walk(join(folder, b)).map((f) => ({ bucket: b, path: toKey(f, join(folder, b)), file: f })));
}

export function authHeaders(key) {
  // New Supabase API keys (sb_secret_…) are not JWTs: they go only in the apikey header
  return key.startsWith('sb_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` };
}

export async function upload(items, { url, key, upsert = false, concurrency = 4, fetchImpl = fetch }) {
  const results = [];
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      const target = `${url.replace(/\/$/, '')}/storage/v1/object/${encodeURIComponent(it.bucket)}/${it.path.split('/').map(encodeURIComponent).join('/')}`;
      try {
        const res = await fetchImpl(target, {
          method: 'POST',
          headers: { ...authHeaders(key), 'Content-Type': TYPES[extname(it.file).toLowerCase()] || 'application/octet-stream', 'x-upsert': String(upsert), 'cache-control': 'max-age=3600' },
          body: readFileSync(it.file),
        });
        results.push({ ...it, ok: res.ok, status: res.status, error: res.ok ? null : (await res.text()).slice(0, 200) });
      } catch (e) { results.push({ ...it, ok: false, status: 0, error: e.message }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.includes('--key')) { console.error('Do not pass the key as an argument. Set SUPABASE_SERVICE_ROLE_KEY in the environment.'); process.exit(2); }
  const bi = args.indexOf('--bucket');
  const bucket = bi === -1 ? null : args[bi + 1];
  const folder = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--bucket');
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!folder || !existsSync(folder)) { console.error('Usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node upload-storage.mjs <folder> [--bucket name] [--dry-run] [--upsert]'); process.exit(2); }
  const items = listUploads(folder, bucket);
  const byBucket = items.reduce((m, x) => ((m[x.bucket] = (m[x.bucket] || 0) + 1), m), {});
  console.log(`${items.length} files: ${Object.entries(byBucket).map(([b, n]) => `${b} (${n})`).join(', ') || 'none'}`);
  if (args.includes('--dry-run')) { items.slice(0, 20).forEach((x) => console.log(`  ${x.bucket}/${x.path}`)); process.exit(0); }
  if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (of the NEW project) in the environment.'); process.exit(2); }
  const res = await upload(items, { url, key, upsert: args.includes('--upsert') });
  const bad = res.filter((r) => !r.ok);
  console.log(`Uploaded: ${res.length - bad.length}/${res.length}`);
  for (const b of bad.slice(0, 30)) console.log(`  FAILED ${b.bucket}/${b.path}: ${b.status} ${b.error}`);
  process.exitCode = bad.length ? 1 : 0;
}
