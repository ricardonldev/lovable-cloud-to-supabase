-- runs first
CREATE TABLE public.notes (id bigserial primary key, body text, created_at timestamptz default now());
CREATE FUNCTION public.on_signup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ BEGIN RETURN NEW; END; $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.on_signup();
SELECT vault.create_secret('x', 'y');
