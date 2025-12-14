import type { Database } from '../types/database';
import { getSupabaseClient } from '../../shared/supabase-config';

// Use centralized shared configuration for Supabase
export const supabase = getSupabaseClient() as any as import('@supabase/supabase-js').SupabaseClient<Database>;

// Optional: simple connection test (can be invoked manually during diagnostics)
export const testSupabaseConnection = async (): Promise<boolean> => {
  try {
    const { error } = await supabase.from('menu_categories').select('id').limit(1);
    if (error) {
      console.error('Supabase connection test failed:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Supabase connection test error:', error);
    return false;
  }
};
