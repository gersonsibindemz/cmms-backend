import { Pool } from 'pg';

const DATABASE_URL = 'postgresql://postgres.tnrntjfvseyxjxubxitn:moxambique00@aws-0-eu-west-1.pooler.supabase.com:6543/postgres';
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const client = await pool.connect();
  try {
    // Verificar se a constraint já existe
    const check = await client.query(`
      SELECT conname FROM pg_constraint 
      WHERE conname = 'tenant_role_integrity' AND conrelid = 'public.app_users'::regclass
    `);
    
    if (check.rows.length > 0) {
      console.log('Constraint tenant_role_integrity já existe.');
    } else {
      await client.query(`
        ALTER TABLE public.app_users 
        ADD CONSTRAINT tenant_role_integrity CHECK (
          (role = 'super_admin' AND tenant_id IS NULL) OR
          (role <> 'super_admin' AND tenant_id IS NOT NULL)
        );
      `);
      console.log('Constraint tenant_role_integrity criada com sucesso.');
    }
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
})();