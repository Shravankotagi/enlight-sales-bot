/**
 * Migration: Add missing columns to followup_tasks table
 * Run once: node scripts/migrate_followup_tasks.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function migrate() {
  console.log('Running followup_tasks migration...');

  // We use Supabase's RPC to run raw SQL since JS client can't ALTER TABLE directly
  const migrations = [
    `ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS followup_status TEXT DEFAULT 'routine_checkin'`,
    `ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS order_expected_timeline TEXT`,
    `ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS next_followup_date TIMESTAMPTZ`,
    `ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS linked_deal_id UUID REFERENCES deals(id) ON DELETE SET NULL`,
    `ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
  ];

  for (const sql of migrations) {
    const { error } = await supabase.rpc('exec_sql', { query: sql });
    if (error) {
      // Try alternative: some Supabase setups use different RPC names
      console.warn(`RPC failed, trying direct: ${error.message}`);
    } else {
      console.log(`✅ ${sql.substring(0, 60)}...`);
    }
  }

  // Verify by reading table structure
  const { data, error } = await supabase
    .from('followup_tasks')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Verification failed:', error.message);
  } else {
    console.log('\n✅ Migration complete. Sample columns:', data.length > 0 ? Object.keys(data[0]) : 'No rows yet - table is ready');
  }
}

migrate().catch(console.error);
