/**
 * Supabase client for the server-side trading engine.
 * Uses environment variables (without VITE_ prefix).
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
// Prefer the service_role key: it is required to decrypt live Delta credentials
// (get_delta_credentials_decrypted is granted to service_role only) and it also
// satisfies the existing RLS on accounts/positions. Falls back to the anon key
// for backward compatibility, in which case live credential loading will fail
// (and live trading stays safely disabled) but paper trading keeps working.
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseKey = supabaseServiceKey || supabaseAnonKey;

if (!supabaseUrl || !supabaseKey) {
  console.error('✖ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY is missing. Engine cannot start.');
  process.exit(1);
}

// True when the engine can decrypt live credentials. When false, live trading
// is disabled regardless of per-account arming.
export const hasServiceRole = !!supabaseServiceKey;

if (!hasServiceRole) {
  console.warn('⚠ SUPABASE_SERVICE_ROLE_KEY not set — live Delta trading will be disabled (paper trading unaffected).');
}

export const supabase = createClient(supabaseUrl, supabaseKey);
