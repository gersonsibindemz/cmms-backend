import jwt from 'jsonwebtoken';
import { withTenantContext } from '../db.js';

const DOMAIN_SCOPES = new Set(['fleet', 'plant']);
const USER_ROLES = new Set([
  'super_admin',
  'tenant_admin',
  'supervisor',
  'technician',
  'driver_operator',
]);

export async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.cookies?.auth_token) {
    token = req.cookies.auth_token;
  }

  if (!token) {
    return res.status(401).json({ message: 'Autenticação necessária.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!USER_ROLES.has(payload.role)) {
      return res.status(403).json({ message: 'Token inválido ou expirado.' });
    }

    const userId = payload.id ?? payload.userId;
    if (typeof userId !== 'string') {
      return res.status(403).json({ message: 'Token inválido ou expirado.' });
    }
    const result = await withTenantContext(payload.tenantId ?? null, payload.role, (client) =>
      client.query(
        `SELECT users.is_active,
                users.deleted_at,
                tenants.is_active AS tenant_active
         FROM public.app_users AS users
         LEFT JOIN public.tenants AS tenants ON tenants.id = users.tenant_id
         WHERE users.id = $1::uuid
           AND (
             ($2::uuid IS NULL AND $3::text = 'super_admin')
             OR users.tenant_id = $2::uuid
           )`,
        [userId, payload.tenantId ?? null, payload.role],
      ),
    );
    const currentUser = result.rows[0];
    if (
      !currentUser
      || currentUser.deleted_at !== null
      || (payload.role !== 'super_admin' && currentUser.tenant_active !== true)
    ) {
      return res.status(403).json({ message: 'Token inválido ou expirado.' });
    }

    const isSuspended = currentUser.is_active === false;
    req.user = {
      id: userId,
      tenantId: payload.tenantId,
      role: payload.role,
      fullName: payload.fullName,
      operational_scope: payload.operational_scope,
      isSuspended,
      readonly_penalty: isSuspended,
    };
    req.userScope = req.user.operational_scope || 'fleet';

    if (
      isSuspended
      && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
    ) {
      return res.status(403).json({
        message: 'Conta suspensa. Acesso apenas de leitura.',
      });
    }

    return next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(403).json({ message: 'Token inválido ou expirado.' });
    }
    return next(error);
  }
}

export function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !Array.isArray(allowedRoles) || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Acesso negado para o seu perfil.' });
    }

    return next();
  };
}

export function requireRoles(...allowedRoles) {
  return requireRole(allowedRoles);
}

export function enforceDomainScope(req, res, next) {
  if (!USER_ROLES.has(req.user.role)) {
    return res.status(403).json({ error: 'Acesso negado para o seu perfil.' });
  }
  if (req.user.role === 'super_admin') return next();

  if (!req.user.tenantId) {
    return res.status(403).json({ error: 'A empresa do utilizador não está definida.' });
  }
  if (!DOMAIN_SCOPES.has(req.userScope)) {
    return res.status(403).json({ error: 'Escopo operacional inválido para este utilizador.' });
  }

  const requestedScope = req.query.domain
    ?? req.query.operational_scope
    ?? req.get('x-operational-scope')
    ?? req.get('x-domain');
  if (requestedScope !== undefined && !DOMAIN_SCOPES.has(requestedScope)) {
    return res.status(400).json({ error: 'Escopo operacional inválido.' });
  }
  if (requestedScope !== undefined && requestedScope !== req.userScope) {
    return res.status(403).json({ error: 'O escopo solicitado não corresponde ao utilizador.' });
  }

  withTenantContext(req.user.tenantId, req.user.role, (client) =>
    client.query(
      `SELECT operational_scope, default_operational_scope
       FROM public.tenants
       WHERE id = $1::uuid`,
      [req.user.tenantId],
    ),
  ).then((result) => {
    const tenantScope = result.rows[0]?.operational_scope;
    if (!tenantScope) {
      return res.status(403).json({ error: 'Escopo operacional do tenant não definido.' });
    }

    if (tenantScope !== 'mixed' && req.userScope !== tenantScope) {
      return res.status(403).json({ error: 'O escopo do utilizador não está disponível neste tenant.' });
    }
    return next();
  }).catch(next);
}

export function checkTenantLimits(limitType) {
  if (!['assets', 'users'].includes(limitType)) {
    throw new TypeError(`Tipo de limite desconhecido: ${limitType}`);
  }

  return async (req, res, next) => {
    if (!req.user?.tenantId) {
      return res.status(403).json({ error: 'A empresa do utilizador não está definida.' });
    }

    try {
      const allowed = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
        const tenantResult = await client.query(
          `SELECT max_assets_limit, max_users_limit
           FROM public.tenants
           WHERE id = $1::uuid`,
          [req.user.tenantId],
        );
        const tenant = tenantResult.rows[0];
        if (!tenant) return false;

        const countResult = limitType === 'assets'
          ? await client.query(
            `SELECT COUNT(*)::int AS total
             FROM public.assets
             WHERE tenant_id = $1::uuid
               AND deleted_at IS NULL
               AND status <> 'decommissioned'`,
            [req.user.tenantId],
          )
          : await client.query(
            `SELECT COUNT(*)::int AS total
             FROM public.app_users
             WHERE tenant_id = $1::uuid
               AND is_active IS TRUE`,
            [req.user.tenantId],
          );
        const limit = Number(limitType === 'assets'
          ? tenant.max_assets_limit
          : tenant.max_users_limit);

        return countResult.rows[0].total < limit;
      });

      if (!allowed) {
        const resource = limitType === 'assets' ? 'ativos' : 'utilizadores';
        return res.status(403).json({ error: `Limite de ${resource} atingido para este tenant.` });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}