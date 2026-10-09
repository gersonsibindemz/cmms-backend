import { Router } from 'express';
import bcrypt from 'bcrypt';
import { withTenantContext } from '../db.js';
import {
  authenticateToken,
  checkTenantLimits,
  enforceDomainScope,
  requireRole,
} from '../middlewares/auth.js';

const router = Router();
const USER_ROLES = new Set(['supervisor', 'technician', 'driver_operator']);
const OPERATIONAL_SCOPES = new Set(['fleet', 'plant']);
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

router.use(
  authenticateToken,
  requireRole(['tenant_admin']),
  enforceDomainScope,
);

router.get('/', async (req, res, next) => {
  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT id, tenant_id, email, full_name AS name, role, operational_scope,
                is_active, created_at
         FROM public.app_users
         WHERE tenant_id = $1::uuid
         ORDER BY full_name ASC`,
        [req.user.tenantId],
      ),
    );
    return res.json({ users: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/', checkTenantLimits('users'), async (req, res, next) => {
  const { name, email, password, role, operationalScope } = req.body ?? {};
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 255 ||
    typeof email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
    typeof password !== 'string' ||
    password.length < 8 ||
    !USER_ROLES.has(role) ||
    (operationalScope !== undefined && !OPERATIONAL_SCOPES.has(operationalScope))
  ) {
    return res.status(400).json({ error: 'Dados do utilizador inválidos.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const tenantResult = await client.query(
        `SELECT operational_scope
         FROM public.tenants
         WHERE id = $1::uuid`,
        [req.user.tenantId],
      );
      const tenantScope = tenantResult.rows[0]?.operational_scope;
      if (!tenantScope) return { tenantNotFound: true };

      const userScope = operationalScope ?? req.userScope ?? (
        tenantScope === 'mixed' ? null : tenantScope
      );
      if (
        !userScope ||
        !OPERATIONAL_SCOPES.has(userScope) ||
        (tenantScope !== 'mixed' && userScope !== tenantScope)
      ) {
        return { invalidScope: true };
      }

      const userResult = await client.query(
        `INSERT INTO public.app_users (
           tenant_id, email, password_hash, full_name, role, operational_scope
         )
         VALUES ($1::uuid, $2, $3, $4, $5::public.user_role, $6)
         RETURNING id, tenant_id, email, full_name AS name, role,
                   operational_scope, is_active, created_at`,
        [
          req.user.tenantId,
          email.trim().toLowerCase(),
          passwordHash,
          name.trim(),
          role,
          userScope,
        ],
      );
      const user = userResult.rows[0];

      if (role === 'technician') {
        await client.query(
          `INSERT INTO public.technicians (
             tenant_id, user_id, name, email, domain
           )
           VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
          [req.user.tenantId, user.id, name.trim(), email.trim().toLowerCase(), userScope],
        );
      }

      return { user };
    });

    if (outcome.tenantNotFound) {
      return res.status(404).json({ error: 'Tenant não encontrado.' });
    }
    if (outcome.invalidScope) {
      return res.status(400).json({ error: 'Escopo operacional inválido para este tenant.' });
    }
    return res.status(201).json({ user: outcome.user });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Já existe um utilizador com este email neste tenant.' });
    }
    return next(error);
  }
});

router.patch('/:id/toggle-status', async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador do utilizador inválido.' });
  }
  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `UPDATE public.app_users
         SET is_active = NOT is_active
         WHERE id = $1::uuid
           AND tenant_id = $2::uuid
         RETURNING id, tenant_id, email, full_name AS name, role,
                   operational_scope, is_active`,
        [req.params.id, req.user.tenantId],
      ),
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Utilizador não encontrado neste tenant.' });
    }
    return res.json({ user: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

export default router;
