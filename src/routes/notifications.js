import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { withTenantContext } from '../db.js';
import {
  authenticateToken,
  enforceDomainScope,
} from '../middlewares/auth.js';
import { createAndDispatchNotification, notificationBus } from '../services/notificationService.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const USER_ROLES = new Set([
  'super_admin',
  'tenant_admin',
  'supervisor',
  'technician',
  'driver_operator',
]);

router.get('/stream', (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = req.query.token
    || (typeof authHeader === 'string' ? authHeader.split(' ')[1] : null)
    || req.cookies?.auth_token;
  if (typeof token !== 'string' || !token) {
    return res.status(401).json({ error: 'Autenticação necessária.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }

  const userId = payload && typeof payload === 'object'
    ? payload.id ?? payload.userId
    : null;
  if (
    !payload ||
    typeof payload !== 'object' ||
    !USER_ROLES.has(payload.role) ||
    typeof userId !== 'string' ||
    !UUID_PATTERN.test(userId) ||
    typeof payload.tenantId !== 'string' ||
    !UUID_PATTERN.test(payload.tenantId)
  ) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }

  req.user = {
    id: userId,
    tenantId: payload.tenantId,
    role: payload.role,
    fullName: payload.fullName,
    operational_scope: payload.operational_scope,
  };
  req.userScope = req.user.operational_scope || 'fleet';

  return enforceDomainScope(req, res, () => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED' })}\n\n`);

    const keepAlive = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25000);

    const listener = (notification) => {
      if (
        String(notification.tenant_id) !== String(req.user.tenantId) ||
        notification.domain !== req.userScope
      ) {
        return;
      }

      const matchesUser = notification.user_id
        && String(notification.user_id) === String(req.user.id);
      const matchesRole = notification.target_role
        && (
          notification.target_role === req.user.role ||
          (req.user.role === 'tenant_admin' && notification.target_role === 'supervisor')
        );
      const isGlobalTenant = !notification.user_id && !notification.target_role;

      if (matchesUser || matchesRole || isGlobalTenant) {
        res.write(`data: ${JSON.stringify({ type: 'NOTIFICATION', notification })}\n\n`);
      }
    };
    const cleanup = () => {
      clearInterval(keepAlive);
      notificationBus.removeListener('new_notification', listener);
    };

    notificationBus.on('new_notification', listener);
    req.on('close', cleanup);
    res.on('close', cleanup);
  });
});

router.use(authenticateToken, enforceDomainScope);

router.get('/', async (req, res, next) => {
  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT notifications.*,
                COUNT(*) FILTER (WHERE is_read = false) OVER ()::int AS unread_count
         FROM public.notifications AS notifications
         WHERE tenant_id = $1::uuid
           AND domain = $2
           AND (user_id IS NULL OR user_id = $3::uuid)
           AND (
             target_role IS NULL
             OR target_role = $4
             OR ($4 = 'tenant_admin' AND target_role = 'supervisor')
           )
         ORDER BY created_at DESC
         LIMIT 25`,
        [req.user.tenantId, req.userScope, req.user.id, req.user.role],
      ),
    );
    const notifications = result.rows.map(({ unread_count: _unreadCount, ...row }) => row);
    const unreadCount = result.rows[0]?.unread_count ?? 0;
    return res.json({ notifications, unreadCount });
  } catch (error) {
    return next(error);
  }
});

router.get('/check-compliance', async (req, res, next) => {
  try {
    const notifications = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const expiringAssets = await client.query(
        `SELECT assets.id AS asset_id,
                assets.name AS asset_name,
                assets.code_tag,
                assets.tenant_id,
                assets.domain,
                expiries.compliance_type,
                expiries.expiry_date::date::text AS expiry_date
         FROM public.assets AS assets
         CROSS JOIN LATERAL (
           VALUES
             ('inatro_inspection', assets.inatro_inspection_expiry),
             ('insurance', assets.insurance_expiry)
         ) AS expiries(compliance_type, expiry_date)
         WHERE assets.tenant_id = $1::uuid
           AND (assets.domain = $2 OR assets.operational_scope = $2)
           AND assets.deleted_at IS NULL
           AND expiries.expiry_date BETWEEN CURRENT_DATE
               AND CURRENT_DATE + INTERVAL '30 days'
         ORDER BY expiries.expiry_date ASC`,
        [req.user.tenantId, req.userScope],
      );
      const createdNotifications = [];

      for (const asset of expiringAssets.rows) {
        const logResult = await client.query(
          `INSERT INTO public.compliance_notification_logs (
             tenant_id, asset_id, compliance_type, notification_date
           )
           VALUES ($1::uuid, $2::uuid, $3, CURRENT_DATE)
           ON CONFLICT (tenant_id, asset_id, compliance_type, notification_date)
           DO NOTHING
           RETURNING id`,
          [
            asset.tenant_id,
            asset.asset_id,
            asset.compliance_type,
          ],
        );
        if (logResult.rowCount === 0) continue;

        const message = `${asset.compliance_type === 'insurance' ? 'O seguro' : 'A inspeção INATRO'} do ativo ${asset.asset_name} (${asset.code_tag}) vence em ${asset.expiry_date}.`;
        for (const targetRole of ['supervisor', 'tenant_admin']) {
          createdNotifications.push(await createAndDispatchNotification({
            tenantId: asset.tenant_id,
            domain: asset.domain,
            targetRole,
            title: 'Conformidade próxima do vencimento',
            message,
            link: `/app/assets?id=${asset.asset_id}`,
            client,
          }));
        }
      }

      return createdNotifications;
    });

    return res.json({
      checked: true,
      notificationsCreated: notifications.length,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:id/read', async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador da notificação inválido.' });
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `UPDATE public.notifications
         SET is_read = true
         WHERE id = $1::uuid
           AND tenant_id = $2::uuid
           AND domain = $3
           AND (user_id = $4::uuid OR (
             user_id IS NULL
             AND (
               target_role IS NULL
               OR target_role = $5
               OR ($5 = 'tenant_admin' AND target_role = 'supervisor')
             )
           ))
         RETURNING *`,
        [req.params.id, req.user.tenantId, req.userScope, req.user.id, req.user.role],
      ),
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Notificação não encontrada.' });
    }
    return res.json({ notification: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.patch('/read-all', async (req, res, next) => {
  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `UPDATE public.notifications
         SET is_read = true
         WHERE tenant_id = $1::uuid
           AND domain = $2
           AND is_read = false
           AND (user_id = $3::uuid OR (
             user_id IS NULL
             AND (
               target_role IS NULL
               OR target_role = $4
               OR ($4 = 'tenant_admin' AND target_role = 'supervisor')
             )
           ))
         RETURNING id`,
        [req.user.tenantId, req.userScope, req.user.id, req.user.role],
      ),
    );
    return res.json({ updatedCount: result.rowCount });
  } catch (error) {
    return next(error);
  }
});

export default router;
