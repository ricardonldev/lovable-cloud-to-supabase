import { authenticateCronRequest } from "../integrations/supabase/cron-auth";
export async function POST(request: Request) { const denied = await authenticateCronRequest(request); if (denied) return denied; }
