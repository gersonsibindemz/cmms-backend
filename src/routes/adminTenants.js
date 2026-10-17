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
                tenants.province, tenants.is_active, tenants.suspension_reason, tenants.status,
                tenants.max_assets_limit,
                tenants.max_users_limit, tenants.operational_scope,
                tenants.default_operational_scope,
                tenants.country, tenants.currency,
                (SELECT COUNT(*)::int
                 FROM public.assets
                 WHERE tenant_id = tenants.id
                   AND deleted_at IS NULL
                   AND status <> 'decommissioned') AS total_assets,
                (SELECT COUNT(*)::int
                 FROM public.app_users
                 WHERE tenant_id = tenants.id) AS total_users
         FROM public.tenants
         ORDER BY tenants.created_at DESC`,
      ),
    );

    return res.json({ tenants: result.rows });
  } catch (error) {
    return next(error);
  }
});

export async function createTenantHandler(req, res, next) {
  const {
    tenantName,
    tradeName,
    nuit,
    province,
    maxAssetsLimit,
    maxUsersLimit = 50,
    operationalScope = 'fleet',
    defaultOperationalScope,
    country = 'Moçambique',
    currency = 'MZN',
    adminFullName,
    adminEmail,
    adminPassword,
    adminPhone,
  } = req.body ?? {};
  const tenantDefaultScope = defaultOperationalScope
    ?? (operationalScope === 'plant' ? 'plant' : 'fleet');
  const adminOperationalScope = operationalScope === 'mixed'
    ? tenantDefaultScope
    : operationalScope;

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
    typeof country !== 'string' ||
    !country.trim() ||
    country.trim().length > 100 ||
    typeof currency !== 'string' ||
    !/^[A-Za-z]{3}$/.test(currency.trim()) ||
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
           operational_scope, default_operational_scope, country, currency
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, name, trade_name, nuit, province, is_active,
                   max_assets_limit, max_users_limit, operational_scope,
                   default_operational_scope, country, currency`,
        [
          tenantName.trim(),
          tradeName.trim(),
          nuit.trim(),
          province.trim(),
          maxAssetsLimit,
          maxUsersLimit,
          operationalScope,
          tenantDefaultScope,
          country.trim(),
          currency.trim().toUpperCase(),
        ],
      );
      const tenant = tenantResult.rows[0];

      const adminResult = await client.query(
        `INSERT INTO public.app_users (
           tenant_id, email, password_hash, full_name, phone, role, operational_scope
         )
         VALUES ($1::uuid, $2, $3, $4, $5, $6::public.user_role, $7)
         RETURNING id, tenant_id, email, full_name, phone, role,
                   operational_scope, is_active`,
        [
          tenant.id,
          adminEmail.trim().toLowerCase(),
          passwordHash,
          adminFullName.trim(),
          adminPhone.trim(),
          'tenant_admin',
          adminOperationalScope,
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
}

router.post('/tenants', createTenantHandler);

router.put('/tenants/:id', async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador do tenant inválido.' });
  }

  const {
    name,
    tradeName,
    nuit,
    province,
    maxAssetsLimit,
    maxUsersLimit,
    operationalScope,
    defaultOperationalScope,
    country,
    currency,
  } = req.body ?? {};

  if (operationalScope != null && !OPERATIONAL_SCOPES.has(operationalScope)) {
    return res.status(400).json({ error: 'Escopo operacional inválido.' });
  }
  if (
    (country != null && (
      typeof country !== 'string' || !country.trim() || country.trim().length > 100
    )) ||
    (currency != null && (
      typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())
    ))
  ) {
    return res.status(400).json({ error: 'País ou moeda inválidos.' });
  }

  try {
    const result = await withTenantContext(null, 'super_admin', (client) =>
      client.query(
        `UPDATE public.tenants
         SET name = COALESCE($1, name),
             trade_name = COALESCE($2, trade_name),
             nuit = COALESCE($3, nuit),
             province = COALESCE($4, province),
             max_assets_limit = COALESCE($5, max_assets_limit),
             max_users_limit = COALESCE($6, max_users_limit),
             operational_scope = COALESCE($7, operational_scope),
             default_operational_scope = COALESCE($8, default_operational_scope),
             country = COALESCE($9, country),
             currency = COALESCE($10, currency),
             updated_at = NOW()
         WHERE id = $11::uuid
         RETURNING *`,
        [
          name,
          tradeName,
          nuit,
          province,
          maxAssetsLimit,
          maxUsersLimit,
          operationalScope,
          defaultOperationalScope,
          country?.trim(),
          currency?.trim().toUpperCase(),
          req.params.id,
        ],
      ),
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Tenant não encontrado.' });
    }
    return res.status(200).json({ success: true, tenant: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.delete('/tenants/:id', async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador do tenant inválido.' });
  }

  try {
    const archived = await withTenantContext(null, 'super_admin', async (client) => {
      const result = await client.query(
        `UPDATE public.tenants
         SET is_active = false,
             status = 'cancelled',
             updated_at = NOW()
         WHERE id = $1::uuid
         RETURNING id, name, is_active`,
        [req.params.id],
      );
      if (result.rowCount === 0) return false;

      await client.query(
        `UPDATE public.app_users
         SET is_active = false,
             deleted_at = NOW()
         WHERE tenant_id = $1::uuid`,
        [req.params.id],
      );
      return true;
    });
    if (!archived) {
      return res.status(404).json({ error: 'Tenant não encontrado.' });
    }
    return res.status(200).json({
      success: true,
      message: 'Empresa arquivada e contratos revogados com sucesso.',
    });
  } catch (error) {
    return next(error);
  }
});

export async function toggleTenantStatusHandler(req, res, next) {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador do tenant inválido.' });
  }
  const requestedStatus = req.body?.is_active
    ?? req.body?.isActive
    ?? (req.body?.status === 'active' ? true : req.body?.status === 'suspended' ? false : undefined);
  const requestedReason = req.body?.suspension_reason ?? req.body?.reason;
  if (
    (requestedStatus !== undefined && typeof requestedStatus !== 'boolean')
    || (req.body?.status !== undefined
      && !['active', 'suspended'].includes(req.body.status))
    || (requestedStatus === undefined && !req.path.endsWith('/toggle-status'))
    || (requestedReason !== undefined
      && requestedReason !== null
      && (typeof requestedReason !== 'string' || requestedReason.trim().length > 5000))
  ) {
    return res.status(400).json({ error: 'O estado ou a justificativa de suspensão são inválidos.' });
  }

  try {
    const tenant = await withTenantContext(null, 'super_admin', async (client) => {
      const currentResult = await client.query(
        `SELECT is_active
         FROM public.tenants
         WHERE id = $1::uuid
         FOR UPDATE`,
        [req.params.id],
      );
      const current = currentResult.rows[0];
      if (!current) return null;

      const isActive = requestedStatus ?? !current.is_active;
      const suspensionReason = isActive ? null : requestedReason?.trim();
      if (!isActive && !suspensionReason) return { missingReason: true };

      const result = await client.query(
        `UPDATE public.tenants
         SET is_active = $1,
             suspension_reason = $2,
             updated_at = NOW()
         WHERE id = $3::uuid
         RETURNING id, name, is_active, suspension_reason`,
        [isActive, suspensionReason, req.params.id],
      );
      return result.rows[0];
    });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant não encontrado.' });
    }
    if (tenant.missingReason) {
      return res.status(400).json({ error: 'A justificativa é obrigatória para suspender a empresa.' });
    }
    return res.json({ tenant });
  } catch (error) {
    return next(error);
  }
}

router.patch('/tenants/:id/status', toggleTenantStatusHandler);
router.patch('/tenants/:id/toggle-status', toggleTenantStatusHandler);

export default router;
