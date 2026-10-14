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
  const tenantId = req.user?.tenantId || req.user?.tenant_id;
  const userRole = req.user?.role;
  const scope = req.userScope || req.user?.operational_scope;

  if (!tenantId) {
    return res.status(401).json({ error: 'Sessão inválida: tenant_id não identificado.' });
  }

  try {
    let queryText = `
      SELECT
        id,
        tenant_id,
        email,
        full_name,
        phone,
        role,
        operational_scope,
        is_active,
        created_at,
        last_login_at
      FROM public.app_users
      WHERE tenant_id = $1::uuid
        AND is_active = true
        AND deleted_at IS NULL
    `;
    const queryParams = [tenantId];

    if (scope && userRole !== 'super_admin') {
      queryParams.push(scope);
      queryText += ` AND (operational_scope = $${queryParams.length} OR operational_scope IS NULL)`;
    }

    queryText += ' ORDER BY created_at DESC;';

    const result = await withTenantContext(tenantId, userRole, async (client) => {
      return client.query(queryText, queryParams);
    });
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/', checkTenantLimits('users'), async (req, res, next) => {
  const { name, email, password, role, operational_scope: operationalScope } = req.body ?? {};
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 255 ||
    typeof email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
    typeof password !== 'string' ||
    password.length < 8 ||
    !USER_ROLES.has(role) ||
    !OPERATIONAL_SCOPES.has(operationalScope)
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

      const userScope = operationalScope;
      if (
        !userScope ||
        !OPERATIONAL_SCOPES.has(userScope) ||
        userScope !== req.userScope ||
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

async function updateUser(req, res, next) {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador do utilizador inválido.' });
  }

  const {
    name,
    email,
    role,
    operational_scope: operationalScope,
    password,
  } = req.body ?? {};
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 255 ||
    typeof email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
    !USER_ROLES.has(role) ||
    !OPERATIONAL_SCOPES.has(operationalScope) ||
    operationalScope !== req.userScope ||
    (password !== undefined && (typeof password !== 'string' || password.length < 8))
  ) {
    return res.status(400).json({ error: 'Dados do utilizador inválidos.' });
  }

  try {
    const passwordHash = password === undefined ? null : await bcrypt.hash(password, 12);
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const tenantResult = await client.query(
        `SELECT operational_scope
         FROM public.tenants
         WHERE id = $1::uuid`,
        [req.user.tenantId],
      );
      const tenantScope = tenantResult.rows[0]?.operational_scope;
      if (!tenantScope) return { tenantNotFound: true };
      if (tenantScope !== 'mixed' && operationalScope !== tenantScope) {
        return { invalidScope: true };
      }

      const userResult = await client.query(
        `UPDATE public.app_users
         SET email = $1,
             full_name = $2,
             role = $3::public.user_role,
             operational_scope = $4,
             password_hash = COALESCE($5, password_hash)
         WHERE id = $6::uuid
           AND tenant_id = $7::uuid
           AND operational_scope = $8
         RETURNING id, tenant_id, email, full_name AS name, role,
                   operational_scope, is_active, created_at`,
        [
          email.trim().toLowerCase(),
          name.trim(),
          role,
          operationalScope,
          passwordHash,
          req.params.id,
          req.user.tenantId,
          req.userScope,
        ],
      );
      const user = userResult.rows[0];
      if (!user) return { userNotFound: true };

      if (role === 'technician') {
        await client.query(
          `INSERT INTO public.technicians (
             tenant_id, user_id, name, email, domain
           )
           VALUES ($1::uuid, $2::uuid, $3, $4, $5)
           ON CONFLICT (tenant_id, user_id) WHERE user_id IS NOT NULL
           DO UPDATE SET name = EXCLUDED.name,
                         email = EXCLUDED.email,
                         domain = EXCLUDED.domain,
                         status = 'active',
                         deleted_at = NULL,
                         updated_at = NOW()`,
          [
            req.user.tenantId,
            user.id,
            name.trim(),
            email.trim().toLowerCase(),
            operationalScope,
          ],
        );
      } else {
        await client.query(
          `UPDATE public.technicians
           SET status = 'inactive', deleted_at = NOW(), updated_at = NOW()
           WHERE tenant_id = $1::uuid
             AND user_id = $2::uuid
             AND deleted_at IS NULL`,
          [req.user.tenantId, user.id],
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
    if (outcome.userNotFound) {
      return res.status(404).json({ error: 'Utilizador não encontrado neste escopo.' });
    }
    return res.json({ user: outcome.user });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Já existe um utilizador com este email neste tenant.' });
    }
    return next(error);
  }
}

router.put('/:id', updateUser);
router.patch('/:id', updateUser);

router.delete('/:id', async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador do utilizador inválido.' });
  }

  try {
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const result = await client.query(
        `UPDATE public.app_users
         SET is_active = false
         WHERE id = $1::uuid
           AND tenant_id = $2::uuid
           AND operational_scope = $3
         RETURNING id, tenant_id, email, full_name AS name, role,
                   operational_scope, is_active, created_at`,
        [req.params.id, req.user.tenantId, req.userScope],
      );
      const user = result.rows[0];
      if (!user) return null;

      await client.query(
        `UPDATE public.technicians
         SET status = 'inactive', deleted_at = NOW(), updated_at = NOW()
         WHERE tenant_id = $1::uuid
           AND user_id = $2::uuid
           AND deleted_at IS NULL`,
        [req.user.tenantId, user.id],
      );
      return user;
    });

    if (!outcome) {
      return res.status(404).json({ error: 'Utilizador não encontrado neste tenant.' });
    }
    return res.json({ user: outcome });
  } catch (error) {
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
           AND operational_scope = $3
         RETURNING id, tenant_id, email, full_name AS name, role,
                   operational_scope, is_active`,
        [req.params.id, req.user.tenantId, req.userScope],
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
