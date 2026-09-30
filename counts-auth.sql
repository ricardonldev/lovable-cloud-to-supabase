-- Users and storage snapshot. Run it next to counts.sql on the OLD and the NEW database and add its result
-- to the same before.json / after.json file (one JSON value per line is fine).
-- Only counts: no emails, no names, no file names.
select json_build_object(
  'auth_users', (select count(*) from auth.users),
  'auth_users_confirmed', (select count(*) from auth.users where email_confirmed_at is not null),
  'auth_users_with_password', (select count(*) from auth.users where encrypted_password is not null and encrypted_password <> ''),
  'auth_identities', (select count(*) from auth.identities),
  'identities_by_provider', coalesce((select json_object_agg(provider, n order by provider) from (select provider, count(*) as n from auth.identities group by provider) x), '{}'::json),
  'storage_buckets', coalesce((select json_agg(id order by id) from storage.buckets), '[]'::json),
  'storage_objects', coalesce((select json_object_agg(bucket_id, n order by bucket_id) from (select bucket_id, count(*) as n from storage.objects group by bucket_id) x), '{}'::json)
) as auth_counts;
