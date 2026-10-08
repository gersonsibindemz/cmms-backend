import { Router } from 'express';
import bcrypt from 'bcrypt';
import { pool, withTenantContext } from '../db.js';
import { authenticateToken, requireRoles } from '../middlewares/auth.js';

const router = Router();

router.use(authenticateToken, requireRoles('super_admin'));

router.post('/tenants', async (req, res, next) => {
  const {
    tenantName,
    tradeName,
    nuit,
    province,
    maxAssetsLimit,
    adminFullName,
    adminEmail,
    adminPassword,
    adminPhone,
  } = req.body ?? {};

  if (
    [tenantName, tradeName, nuit, province, adminFullName, adminEmail, adminPassword, adminPhone]
      .some((value) => typeof value !== 'string' || !value.trim()) ||
    !Number.isInteger(maxAssetsLimit) ||
    maxAssetsLimit < 0
  ) {
    return res.status(400).json({ message: 'Dados da empresa ou do administrador inválidos.' });
  }

  let client;

  try {
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.current_tenant', $1, true), set_config('app.current_user_role', $2, true)",
      ['', 'super_admin'],
    );

    const tenantResult = await client.query(
      `INSERT INTO tenants (name, trade_name, nuit, province, max_assets_limit)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, trade_name, nuit, province, is_active, max_assets_limit`,
      [tenantName.trim(), tradeName.trim(), nuit.trim(), province.trim(), maxAssetsLimit],
    );
    const tenant = tenantResult.rows[0];

    const adminResult = await client.query(
      `INSERT INTO app_users (tenant_id, email, password_hash, full_name, phone, role)
       VALUES ($1, $2, $3, $4, $5, 'tenant_admin')
       RETURNING id, tenant_id, email, full_name, phone, role, is_active`,
      [
        tenant.id,
        adminEmail.trim().toLowerCase(),
        passwordHash,
        adminFullName.trim(),
        adminPhone.trim(),
      ],
    );

    await client.query('COMMIT');
    return res.status(201).json({ tenant, admin: adminResult.rows[0] });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {}
    }

    if (error.code === '23505') {
      return res.status(400).json({ message: 'NUIT ou email já cadastrado.' });
    }

    return next(error);
  } finally {
    client?.release();
  }
});

router.get('/tenants', async (req, res, next) => {
  try {
    const result = await withTenantContext(null, 'super_admin', (client) =>
      client.query(
        `SELECT
           t.id,
           t.name,
           t.trade_name,
           t.nuit,
           t.province,
           t.is_active,
           t.max_assets_limit,
           (SELECT COUNT(*)::int FROM assets AS a WHERE a.tenant_id = t.id) AS total_assets,
           (SELECT COUNT(*)::int FROM app_users AS u WHERE u.tenant_id = t.id) AS total_users
         FROM tenants AS t
         ORDER BY t.name`,
      ),
    );

    return res.json({ tenants: result.rows });
  } catch (error) {
    return next(error);
  }
});

export default router;