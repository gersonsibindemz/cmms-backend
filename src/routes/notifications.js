import { Router } from 'express';
import { withTenantContext } from '../db.js';
import {
  authenticateToken,
  enforceDomainScope,
} from '../middlewares/auth.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

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
           AND (target_role IS NULL OR target_role = $4)
         ORDER BY created_at DESC
         LIMIT 20`,
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
             AND (target_role IS NULL OR target_role = $5)
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
             AND (target_role IS NULL OR target_role = $4)
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
