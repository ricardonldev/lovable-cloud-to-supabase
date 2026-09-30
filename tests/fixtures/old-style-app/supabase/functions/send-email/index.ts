const key = Deno.env.get("RESEND_API_KEY");
const url = Deno.env.get("SUPABASE_URL");
const ai = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", { headers: { Authorization: `Bearer ${Deno.env.get("LOVABLE_API_KEY")}` } });
