import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function withTenantContext(tenantId, userRole, callback) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.current_tenant', $1, true), set_config('app.current_user_role', $2, true)",
      [tenantId ?? '', userRole],
    );

    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}