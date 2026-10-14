import { Router } from 'express';
import { withTenantContext } from '../db.js';
import {
  authenticateToken,
  enforceDomainScope,
} from '../middlewares/auth.js';

const router = Router();

router.use(authenticateToken, enforceDomainScope);

router.get('/stats', async (req, res, next) => {
  try {
    const data = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const tenantId = req.user.tenantId;
      const domain = req.userScope;

      const [
        assetsSummary,
        workOrdersSummary,
        lowStockCount,
        complianceAlerts,
        recentCriticalOrders,
      ] = await Promise.all([
        client.query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'operational')::int AS operational,
             COUNT(*) FILTER (WHERE status = 'breakdown')::int AS breakdown,
             COUNT(*) FILTER (
               WHERE status IN ('maintenance', 'under_maintenance')
             )::int AS maintenance,
             ROUND(
               (COUNT(*) FILTER (WHERE status = 'operational')::numeric
                 / NULLIF(COUNT(*), 0)::numeric) * 100,
               1
             ) AS availability_rate
           FROM public.assets
           WHERE tenant_id = $1::uuid
             AND (domain = $2 OR operational_scope = $2)
             AND deleted_at IS NULL`,
          [tenantId, domain],
        ),
        client.query(
          `SELECT
             COUNT(*) FILTER (WHERE status IN ('open', 'assigned'))::int AS pending,
             COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
             COUNT(*) FILTER (WHERE status = 'waiting_parts')::int AS waiting_parts,
             COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
             COALESCE(
               SUM(downtime_hours) FILTER (
                 WHERE created_at >= date_trunc('month', CURRENT_DATE)
               ),
               0
             )::numeric AS total_downtime_hours,
             COALESCE(
               SUM(COALESCE(total_cost_mzn, parts_cost_mzn + labor_cost_mzn, 0)) FILTER (
                 WHERE created_at >= date_trunc('month', CURRENT_DATE)
               ),
               0
             )::numeric AS total_month_cost_mzn
           FROM public.work_orders
           WHERE tenant_id = $1::uuid
             AND domain = $2
             AND deleted_at IS NULL`,
          [tenantId, domain],
        ),
        client.query(
          `SELECT COUNT(*)::int AS count
           FROM public.parts
           WHERE tenant_id = $1::uuid
             AND domain = $2
             AND current_stock <= min_stock
             AND deleted_at IS NULL`,
          [tenantId, domain],
        ),
        client.query(
          domain === 'fleet'
            ? `SELECT COUNT(*)::int AS expiring_count
               FROM public.assets
               WHERE tenant_id = $1::uuid
                 AND (domain = 'fleet' OR operational_scope = 'fleet')
                 AND deleted_at IS NULL
                 AND (
                   (inatro_inspection_expiry IS NOT NULL
                     AND inatro_inspection_expiry BETWEEN CURRENT_DATE
                       AND CURRENT_DATE + INTERVAL '30 days')
                   OR
                   (insurance_expiry IS NOT NULL
                     AND insurance_expiry BETWEEN CURRENT_DATE
                       AND CURRENT_DATE + INTERVAL '30 days')
                 )`
            : `SELECT COUNT(*)::int AS expiring_count
               FROM public.assets
               WHERE tenant_id = $1::uuid
                 AND (domain = 'plant' OR operational_scope = 'plant')
                 AND deleted_at IS NULL
                 AND (
                   (innoq_calibration_expiry IS NOT NULL
                     AND innoq_calibration_expiry BETWEEN CURRENT_DATE
                       AND CURRENT_DATE + INTERVAL '30 days')
                   OR
                   (pressure_test_expiry IS NOT NULL
                     AND pressure_test_expiry BETWEEN CURRENT_DATE
                       AND CURRENT_DATE + INTERVAL '30 days')
                 )`,
          [tenantId],
        ),
        client.query(
          `SELECT
             wo.id,
             wo.os_number,
             wo.title,
             wo.priority,
             wo.status,
             wo.created_at,
             a.name AS asset_name,
             a.code_tag AS asset_code_tag,
             COALESCE(t.name, u.full_name, 'Pendente') AS assigned_technician_name
           FROM public.work_orders wo
           INNER JOIN public.assets a
             ON a.id = wo.asset_id
             AND a.tenant_id = $1::uuid
             AND (a.domain = $2 OR a.operational_scope = $2)
           LEFT JOIN public.technicians t
             ON t.id = wo.assigned_to
             AND t.tenant_id = $1::uuid
             AND t.deleted_at IS NULL
           LEFT JOIN public.app_users u
             ON u.id = wo.assigned_to
             AND u.tenant_id = $1::uuid
           WHERE wo.tenant_id = $1::uuid
             AND wo.domain = $2
             AND wo.deleted_at IS NULL
             AND wo.status <> 'completed'
           ORDER BY
             CASE wo.priority
               WHEN 'urgent' THEN 1
               WHEN 'high' THEN 2
               WHEN 'medium' THEN 3
               ELSE 4
             END,
             wo.created_at DESC
           LIMIT 5`,
          [tenantId, domain],
        ),
      ]);

      return {
        assets: assetsSummary.rows[0],
        workOrders: workOrdersSummary.rows[0],
        inventory: { lowStockCount: lowStockCount.rows[0]?.count || 0 },
        compliance: { expiringCount: complianceAlerts.rows[0]?.expiring_count || 0 },
        recentOrders: recentCriticalOrders.rows,
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    return next(error);
  }
});

export default router;
