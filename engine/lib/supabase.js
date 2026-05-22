/**
 * Supabase client for the server-side trading engine.
 * Uses environment variables (without VITE_ prefix).
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('✖ SUPABASE_URL or SUPABASE_ANON_KEY is missing. Engine cannot start.');
  process.exit(1);
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
