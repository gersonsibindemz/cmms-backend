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
                users.operational_scope,
                tenants.is_active AS tenant_active,
                tenants.operational_scope AS tenant_scope
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
    const userOperationalScope = currentUser.operational_scope || payload.operational_scope || 'fleet';
    req.user = {
      id: userId,
      tenantId: payload.tenantId,
      role: payload.role,
      fullName: payload.fullName,
      operational_scope: userOperationalScope,
      tenant_scope: currentUser.tenant_scope,
      isSuspended,
      readonly_penalty: isSuspended,
    };
    req.userScope = userOperationalScope;

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

export function enforceDomainScope(requiredScope, res, next) {
  if (requiredScope && typeof requiredScope === 'object' && res && next) {
    return createDomainScopeMiddleware()(requiredScope, res, next);
  }
  if (requiredScope !== undefined && !DOMAIN_SCOPES.has(requiredScope)) {
    throw new TypeError(`Escopo operacional desconhecido: ${requiredScope}`);
  }

  return createDomainScopeMiddleware(requiredScope);
}

function createDomainScopeMiddleware(requiredScope) {
  return async (req, res, next) => {
    if (!USER_ROLES.has(req.user.role)) {
      return res.status(403).json({ error: 'Acesso negado para o seu perfil.' });
    }

    // super_admin mantém todos os privilégios globais intactos
    if (req.user.role === 'super_admin') {
      req.userScope = null;
      return next();
    }

    if (!req.user.tenantId) {
      return res.status(403).json({ error: 'A empresa do utilizador não está definida.' });
    }

    try {
      let tenantScope = req.user.tenant_scope;
      if (!tenantScope) {
        const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
          client.query(
            `SELECT operational_scope
             FROM public.tenants
             WHERE id = $1::uuid`,
            [req.user.tenantId],
          ),
        );
        tenantScope = result.rows[0]?.operational_scope;
        req.user.tenant_scope = tenantScope;
      }

      if (!tenantScope) {
        return res.status(403).json({ error: 'Escopo operacional do tenant não definido.' });
      }

      const requestedScope = req.query.domain
        ?? req.query.operational_scope
        ?? req.get('x-operational-scope')
        ?? req.get('x-domain');

      if (
        requestedScope !== undefined &&
        requestedScope !== 'all' &&
        !DOMAIN_SCOPES.has(requestedScope)
      ) {
        return res.status(400).json({ error: 'Escopo operacional inválido.' });
      }

      // Validação se a rota exige um escopo fixo específico (ex: /fuel exige fleet)
      if (requiredScope) {
        if (req.user.role === 'tenant_admin') {
          if (tenantScope !== 'mixed' && tenantScope !== requiredScope) {
            return res.status(403).json({ error: 'O módulo não está disponível para o escopo da sua empresa.' });
          }
          req.userScope = requiredScope;
          return next();
        }

        if (req.user.operational_scope !== requiredScope) {
          return res.status(403).json({ error: 'O módulo não está disponível no seu escopo operacional.' });
        }
        req.userScope = requiredScope;
        return next();
      }

      // 1. tenant_admin:
      // Visualiza e gere todos os operational_scope configurados para a sua empresa (frota, fábrica/fabril, ou ambos se mixed).
      if (req.user.role === 'tenant_admin') {
        if (tenantScope === 'mixed') {
          if (requestedScope && DOMAIN_SCOPES.has(requestedScope)) {
            req.userScope = requestedScope;
          } else {
            req.userScope = null; // Unificado: acede a frota e fábrica simultaneamente
          }
          return next();
        }

        // Se tenant opera exclusivamente em um escopo
        if (requestedScope && requestedScope !== tenantScope && requestedScope !== 'all') {
          return res.status(403).json({ error: 'O escopo solicitado não está configurado para a sua empresa.' });
        }
        req.userScope = tenantScope;
        return next();
      }

      // 2. supervisor:
      // Visualiza e pode adicionar ativos exclusivamente dentro do operational_scope que lhe foi atribuído
      if (req.user.role === 'supervisor') {
        const userScope = req.user.operational_scope;
        if (!DOMAIN_SCOPES.has(userScope)) {
          return res.status(403).json({ error: 'Escopo operacional inválido para o supervisor.' });
        }
        if (tenantScope !== 'mixed' && tenantScope !== userScope) {
          return res.status(403).json({ error: 'O escopo do supervisor não está disponível neste tenant.' });
        }
        if (requestedScope && requestedScope !== userScope && requestedScope !== 'all') {
          return res.status(403).json({ error: 'Não tem permissão para aceder a recursos fora do seu escopo de supervisor.' });
        }
        req.userScope = userScope;
        return next();
      }

      // 3. technician:
      // Visualiza ordens no seu escopo
      if (req.user.role === 'technician') {
        const userScope = req.user.operational_scope;
        if (requestedScope && requestedScope !== userScope && requestedScope !== 'all') {
          return res.status(403).json({ error: 'O escopo solicitado não corresponde ao seu utilizador.' });
        }
        req.userScope = userScope;
        return next();
      }

      // 4. driver_operator:
      // Apenas actua no escopo operacional designado
      if (req.user.role === 'driver_operator') {
        const userScope = req.user.operational_scope;
        if (requestedScope && requestedScope !== userScope && requestedScope !== 'all') {
          return res.status(403).json({ error: 'O escopo solicitado não corresponde ao seu utilizador.' });
        }
        req.userScope = userScope;
        return next();
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
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
