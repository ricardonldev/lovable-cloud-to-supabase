-- Made-up bookings app, in the style Lovable generates. Used only to rehearse the migration.

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  full_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
CREATE POLICY "Read own profile" ON public.profiles FOR SELECT TO authenticated USING ((select auth.uid()) = id);
CREATE POLICY "Update own profile" ON public.profiles FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id) WITH CHECK ((select auth.uid()) = id);

-- Runs for every new user. When importing users, it must NOT run again (the profiles come with the data).
CREATE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name) VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', ''));
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TABLE public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  minutes integer NOT NULL CHECK (minutes > 0),
  price_cents integer NOT NULL DEFAULT 0,
  tags text[] NOT NULL DEFAULT '{}',
  details jsonb NOT NULL DEFAULT '{}'
);
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.services TO anon, authenticated;
CREATE POLICY "Services are public" ON public.services FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.services (id),
  starts_at timestamptz NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.bookings TO authenticated;
CREATE POLICY "Read own bookings" ON public.bookings FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
CREATE POLICY "Create own bookings" ON public.bookings FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);

-- Serial ids: after the import the sequence must continue from the last id, not from 1
CREATE TABLE public.audit_log (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
