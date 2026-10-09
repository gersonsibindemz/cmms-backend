import { Router } from 'express';
import { withTenantContext } from '../db.js';
import { authenticateToken } from '../middlewares/auth.js';

const router = Router();

router.use(authenticateToken);

router.get('/', async (req, res, next) => {
  const { id: userId, role, tenantId } = req.user;
  if (role !== 'technician') {
    return res.status(403).json({ message: 'Apenas técnicos podem consultar estas notificações.' });
  }
  if (!tenantId) {
    return res.status(403).json({ message: 'A empresa do utilizador não está definida.' });
  }

  try {
    const notifications = await withTenantContext(tenantId, role, async (client) => {
      const technicianResult = await client.query(
        `SELECT id
         FROM public.technicians
         WHERE user_id = $1
           AND tenant_id = $2
           AND deleted_at IS NULL
         LIMIT 1`,
        [userId, tenantId],
      );
      const technicianId = technicianResult.rows[0]?.id;
      if (!technicianId) return [];

      const result = await client.query(
        `SELECT work_orders.id,
                work_orders.title,
                work_orders.title AS message,
                work_orders.os_number AS "osNumber",
                work_orders.id AS "workOrderId",
                work_orders.created_at AS "createdAt"
         FROM public.work_orders
         WHERE work_orders.tenant_id = $1
           AND work_orders.deleted_at IS NULL
           AND work_orders.status = 'open'
           AND work_orders.assigned_to IN ($2, $3)
           AND work_orders.created_at >= NOW() - INTERVAL '48 hours'
         ORDER BY work_orders.created_at DESC`,
        [tenantId, userId, technicianId],
      );
      return result.rows.map(({ title, ...notification }) => ({
        ...notification,
        title: 'Nova OS Atribuída',
      }));
    });

    return res.json(notifications);
  } catch (error) {
    return next(error);
  }
});

export default router;
