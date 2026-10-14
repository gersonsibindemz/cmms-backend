import { Router } from 'express';
import bcrypt from 'bcrypt';
import { withTenantContext } from '../db.js';
import { authenticateToken } from '../middlewares/auth.js';

const router = Router();
const USER_ROLES = new Set(['tenant_admin', 'supervisor', 'technician', 'driver_operator']);
const OPERATIONAL_SCOPES = new Set(['fleet', 'plant']);
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

router.use(authenticateToken, (req, res, next) => {
  if (req.user?.role !== 'super_admin') {
    return res.status(403).json({
      error: 'Acesso restrito à equipa de administração da Avexas.',
    });
  }
  return next();
});

router.get('/', async (req, res, next) => {
  const targetTenant = req.query.tenant_id;
  if (targetTenant !== undefined && (
    typeof targetTenant !== 'string' || !UUID_PATTERN.test(targetTenant)
  )) {
    return res.status(400).json({ error: 'Identificador do tenant inválido.' });
  }

  try {
    let queryText = `
      SELECT u.id, u.tenant_id, t.name AS tenant_name, u.email, u.full_name,
             u.role, u.operational_scope, u.is_active, u.created_at
      FROM public.app_users u
      LEFT JOIN public.tenants t ON t.id = u.tenant_id
      WHERE u.deleted_at IS NULL
    `;
    const params = [];

    if (targetTenant) {
      params.push(targetTenant);
      queryText += ` AND u.tenant_id = $${params.length}::uuid`;
    }

    queryText += ' ORDER BY u.created_at DESC;';

    const result = await withTenantContext(null, 'super_admin', (client) => {
      return client.query(queryText, params);
    });
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/', async (req, res, next) => {
  const {
    tenant_id: tenantId,
    full_name: fullName,
    email,
    password,
    role,
    operational_scope: operationalScope,
  } = req.body ?? {};
  if (
    typeof tenantId !== 'string' ||
    !UUID_PATTERN.test(tenantId) ||
    typeof fullName !== 'string' ||
    !fullName.trim() ||
    fullName.trim().length > 255 ||
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
    const outcome = await withTenantContext(null, 'super_admin', async (client) => {
      const tenantResult = await client.query(
        `SELECT operational_scope, max_users_limit
         FROM public.tenants
         WHERE id = $1::uuid
         FOR UPDATE`,
        [tenantId],
      );
      const tenant = tenantResult.rows[0];
      if (!tenant) return { tenantNotFound: true };

      if (
        !OPERATIONAL_SCOPES.has(operationalScope) ||
        (tenant.operational_scope !== 'mixed' && operationalScope !== tenant.operational_scope)
      ) {
        return { invalidScope: true };
      }

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM public.app_users
         WHERE tenant_id = $1::uuid
           AND is_active IS TRUE
           AND deleted_at IS NULL`,
        [tenantId],
      );
      if (countResult.rows[0].total >= Number(tenant.max_users_limit)) {
        return { limitReached: true };
      }

      const userResult = await client.query(
        `INSERT INTO public.app_users (
           tenant_id, email, password_hash, full_name, role, operational_scope
         )
         VALUES ($1::uuid, $2, $3, $4, $5::public.user_role, $6)
         RETURNING id, tenant_id, email, full_name AS name, role,
                   operational_scope, is_active, created_at`,
        [tenantId, email.trim().toLowerCase(), passwordHash, fullName.trim(), role, operationalScope],
      );
      const user = userResult.rows[0];

      if (role === 'technician') {
        await client.query(
          `INSERT INTO public.technicians (
             tenant_id, user_id, name, email, domain
           )
           VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
          [tenantId, user.id, fullName.trim(), email.trim().toLowerCase(), operationalScope],
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
    if (outcome.limitReached) {
      return res.status(403).json({ error: 'Limite de utilizadores atingido para este tenant.' });
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

  const { name, email, role, operational_scope: operationalScope, password } = req.body ?? {};
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 255 ||
    typeof email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
    !USER_ROLES.has(role) ||
    !OPERATIONAL_SCOPES.has(operationalScope) ||
    (password !== undefined && (typeof password !== 'string' || password.length < 8))
  ) {
    return res.status(400).json({ error: 'Dados do utilizador inválidos.' });
  }

  try {
    const passwordHash = password === undefined ? null : await bcrypt.hash(password, 12);
    const outcome = await withTenantContext(null, 'super_admin', async (client) => {
      const tenantResult = await client.query(
        `SELECT t.id, t.operational_scope
         FROM public.app_users u
         JOIN public.tenants t ON t.id = u.tenant_id
         WHERE u.id = $1::uuid
           AND u.deleted_at IS NULL`,
        [req.params.id],
      );
      const tenant = tenantResult.rows[0];
      if (!tenant) return { userNotFound: true };
      if (tenant.operational_scope !== 'mixed' && operationalScope !== tenant.operational_scope) {
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
           AND deleted_at IS NULL
         RETURNING id, tenant_id, email, full_name AS name, role,
                   operational_scope, is_active, created_at`,
        [
          email.trim().toLowerCase(),
          name.trim(),
          role,
          operationalScope,
          passwordHash,
          req.params.id,
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
            tenant.id,
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
          [tenant.id, user.id],
        );
      }

      return { user };
    });

    if (outcome.invalidScope) {
      return res.status(400).json({ error: 'Escopo operacional inválido para este tenant.' });
    }
    if (outcome.userNotFound) {
      return res.status(404).json({ error: 'Utilizador não encontrado.' });
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
    const outcome = await withTenantContext(null, 'super_admin', async (client) => {
      const result = await client.query(
        `UPDATE public.app_users
         SET is_active = false,
             deleted_at = NOW()
         WHERE id = $1::uuid
           AND deleted_at IS NULL
         RETURNING id, tenant_id, email, full_name AS name, role,
                   operational_scope, is_active, created_at`,
        [req.params.id],
      );
      const user = result.rows[0];
      if (!user) return null;

      await client.query(
        `UPDATE public.technicians
         SET status = 'inactive', deleted_at = NOW(), updated_at = NOW()
         WHERE tenant_id = $1::uuid
           AND user_id = $2::uuid
           AND deleted_at IS NULL`,
        [user.tenant_id, user.id],
      );
      return user;
    });

    if (!outcome) {
      return res.status(404).json({ error: 'Utilizador não encontrado.' });
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
    const result = await withTenantContext(null, 'super_admin', (client) =>
      client.query(
        `UPDATE public.app_users
         SET is_active = NOT is_active
         WHERE id = $1::uuid
           AND deleted_at IS NULL
         RETURNING id, tenant_id, email, full_name AS name, role,
                   operational_scope, is_active`,
        [req.params.id],
      ),
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Utilizador não encontrado.' });
    }
    return res.json({ user: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

export default router;
