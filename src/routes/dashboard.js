import { Router } from 'express';
import { withTenantContext } from '../db.js';
import {
  authenticateToken,
  enforceDomainScope,
} from '../middlewares/auth.js';

const router = Router();

router.use(authenticateToken);

router.use(async (req, res, next) => {
  const requestedScope = req.query.domain
    ?? req.query.operational_scope
    ?? req.get('x-operational-scope')
    ?? req.get('x-domain')
    ?? req.userScope;

  if (requestedScope !== 'all') {
    return enforceDomainScope(req, res, next);
  }
  if (!req.user.tenantId || req.user.role !== 'tenant_admin') {
    return res.status(403).json({ error: 'Acesso negado para consultar todos os escopos.' });
  }

  try {
    const tenant = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT operational_scope
         FROM public.tenants
         WHERE id = $1::uuid`,
        [req.user.tenantId],
      ),
    );
    if (tenant.rows[0]?.operational_scope !== 'mixed') {
      return res.status(403).json({ error: 'O escopo "all" só está disponível em tenants mistos.' });
    }
    req.userScope = 'all';
    return next();
  } catch (error) {
    return next(error);
  }
});

async function getDashboard(req, res, next) {
  if (!req.user.tenantId) {
    return res.status(403).json({ error: 'A empresa do utilizador não está definida.' });
  }

  try {
    const stats = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const tenantId = req.user.tenantId;
      const scope = req.userScope;
      const [
        assetsSummary,
        workOrdersSummary,
        fuelSummary,
        lowStockSummary,
        complianceSummary,
        recentOrders,
      ] = await Promise.all([
        client.query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'operational')::int AS operational,
             COUNT(*) FILTER (
               WHERE status IN ('in_maintenance', 'under_maintenance')
             )::int AS maintenance,
             COUNT(*) FILTER (WHERE status IN ('breakdown', 'inactive'))::int AS breakdown
           FROM public.assets
           WHERE tenant_id = $1::uuid
             AND deleted_at IS NULL
             AND ($2 = 'all' OR domain = $2 OR operational_scope = $2)`,
          [tenantId, scope],
        ),
        client.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'open')::int AS pending,
             COUNT(*) FILTER (
               WHERE status IN ('in_progress', 'waiting_parts', 'paused')
             )::int AS in_progress,
             COUNT(*) FILTER (
               WHERE status IN ('open', 'in_progress', 'waiting_parts', 'paused')
             )::int AS active,
             COALESCE(
               SUM(total_cost_mzn) FILTER (
                 WHERE COALESCE(closed_at, completed_at) >= date_trunc('month', CURRENT_DATE)
               ),
               0
             )::numeric AS month_cost_mzn,
             COALESCE(
               SUM(downtime_hours) FILTER (
                 WHERE COALESCE(closed_at, completed_at) >= date_trunc('month', CURRENT_DATE)
               ),
               0
             )::numeric AS downtime_hours
           FROM public.work_orders
           WHERE tenant_id = $1::uuid
             AND deleted_at IS NULL
             AND ($2 = 'all' OR domain = $2 OR operational_scope = $2)`,
          [tenantId, scope],
        ),
        client.query(
          `SELECT COALESCE(SUM(total_cost_mzn), 0)::numeric AS fuel_month_cost_mzn
           FROM public.fuel_logs
           WHERE tenant_id = $1::uuid
             AND logged_at >= date_trunc('month', CURRENT_DATE)`,
          [tenantId],
        ),
        client.query(
          `SELECT COUNT(*)::int AS low_stock_count
           FROM public.parts
           WHERE tenant_id = $1::uuid
             AND deleted_at IS NULL
             AND current_stock <= min_stock
             AND ($2 = 'all' OR domain = $2)`,
          [tenantId, scope],
        ),
        client.query(
          `SELECT COUNT(*)::int AS expiring_count
           FROM public.assets
           WHERE tenant_id = $1::uuid
             AND deleted_at IS NULL
             AND ($2 = 'all' OR domain = $2 OR operational_scope = $2)
             AND (
               (inatro_inspection_expiry IS NOT NULL
                 AND inatro_inspection_expiry BETWEEN CURRENT_DATE
                   AND CURRENT_DATE + INTERVAL '30 days')
               OR
               (insurance_expiry IS NOT NULL
                 AND insurance_expiry BETWEEN CURRENT_DATE
                   AND CURRENT_DATE + INTERVAL '30 days')
             )`,
          [tenantId, scope],
        ),
        client.query(
          `SELECT
             wo.id,
             wo.os_number AS wo_number,
             wo.title,
             wo.priority,
             wo.status,
             wo.created_at,
             a.name AS asset_name,
             a.code_tag AS asset_code,
             COALESCE(t.name, u.full_name) AS assigned_technician_name
           FROM public.work_orders AS wo
           LEFT JOIN public.assets AS a
             ON a.id = wo.asset_id
            AND a.tenant_id = wo.tenant_id
            AND a.deleted_at IS NULL
           LEFT JOIN public.app_users AS u
             ON u.id = wo.assigned_to
            AND u.tenant_id = wo.tenant_id
           LEFT JOIN public.technicians AS t
             ON t.id = wo.assigned_to
            AND t.tenant_id = wo.tenant_id
            AND t.deleted_at IS NULL
           WHERE wo.tenant_id = $1::uuid
             AND wo.deleted_at IS NULL
             AND ($2 = 'all' OR wo.domain = $2 OR wo.operational_scope = $2)
           ORDER BY
             CASE WHEN wo.priority = 'urgent' THEN 1
                  WHEN wo.priority = 'high' THEN 2
                  ELSE 3 END,
             wo.created_at DESC
           LIMIT 5`,
          [tenantId, scope],
        ),
      ]);

      const workOrders = workOrdersSummary.rows[0];
      return {
        assets: assetsSummary.rows[0],
        workOrders: {
          active: workOrders.active,
          pending: workOrders.pending,
          in_progress: workOrders.in_progress,
          total_month_cost_mzn: Number(workOrders.month_cost_mzn)
            + Number(fuelSummary.rows[0].fuel_month_cost_mzn),
          total_downtime_hours: Number(workOrders.downtime_hours),
        },
        inventory: { lowStockCount: lowStockSummary.rows[0].low_stock_count },
        compliance: { expiringCount: complianceSummary.rows[0].expiring_count },
        recentWorkOrders: recentOrders.rows,
      };
    });

    return res.status(200).json({ stats });
  } catch (error) {
    return next(error);
  }
}

router.get('/', getDashboard);
router.get('/stats', getDashboard);

export default router;
