-- runs second (later timestamp)
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('nightly-cleanup', '0 3 * * *', $$ delete from public.notes where created_at < now() - interval '1 year' $$);
ALTER PUBLICATION supabase_realtime ADD TABLE public.notes;
INSERT INTO storage.buckets (id, name, public) VALUES ('invoices', 'invoices', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('logos', 'logos', true);
