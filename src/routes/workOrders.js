import { Router } from 'express';
import { withTenantContext } from '../db.js';
import { authenticateToken, requireRoles } from '../middlewares/auth.js';

const router = Router();

router.use(authenticateToken);

router.get('/', async (req, res, next) => {
  const filters = [];
  const values = [];

  for (const [queryKey, column] of [
    ['status', 'work_orders.status'],
    ['priority', 'work_orders.priority'],
    ['assetId', 'work_orders.asset_id'],
  ]) {
    const value = req.query[queryKey];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string') {
      return res.status(400).json({ message: `Filtro inválido: ${queryKey}.` });
    }

    values.push(value);
    filters.push(`${column} = $${values.length}`);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT
           work_orders.*,
           assets.code_tag,
           assets.name,
           assigned_user.full_name AS assigned_to_name
         FROM work_orders
         JOIN assets
           ON assets.id = work_orders.asset_id
          AND assets.tenant_id = work_orders.tenant_id
         LEFT JOIN app_users AS assigned_user
           ON assigned_user.id = work_orders.assigned_to
          AND assigned_user.tenant_id = work_orders.tenant_id
         ${whereClause}
         ORDER BY work_orders.opened_at DESC`,
        values,
      ),
    );

    return res.json({ workOrders: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/', async (req, res, next) => {
  const {
    assetId,
    title,
    description,
    orderType,
    priority,
    meterAtService,
    assignedTo,
  } = req.body ?? {};

  if (
    !assetId ||
    typeof title !== 'string' ||
    !title.trim() ||
    typeof orderType !== 'string' ||
    typeof priority !== 'string' ||
    (meterAtService !== undefined && meterAtService !== null && typeof meterAtService !== 'number')
  ) {
    return res.status(400).json({ message: 'Dados obrigatórios da ordem de serviço inválidos.' });
  }

  const assigneeId = assignedTo || null;
  const status = assigneeId ? 'assigned' : 'open';

  try {
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const assetResult = await client.query(
        'SELECT id FROM assets WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [assetId, req.user.tenantId],
      );
      if (assetResult.rowCount === 0) return { notFound: true };

      if (assigneeId) {
        const assigneeResult = await client.query(
          'SELECT id FROM app_users WHERE id = $1 AND tenant_id = $2',
          [assigneeId, req.user.tenantId],
        );
        if (assigneeResult.rowCount === 0) return { invalidAssignee: true };
      }

      if (orderType === 'corrective') {
        await client.query(
          "UPDATE assets SET status = 'breakdown' WHERE id = $1 AND tenant_id = $2",
          [assetId, req.user.tenantId],
        );
      }

      const result = await client.query(
        `INSERT INTO work_orders (
           tenant_id,
           asset_id,
           title,
           description,
           order_type,
           priority,
           status,
           meter_at_service,
           reported_by,
           assigned_to
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          req.user.tenantId,
          assetId,
          title.trim(),
          description ?? null,
          orderType,
          priority,
          status,
          meterAtService ?? null,
          req.user.id,
          assigneeId,
        ],
      );

      return { workOrder: result.rows[0] };
    });

    if (outcome.notFound) {
      return res.status(404).json({ message: 'Ativo não encontrado neste tenant.' });
    }
    if (outcome.invalidAssignee) {
      return res.status(400).json({ message: 'Responsável não encontrado neste tenant.' });
    }

    return res.status(201).json({ workOrder: outcome.workOrder });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:id/close', requireRoles('tenant_admin', 'supervisor'), async (req, res, next) => {
  const { downtimeHours, partsCostMzn, laborCostMzn } = req.body ?? {};

  if (
    [downtimeHours, partsCostMzn, laborCostMzn].some(
      (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0,
    )
  ) {
    return res.status(400).json({ message: 'Horas de inatividade e custos devem ser números não negativos.' });
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const orderResult = await client.query(
        'SELECT id, asset_id FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [req.params.id, req.user.tenantId],
      );
      const order = orderResult.rows[0];
      if (!order) return null;

      const assetResult = await client.query(
        'SELECT id FROM assets WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [order.asset_id, req.user.tenantId],
      );
      if (assetResult.rowCount === 0) return null;

      const updatedOrder = await client.query(
        `UPDATE work_orders
         SET status = 'completed',
             closed_at = NOW(),
             downtime_hours = $1,
             parts_cost_mzn = $2,
             labor_cost_mzn = $3
         WHERE id = $4 AND tenant_id = $5
         RETURNING *`,
        [downtimeHours, partsCostMzn, laborCostMzn, req.params.id, req.user.tenantId],
      );

      await client.query(
        "UPDATE assets SET status = 'operational' WHERE id = $1 AND tenant_id = $2",
        [order.asset_id, req.user.tenantId],
      );

      return updatedOrder.rows[0];
    });

    if (!result) {
      return res.status(404).json({ message: 'Ordem de serviço não encontrada.' });
    }

    return res.json({ workOrder: result });
  } catch (error) {
    return next(error);
  }
});

export default router;