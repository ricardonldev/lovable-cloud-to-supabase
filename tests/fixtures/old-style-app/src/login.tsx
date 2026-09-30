import { lovable } from "./integrations/lovable";
import { supabase } from "./client";
export const google = () => lovable.auth.signInWithOAuth("google");
export const apple = () => supabase.auth.signInWithOAuth({ provider: 'apple' });
export const magic = (email: string) => supabase.auth.signInWithOtp({ email });
