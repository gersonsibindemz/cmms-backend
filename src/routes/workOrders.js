import { Router } from 'express';
import { withTenantContext } from '../db.js';
import { authenticateToken, requireRoles } from '../middlewares/auth.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ORDER_TYPES = new Set(['corrective', 'preventive', 'inspection']);
const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const STATUSES = new Set(['open', 'in_progress', 'waiting_parts', 'completed', 'cancelled']);

router.use(authenticateToken);

function requireTenant(req, res, next) {
  if (!req.user.tenantId) {
    return res.status(403).json({ message: 'A empresa do utilizador não está definida.' });
  }
  return next();
}

router.get('/', requireTenant, async (req, res, next) => {
  const filters = [];
  const values = [req.user.tenantId];

  for (const [queryKey, column] of [
    ['status', 'work_orders.status'],
    ['priority', 'work_orders.priority'],
    ['asset_id', 'work_orders.asset_id'],
  ]) {
    const value = req.query[queryKey];
    if (value === undefined || value === '') continue;
    if (
      typeof value !== 'string' ||
      (queryKey === 'asset_id' && !UUID_PATTERN.test(value))
    ) {
      return res.status(400).json({ message: `Filtro inválido: ${queryKey}.` });
    }

    values.push(value);
    filters.push(`${column} = $${values.length}`);
  }

  const whereFilters = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT work_orders.*,
                assets.code_tag AS asset_code_tag,
                assets.name AS asset_name,
                assets.category AS asset_category
         FROM public.work_orders AS work_orders
         JOIN public.assets AS assets
           ON assets.id = work_orders.asset_id
          AND assets.tenant_id = work_orders.tenant_id
          AND assets.deleted_at IS NULL
         WHERE work_orders.tenant_id = $1
           AND work_orders.deleted_at IS NULL
           ${whereFilters}
         ORDER BY work_orders.created_at DESC`,
        values,
      ),
    );

    return res.json({ workOrders: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', requireTenant, async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ message: 'Identificador da ordem de serviço inválido.' });
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT work_orders.*,
                assets.code_tag AS asset_code_tag,
                assets.name AS asset_name,
                assets.category AS asset_category,
                assigned_user.full_name AS assigned_to_name
         FROM public.work_orders AS work_orders
         JOIN public.assets AS assets
           ON assets.id = work_orders.asset_id
          AND assets.tenant_id = work_orders.tenant_id
         LEFT JOIN public.app_users AS assigned_user
           ON assigned_user.id = work_orders.assigned_to
          AND assigned_user.tenant_id = work_orders.tenant_id
         WHERE work_orders.id = $1
           AND work_orders.tenant_id = $2
           AND work_orders.deleted_at IS NULL`,
        [req.params.id, req.user.tenantId],
      ),
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Ordem de serviço não encontrada.' });
    }
    return res.json({ workOrder: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.post('/', requireTenant, async (req, res, next) => {
  const {
    assetId,
    title,
    description,
    orderType,
    priority,
    assignedTo,
    meterAtService,
    osNumber,
  } = req.body ?? {};

  if (
    typeof assetId !== 'string' ||
    !UUID_PATTERN.test(assetId) ||
    typeof title !== 'string' ||
    !title.trim() ||
    title.trim().length > 255 ||
    (description !== undefined && description !== null && typeof description !== 'string') ||
    !ORDER_TYPES.has(orderType) ||
    !PRIORITIES.has(priority) ||
    (assignedTo !== undefined && assignedTo !== null && (
      typeof assignedTo !== 'string' || !UUID_PATTERN.test(assignedTo)
    )) ||
    (meterAtService !== undefined && meterAtService !== null && (
      typeof meterAtService !== 'number' || !Number.isFinite(meterAtService) || meterAtService < 0
    )) ||
    (osNumber !== undefined && (
      typeof osNumber !== 'string' || !osNumber.trim() || osNumber.trim().length > 255
    ))
  ) {
    return res.status(400).json({ message: 'Dados obrigatórios da ordem de serviço inválidos.' });
  }

  try {
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const assetResult = await client.query(
        `SELECT id
         FROM public.assets
         WHERE id = $1
           AND tenant_id = $2
           AND deleted_at IS NULL
         FOR UPDATE`,
        [assetId, req.user.tenantId],
      );
      if (assetResult.rowCount === 0) return { notFound: true };

      if (assignedTo) {
        const assigneeResult = await client.query(
          'SELECT id FROM public.app_users WHERE id = $1 AND tenant_id = $2 AND is_active IS TRUE',
          [assignedTo, req.user.tenantId],
        );
        if (assigneeResult.rowCount === 0) return { invalidAssignee: true };
      }

      if (orderType === 'corrective') {
        await client.query(
          `UPDATE public.assets
           SET status = 'breakdown'
           WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
          [assetId, req.user.tenantId],
        );
      }

      const result = await client.query(
        `INSERT INTO public.work_orders (
           tenant_id, os_number, asset_id, title, description, order_type,
           priority, status, assigned_to, opened_by, meter_at_service
         )
         VALUES (
           $1, COALESCE($2, public.generate_work_order_number()), $3, $4, $5,
           $6, $7, 'open', $8, $9, $10
         )
         RETURNING *`,
        [
          req.user.tenantId,
          osNumber?.trim() ?? null,
          assetId,
          title.trim(),
          description ?? null,
          orderType,
          priority,
          assignedTo ?? null,
          req.user.id ?? null,
          meterAtService ?? null,
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
    if (error.code === '23505') {
      return res.status(409).json({ message: 'Já existe uma ordem de serviço com este número.' });
    }
    return next(error);
  }
});

router.put('/:id', requireTenant, async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ message: 'Identificador da ordem de serviço inválido.' });
  }

  const body = req.body ?? {};
  const fields = [];
  const values = [req.params.id, req.user.tenantId];
  const addField = (column, value) => {
    values.push(value);
    fields.push(`${column} = $${values.length}`);
  };

  if (body.status !== undefined) {
    if (!STATUSES.has(body.status)) {
      return res.status(400).json({ message: 'Estado da ordem de serviço inválido.' });
    }
    addField('status', body.status);
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.has(body.priority)) {
      return res.status(400).json({ message: 'Prioridade inválida.' });
    }
    addField('priority', body.priority);
  }
  if (body.assignedTo !== undefined) {
    if (
      body.assignedTo !== null
      && (typeof body.assignedTo !== 'string' || !UUID_PATTERN.test(body.assignedTo))
    ) {
      return res.status(400).json({ message: 'Técnico atribuído inválido.' });
    }
    addField('assigned_to', body.assignedTo);
  }
  if (body.resolutionNotes !== undefined) {
    if (body.resolutionNotes !== null && typeof body.resolutionNotes !== 'string') {
      return res.status(400).json({ message: 'Notas de resolução inválidas.' });
    }
    addField('resolution_notes', body.resolutionNotes);
  }
  if (body.completedAt !== undefined) {
    if (
      body.completedAt !== null &&
      (typeof body.completedAt !== 'string' || Number.isNaN(Date.parse(body.completedAt)))
    ) {
      return res.status(400).json({ message: 'Data de conclusão inválida.' });
    }
    if (body.completedAt === null && body.status === 'completed') {
      fields.push('completed_at = COALESCE(completed_at, NOW())');
    } else {
      addField('completed_at', body.completedAt);
    }
  } else if (body.status === 'completed') {
    fields.push('completed_at = COALESCE(completed_at, NOW())');
  }

  if (fields.length === 0) {
    return res.status(400).json({ message: 'Nenhum campo válido foi informado para atualização.' });
  }

  fields.push('updated_at = NOW()');

  try {
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      if (body.assignedTo) {
        const assigneeResult = await client.query(
          'SELECT id FROM public.app_users WHERE id = $1 AND tenant_id = $2 AND is_active IS TRUE',
          [body.assignedTo, req.user.tenantId],
        );
        if (assigneeResult.rowCount === 0) return { invalidAssignee: true };
      }

      const result = await client.query(
        `UPDATE public.work_orders
         SET ${fields.join(', ')}
         WHERE id = $1
           AND tenant_id = $2
           AND deleted_at IS NULL
         RETURNING *`,
        values,
      );
      return { workOrder: result.rows[0] ?? null };
    });

    if (outcome.invalidAssignee) {
      return res.status(400).json({ message: 'Responsável não encontrado neste tenant.' });
    }
    if (!outcome.workOrder) {
      return res.status(404).json({ message: 'Ordem de serviço não encontrada.' });
    }
    return res.json({ workOrder: outcome.workOrder });
  } catch (error) {
    return next(error);
  }
});

router.delete('/:id', requireTenant, async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ message: 'Identificador da ordem de serviço inválido.' });
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `UPDATE public.work_orders
         SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND deleted_at IS NULL
         RETURNING *`,
        [req.params.id, req.user.tenantId],
      ),
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Ordem de serviço não encontrada.' });
    }
    return res.json({ workOrder: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:id/close', requireTenant, requireRoles('tenant_admin', 'supervisor'), async (req, res, next) => {
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
        `SELECT id, asset_id
         FROM public.work_orders
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [req.params.id, req.user.tenantId],
      );
      const order = orderResult.rows[0];
      if (!order) return null;

      const assetResult = await client.query(
        `SELECT id FROM public.assets
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [order.asset_id, req.user.tenantId],
      );
      if (assetResult.rowCount === 0) return null;

      const updatedOrder = await client.query(
        `UPDATE public.work_orders
         SET status = 'completed',
             completed_at = COALESCE(completed_at, NOW()),
             updated_at = NOW(),
             downtime_hours = $1,
             parts_cost_mzn = $2,
             labor_cost_mzn = $3
         WHERE id = $4 AND tenant_id = $5 AND deleted_at IS NULL
         RETURNING *`,
        [downtimeHours, partsCostMzn, laborCostMzn, req.params.id, req.user.tenantId],
      );

      await client.query(
        `UPDATE public.assets
         SET status = 'operational'
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
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
