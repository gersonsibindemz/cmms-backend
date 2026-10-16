import { Router } from 'express';
import { withTenantContext } from '../db.js';
import {
  authenticateToken,
  enforceDomainScope,
} from '../middlewares/auth.js';

const router = Router();

router.use(authenticateToken, enforceDomainScope);

async function getDashboard(req, res, next) {
  try {
    const data = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const tenantId = req.user.tenantId;
      const domain = req.userScope;
      const [
        assetsSummary,
        workOrdersSummary,
        fuelSummary,
        lowStockCount,
        complianceAlerts,
        recentOrders,
      ] = await Promise.all([
        client.query(
          `SELECT
             COUNT(*)::int AS total_assets,
             COUNT(*) FILTER (WHERE status = 'operational')::int AS operational_count,
             COUNT(*) FILTER (WHERE status = 'breakdown')::int AS breakdown_count,
             COUNT(*) FILTER (
               WHERE status IN ('in_maintenance', 'under_maintenance')
             )::int AS maintenance_count,
             COUNT(*) FILTER (
               WHERE status IN ('inactive', 'decommissioned')
             )::int AS inactive_count,
             COALESCE(
               ROUND(
                 (COUNT(*) FILTER (WHERE status = 'operational')::decimal
                   / NULLIF(COUNT(*), 0)) * 100,
                 1
               ),
               100
             )::double precision AS availability_rate
           FROM public.assets
           WHERE tenant_id = $1::uuid
             AND (domain = $2 OR operational_scope = $2)
             AND deleted_at IS NULL`,
          [tenantId, domain],
        ),
        client.query(
          `SELECT
             COUNT(*) FILTER (
               WHERE status IN ('open', 'assigned', 'in_progress', 'pending_parts', 'waiting_parts')
             )::int AS pending_orders,
             COUNT(*) FILTER (WHERE status IN ('open', 'assigned'))::int AS pending,
             COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
             COUNT(*) FILTER (WHERE status IN ('waiting_parts', 'pending_parts'))::int AS waiting_parts,
             COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
             COUNT(*) FILTER (
               WHERE priority IN ('high', 'urgent')
                 AND status NOT IN ('completed', 'closed', 'cancelled')
             )::int AS critical_orders,
             COUNT(*) FILTER (
               WHERE status IN ('completed', 'closed')
                 AND completed_at >= date_trunc('month', CURRENT_DATE)
             )::int AS completed_this_month,
             COALESCE(
               SUM(total_cost_mzn) FILTER (
                 WHERE completed_at >= date_trunc('month', CURRENT_DATE)
               ),
               0
             )::double precision AS maintenance_cost_this_month,
             COALESCE(
               SUM(downtime_hours) FILTER (
                 WHERE created_at >= date_trunc('month', CURRENT_DATE)
               ),
               0
             )::double precision AS total_downtime_hours
           FROM public.work_orders
           WHERE tenant_id = $1::uuid
             AND domain = $2
             AND deleted_at IS NULL`,
          [tenantId, domain],
        ),
        domain === 'fleet'
          ? client.query(
            `SELECT
               COALESCE(SUM(liters), 0)::double precision AS total_liters_this_month,
               COALESCE(SUM(total_cost_mzn), 0)::double precision AS total_fuel_cost_this_month
             FROM public.fuel_logs
             WHERE tenant_id = $1::uuid
               AND logged_at >= date_trunc('month', CURRENT_DATE)`,
            [tenantId],
          )
          : Promise.resolve({
            rows: [{
              total_liters_this_month: 0,
              total_fuel_cost_this_month: 0,
            }],
          }),
        client.query(
          `SELECT COUNT(*)::int AS low_stock_count
           FROM public.parts
           WHERE tenant_id = $1::uuid
             AND domain = $2
             AND current_stock <= min_stock
             AND deleted_at IS NULL`,
          [tenantId, domain],
        ),
        domain === 'fleet'
          ? client.query(
            `SELECT COUNT(*)::int AS expiring_count
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
               )`,
            [tenantId],
          )
          : client.query(
            `SELECT COUNT(*)::int AS expiring_count
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
           FROM public.work_orders AS wo
           JOIN public.assets AS a
             ON a.id = wo.asset_id
            AND a.tenant_id = wo.tenant_id
            AND (a.domain = $2 OR a.operational_scope = $2)
            AND a.deleted_at IS NULL
           LEFT JOIN public.technicians AS t
             ON t.id = wo.assigned_to
            AND t.tenant_id = wo.tenant_id
            AND t.deleted_at IS NULL
           LEFT JOIN public.app_users AS u
             ON u.id = wo.assigned_to
            AND u.tenant_id = wo.tenant_id
           WHERE wo.tenant_id = $1::uuid
             AND wo.domain = $2
             AND wo.deleted_at IS NULL
           ORDER BY wo.created_at DESC
           LIMIT 5`,
          [tenantId, domain],
        ),
      ]);

      const assetMetrics = assetsSummary.rows[0];
      const workOrderMetrics = workOrdersSummary.rows[0];
      const fuelMetrics = fuelSummary.rows[0];
      return {
        assets: {
          ...assetMetrics,
          total: assetMetrics.total_assets,
          operational: assetMetrics.operational_count,
          breakdown: assetMetrics.breakdown_count,
          maintenance: assetMetrics.maintenance_count,
          inactive: assetMetrics.inactive_count,
          availability_rate: assetMetrics.availability_rate,
        },
        workOrders: {
          ...workOrderMetrics,
          total_month_cost_mzn: workOrderMetrics.maintenance_cost_this_month,
        },
        fuel: fuelMetrics,
        inventory: { lowStockCount: lowStockCount.rows[0].low_stock_count },
        compliance: { expiringCount: complianceAlerts.rows[0].expiring_count },
        recentOrders: recentOrders.rows,
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    return next(error);
  }
}

router.get('/', getDashboard);
router.get('/stats', getDashboard);

export default router;
