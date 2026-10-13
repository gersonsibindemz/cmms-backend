import { Router } from 'express';
import { withTenantContext } from '../db.js';
import { authenticateToken, requireRoles } from '../middlewares/auth.js';
import { createTenantHandler } from './adminTenants.js';

const router = Router();

router.use(authenticateToken, requireRoles('super_admin'));

router.post('/tenants', createTenantHandler);

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