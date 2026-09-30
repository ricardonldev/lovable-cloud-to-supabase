-- Snapshot of the public schema: rows per table, RLS, policies, functions, triggers and columns.
-- Run it in the SQL editor of the OLD database (Lovable: More → Cloud → Database → SQL) and of the NEW
-- Supabase project. Save each result (one JSON value) as before.json and after.json, then:
--   node compare-counts.mjs before.json after.json
-- It only reads. It does not show any row content, only counts and names.
select json_build_object(
  'tables', coalesce((
    select json_object_agg(t.table_name,
      (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text::bigint
      order by t.table_name)
    from information_schema.tables t
    where t.table_schema = 'public' and t.table_type = 'BASE TABLE'), '{}'::json),
  'columns', coalesce((
    select json_object_agg(table_name, n order by table_name)
    from (select table_name, count(*) as n from information_schema.columns where table_schema = 'public' group by table_name) c), '{}'::json),
  'rls_enabled', coalesce((
    select json_agg(c.relname order by c.relname)
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity), '[]'::json),
  'policies', coalesce((
    select json_agg(schemaname || '.' || tablename || ': ' || policyname order by schemaname, tablename, policyname)
    from pg_policies where schemaname in ('public', 'storage')), '[]'::json),
  'functions', coalesce((
    select json_agg(f order by f) from (
      select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as f
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public') x), '[]'::json),
  'triggers', coalesce((
    select json_agg(t order by t) from (
      select tr.tgrelid::regclass::text || ': ' || tr.tgname as t
      from pg_trigger tr
      join pg_proc p on p.oid = tr.tgfoid
      join pg_namespace s on s.oid = p.pronamespace
      where not tr.tgisinternal and s.nspname = 'public') x), '[]'::json)
) as counts;
