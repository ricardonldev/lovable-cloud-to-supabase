-- Private bucket for avatars: each user can only read and write inside their own folder (<user id>/...)
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', false);

CREATE POLICY "Read own avatar" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text);
CREATE POLICY "Upload own avatar" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text);
