import { Router } from 'express';
import bcrypt from 'bcrypt';
import { withTenantContext } from '../db.js';
import { authenticateToken, requireRole } from '../middlewares/auth.js';

const router = Router();
const OPERATIONAL_SCOPES = new Set(['fleet', 'plant', 'mixed']);
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

router.use(authenticateToken, requireRole(['super_admin']));

router.get('/tenants', async (req, res, next) => {
  try {
    const result = await withTenantContext(null, 'super_admin', (client) =>
      client.query(
        `SELECT tenants.id, tenants.name, tenants.trade_name, tenants.nuit,
                tenants.province, tenants.is_active, tenants.max_assets_limit,
                tenants.max_users_limit, tenants.operational_scope,
                tenants.default_operational_scope,
                (SELECT COUNT(*)::int
                 FROM public.assets
                 WHERE tenant_id = tenants.id
                   AND deleted_at IS NULL
                   AND status <> 'decommissioned') AS total_assets,
                (SELECT COUNT(*)::int
                 FROM public.app_users
                 WHERE tenant_id = tenants.id) AS total_users
         FROM public.tenants
         ORDER BY tenants.name`,
      ),
    );

    return res.json({ tenants: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/tenants', async (req, res, next) => {
  const {
    tenantName,
    tradeName,
    nuit,
    province,
    maxAssetsLimit,
    maxUsersLimit,
    operationalScope = 'fleet',
    defaultOperationalScope,
    adminFullName,
    adminEmail,
    adminPassword,
    adminPhone,
  } = req.body ?? {};
  const tenantDefaultScope = defaultOperationalScope
    ?? (operationalScope === 'plant' ? 'plant' : 'fleet');

  if (
    [tenantName, tradeName, nuit, province, adminFullName, adminEmail, adminPassword, adminPhone]
      .some((value) => typeof value !== 'string' || !value.trim()) ||
    !Number.isInteger(maxAssetsLimit) ||
    maxAssetsLimit < 0 ||
    !Number.isInteger(maxUsersLimit) ||
    maxUsersLimit < 1 ||
    !OPERATIONAL_SCOPES.has(operationalScope) ||
    !['fleet', 'plant'].includes(tenantDefaultScope) ||
    (operationalScope !== 'mixed' && tenantDefaultScope !== operationalScope) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail.trim())
  ) {
    return res.status(400).json({ error: 'Dados da empresa ou do administrador inválidos.' });
  }

  try {
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const result = await withTenantContext(null, 'super_admin', async (client) => {
      const tenantResult = await client.query(
        `INSERT INTO public.tenants (
           name, trade_name, nuit, province, max_assets_limit, max_users_limit,
           operational_scope, default_operational_scope
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, trade_name, nuit, province, is_active,
                   max_assets_limit, max_users_limit, operational_scope,
                   default_operational_scope`,
        [
          tenantName.trim(),
          tradeName.trim(),
          nuit.trim(),
          province.trim(),
          maxAssetsLimit,
          maxUsersLimit,
          operationalScope,
          tenantDefaultScope,
        ],
      );
      const tenant = tenantResult.rows[0];

      const adminResult = await client.query(
        `INSERT INTO public.app_users (
           tenant_id, email, password_hash, full_name, phone, role
         )
         VALUES ($1::uuid, $2, $3, $4, $5, $6::public.user_role)
         RETURNING id, tenant_id, email, full_name, phone, role, is_active`,
        [
          tenant.id,
          adminEmail.trim().toLowerCase(),
          passwordHash,
          adminFullName.trim(),
          adminPhone.trim(),
          'tenant_admin',
        ],
      );
      return { tenant, admin: adminResult.rows[0] };
    });

    return res.status(201).json(result);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'NUIT ou email já cadastrado.' });
    }
    return next(error);
  }
});

router.patch('/tenants/:id/status', async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador do tenant inválido.' });
  }
  const requestedStatus = req.body?.is_active
    ?? req.body?.isActive
    ?? (req.body?.status === 'active' ? true : req.body?.status === 'suspended' ? false : undefined);
  if (typeof requestedStatus !== 'boolean') {
    return res.status(400).json({ error: 'O estado deve ser ativo ou suspenso.' });
  }

  try {
    const result = await withTenantContext(null, 'super_admin', (client) =>
      client.query(
        `UPDATE public.tenants
         SET is_active = $1
         WHERE id = $2::uuid
         RETURNING id, name, is_active`,
        [requestedStatus, req.params.id],
      ),
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Tenant não encontrado.' });
    }
    return res.json({ tenant: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

export default router;
