import { Router } from 'express';
import { withTenantContext } from '../db.js';
import {
  authenticateToken,
  enforceDomainScope,
  requireRoles,
} from '../middlewares/auth.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ORDER_TYPES = new Set(['corrective', 'preventive', 'inspection']);
const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const STATUSES = new Set(['open', 'in_progress', 'waiting_parts', 'blocked', 'completed', 'cancelled']);

router.use(authenticateToken, enforceDomainScope);

function requireTenant(req, res, next) {
  if (!req.user.tenantId) {
    return res.status(403).json({ message: 'A empresa do utilizador não está definida.' });
  }
  return next();
}

function isValidPartsPayload(parts) {
  return Array.isArray(parts) && parts.every((part) => (
    part !== null &&
    typeof part === 'object' &&
    typeof part.partId === 'string' &&
    UUID_PATTERN.test(part.partId) &&
    typeof part.quantity === 'number' &&
    Number.isFinite(part.quantity) &&
    part.quantity > 0
  ));
}

function normalizePartsPayload(parts) {
  if (!Array.isArray(parts)) return parts;
  return parts.map((part) => {
    if (part === null || typeof part !== 'object') return part;
    const partId = part.partId || part.part_id || part.id;
    const quantity = Number(part.quantity || 1);
    return { ...part, partId, quantity };
  });
}

async function getWorkOrderParts(client, tenantId, workOrderId, domain) {
  const result = await client.query(
    `SELECT work_order_parts.id,
            work_order_parts.work_order_id,
            work_order_parts.part_id,
            parts.name,
            parts.part_number,
            parts.unit_of_measure,
            work_order_parts.quantity,
            work_order_parts.unit_cost,
            work_order_parts.quantity * work_order_parts.unit_cost AS total_cost,
            work_order_parts.notes,
            work_order_parts.applied_by,
            work_order_parts.created_at
     FROM public.work_order_parts AS work_order_parts
     JOIN public.parts AS parts
       ON parts.id = work_order_parts.part_id
      AND parts.tenant_id = work_order_parts.tenant_id
     WHERE work_order_parts.work_order_id = $1
       AND work_order_parts.tenant_id = $2
       AND parts.domain = $3
     ORDER BY work_order_parts.created_at ASC`,
    [workOrderId, tenantId, domain],
  );
  return result.rows;
}

async function assigneeExists(client, assignedTo, tenantId) {
  const result = await client.query(
    `SELECT id::text AS id
     FROM public.technicians
     WHERE id::text = $1::text
       AND tenant_id::text = $2::text
       AND deleted_at IS NULL
     UNION
     SELECT id::text AS id
     FROM public.app_users
     WHERE id::text = $1::text
       AND tenant_id::text = $2::text
       AND is_active = true
     LIMIT 1`,
    [assignedTo, tenantId],
  );
  return result.rows.length > 0;
}

async function saveWorkOrderParts(client, {
  tenantId,
  workOrderId,
  domain,
  appliedBy,
  parts,
  replace = false,
}) {
  const preparedParts = [];
  for (const item of parts) {
    const result = await client.query(
      `SELECT id, unit_cost
       FROM public.parts
       WHERE id = $1
         AND tenant_id = $2
         AND domain = $3
         AND deleted_at IS NULL
       FOR UPDATE`,
      [item.partId, tenantId, domain],
    );
    const part = result.rows[0];
    if (!part) {
      const error = new Error('Uma peça não foi encontrada neste escopo operacional.');
      error.code = 'INVALID_WORK_ORDER_PART';
      throw error;
    }
    preparedParts.push({ ...item, unitCost: part.unit_cost });
  }

  if (replace) {
    const existingParts = await client.query(
      `SELECT part_id, SUM(quantity) AS quantity
       FROM public.work_order_parts
       WHERE work_order_id = $1
         AND tenant_id = $2
       GROUP BY part_id`,
      [workOrderId, tenantId],
    );
    for (const existing of existingParts.rows) {
      await client.query(
        `UPDATE public.parts
         SET current_stock = current_stock + $1,
             updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3`,
        [existing.quantity, existing.part_id, tenantId],
      );
    }
    await client.query(
      `DELETE FROM public.work_order_parts
       WHERE work_order_id = $1 AND tenant_id = $2`,
      [workOrderId, tenantId],
    );
  }

  for (const item of preparedParts) {
    await client.query(
      `INSERT INTO public.work_order_parts (
         tenant_id, work_order_id, part_id, quantity, unit_cost, applied_by
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, workOrderId, item.partId, item.quantity, item.unitCost, appliedBy],
    );
  }

  return { parts: await getWorkOrderParts(client, tenantId, workOrderId, domain) };
}

router.get('/', requireTenant, async (req, res, next) => {
  const { id: userId, role, tenantId } = req.user;
  const filters = [];
  const values = [tenantId];
  if (req.userScope) {
    values.push(req.userScope);
    filters.push(`(assets.domain = $${values.length} OR work_orders.domain = $${values.length})`);
  }

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

  try {
    const result = await withTenantContext(tenantId, role, async (client) => {
      const queryFilters = [...filters];
      const queryValues = [...values];

      if (role === 'technician') {
        const technicianResult = await client.query(
          `SELECT id
           FROM public.technicians
           WHERE user_id = $1
             AND tenant_id = $2
             AND deleted_at IS NULL
             ${req.userScope ? 'AND domain = $3' : ''}
           LIMIT 1`,
          req.userScope ? [userId, tenantId, req.userScope] : [userId, tenantId],
        );
        const technicianId = technicianResult.rows[0]?.id;
        if (!technicianId) return { rows: [] };

        queryValues.push(userId, technicianId);
        queryFilters.push(
          `(work_orders.assigned_to = $${queryValues.length - 1}
            OR work_orders.assigned_to = $${queryValues.length}
            OR (work_orders.assigned_to IS NULL AND work_orders.status = 'open'))`,
        );
      }

      const whereFilters = queryFilters.length > 0
        ? `AND ${queryFilters.join(' AND ')}`
        : '';

      return client.query(
        `SELECT work_orders.*,
                to_jsonb(assets) AS asset,
                to_jsonb(assigned_technician) AS technician,
                assigned_user.full_name AS assigned_to_name
         FROM public.work_orders AS work_orders
         JOIN public.assets AS assets
           ON assets.id = work_orders.asset_id
           AND assets.tenant_id = work_orders.tenant_id
           AND assets.deleted_at IS NULL
         LEFT JOIN public.app_users AS assigned_user
           ON assigned_user.id = work_orders.assigned_to
          AND assigned_user.tenant_id = work_orders.tenant_id
         LEFT JOIN public.technicians AS assigned_technician
           ON (
             assigned_technician.user_id = work_orders.assigned_to
             OR assigned_technician.id = work_orders.assigned_to
           )
          AND assigned_technician.tenant_id = work_orders.tenant_id
          AND assigned_technician.deleted_at IS NULL
          ${req.userScope ? 'AND assigned_technician.domain = $2' : ''}
         WHERE work_orders.tenant_id = $1
           AND work_orders.deleted_at IS NULL
           ${whereFilters}
         ORDER BY work_orders.created_at DESC`,
        queryValues,
      );
    });

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
    const workOrder = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const result = await client.query(
        `SELECT work_orders.*,
                assets.code_tag AS asset_code_tag,
                assets.name AS asset_name,
                assets.category AS asset_category,
                assigned_user.full_name AS assigned_to_name
         FROM public.work_orders AS work_orders
         JOIN public.assets AS assets
           ON assets.id = work_orders.asset_id
          AND assets.tenant_id = work_orders.tenant_id
          ${req.userScope ? 'AND assets.domain = $3' : ''}
         LEFT JOIN public.app_users AS assigned_user
           ON assigned_user.id = work_orders.assigned_to
          AND assigned_user.tenant_id = work_orders.tenant_id
         WHERE work_orders.id = $1
           AND work_orders.tenant_id = $2
           AND work_orders.deleted_at IS NULL
           ${req.userScope ? 'AND work_orders.domain = $3' : ''}`,
        req.userScope
          ? [req.params.id, req.user.tenantId, req.userScope]
          : [req.params.id, req.user.tenantId],
      );

      const order = result.rows[0];
      if (!order) return null;
      order.parts = await getWorkOrderParts(
        client,
        req.user.tenantId,
        order.id,
        order.domain,
      );
      return order;
    });

    if (!workOrder) {
      return res.status(404).json({ message: 'Ordem de serviço não encontrada.' });
    }
    return res.json({ workOrder });
  } catch (error) {
    return next(error);
  }
});

async function handleWorkOrderTransition(req, res, next) {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ message: 'Identificador da ordem de serviço inválido.' });
  }

  const { eventType, reason, justification, meterAtService } = req.body ?? {};
  const transition = {
    start: { status: 'in_progress', allowedFrom: ['open', 'assigned'] },
    pause: { status: 'waiting_parts', allowedFrom: ['in_progress'] },
    resume: { status: 'in_progress', allowedFrom: ['waiting_parts', 'blocked'] },
    interrupt: { status: 'blocked', allowedFrom: ['in_progress'] },
    complete: { status: 'completed', allowedFrom: ['in_progress', 'waiting_parts', 'blocked'] },
  }[eventType];

  if (!transition) {
    return res.status(400).json({ message: 'Tipo de transição inválido.' });
  }
  if (req.user.role === 'technician' && eventType === 'interrupt') {
    return res.status(403).json({ message: 'Técnicos não podem interromper ordens de serviço.' });
  }
  if (
    (eventType === 'pause' || eventType === 'interrupt') &&
    (typeof reason !== 'string' || !reason.trim() ||
      typeof justification !== 'string' || !justification.trim())
  ) {
    return res.status(400).json({
      message: 'Motivo e justificação são obrigatórios para pausar ou interromper a ordem de serviço.',
    });
  }
  if (
    (reason !== undefined && reason !== null && typeof reason !== 'string') ||
    (justification !== undefined && justification !== null && typeof justification !== 'string') ||
    (meterAtService !== undefined && meterAtService !== null && (
      typeof meterAtService !== 'number' || !Number.isFinite(meterAtService) || meterAtService < 0
    ))
  ) {
    return res.status(400).json({ message: 'Dados da transição inválidos.' });
  }

  try {
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const orderResult = await client.query(
        `SELECT id, status, assigned_to
         FROM public.work_orders
         WHERE id = $1
           AND tenant_id = $2
           AND deleted_at IS NULL
           ${req.userScope ? 'AND domain = $3' : ''}
         FOR UPDATE`,
        req.userScope
          ? [req.params.id, req.user.tenantId, req.userScope]
          : [req.params.id, req.user.tenantId],
      );
      const order = orderResult.rows[0];
      if (!order) return { notFound: true };
      if (req.user.role === 'technician') {
        const technicianResult = await client.query(
          `SELECT id
           FROM public.technicians
           WHERE user_id = $1
             AND tenant_id = $2
             AND deleted_at IS NULL
           LIMIT 1`,
          [req.user.id, req.user.tenantId],
        );
        const technicianId = technicianResult.rows[0]?.id;
        if (
          !technicianId ||
          (order.assigned_to !== req.user.id && order.assigned_to !== technicianId)
        ) {
          return { forbidden: true };
        }
      }
      if (!transition.allowedFrom.includes(order.status)) {
        return { invalidTransition: true, currentStatus: order.status };
      }

      await client.query(
        `UPDATE public.work_orders
         SET status = $1::text::varchar,
             started_at = CASE
               WHEN $1::text = 'in_progress'::text AND $4::text = 'start'::text
                 THEN COALESCE(started_at, NOW())
               ELSE started_at
             END,
             completed_at = CASE
               WHEN $1::text = 'completed'::text THEN NOW()
               ELSE completed_at
             END,
             meter_at_service = COALESCE($5, meter_at_service),
             updated_at = NOW()
         WHERE id::text = $2::text
           AND tenant_id::text = $3::text
           AND deleted_at IS NULL
           ${req.userScope ? 'AND domain = $6' : ''}`,
        [
          transition.status,
          req.params.id,
          req.user.tenantId,
          eventType,
          meterAtService ?? null,
          ...(req.userScope ? [req.userScope] : []),
        ],
      );

      await client.query(
        `INSERT INTO public.work_order_events (
           tenant_id, work_order_id, user_id, event_type, reason, justification, meter_at_service
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.user.tenantId,
          req.params.id,
          req.user.id,
          eventType,
          reason?.trim() || null,
          justification?.trim() || null,
          meterAtService ?? null,
        ],
      );

      return { status: transition.status };
    });

    if (outcome.notFound) {
      return res.status(404).json({ message: 'Ordem de serviço não encontrada.' });
    }
    if (outcome.forbidden) {
      return res.status(403).json({ message: 'Só pode executar transições em ordens atribuídas a si.' });
    }
    if (outcome.invalidTransition) {
      return res.status(409).json({
        message: `Transição não permitida a partir do estado "${outcome.currentStatus}".`,
      });
    }
    return res.status(200).json({
      message: 'Transição registada com sucesso.',
      status: outcome.status,
    });
  } catch (error) {
    return next(error);
  }
}

function transitionAlias(eventType) {
  return (req, res, next) => {
    req.body = { ...(req.body ?? {}), eventType };
    return handleWorkOrderTransition(req, res, next);
  };
}

router.post('/:id/transitions', requireTenant, handleWorkOrderTransition);
router.post('/:id/start', requireTenant, transitionAlias('start'));
router.post('/:id/pause', requireTenant, transitionAlias('pause'));
router.post('/:id/resume', requireTenant, transitionAlias('resume'));

router.get('/:id/timeline', requireTenant, async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ message: 'Identificador da ordem de serviço inválido.' });
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const orderResult = await client.query(
        `SELECT id
         FROM public.work_orders
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
           ${req.userScope ? 'AND domain = $3' : ''}`,
        req.userScope
          ? [req.params.id, req.user.tenantId, req.userScope]
          : [req.params.id, req.user.tenantId],
      );
      if (orderResult.rowCount === 0) return null;

      const eventsResult = await client.query(
        `SELECT events.*,
                users.full_name AS user_name
         FROM public.work_order_events AS events
         JOIN public.work_orders AS scoped_order
           ON scoped_order.id = events.work_order_id
          AND scoped_order.tenant_id = events.tenant_id
          AND scoped_order.deleted_at IS NULL
         LEFT JOIN public.app_users AS users
           ON users.id = events.user_id
          AND users.tenant_id = events.tenant_id
         WHERE events.work_order_id = $1
           AND events.tenant_id = $2
           ${req.userScope ? 'AND scoped_order.domain = $3' : ''}
         ORDER BY events.created_at ASC, events.id ASC`,
        req.userScope
          ? [req.params.id, req.user.tenantId, req.userScope]
          : [req.params.id, req.user.tenantId],
      );
      return eventsResult.rows;
    });

    if (result === null) {
      return res.status(404).json({ message: 'Ordem de serviço não encontrada.' });
    }
    return res.json({ events: result });
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
    parts,
  } = req.body ?? {};
  const normalizedParts = parts === undefined ? undefined : normalizePartsPayload(parts);

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
    )) ||
    (parts !== undefined && !isValidPartsPayload(normalizedParts))
  ) {
    return res.status(400).json({ message: 'Dados obrigatórios da ordem de serviço inválidos.' });
  }

  try {
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const assetResult = await client.query(
        `SELECT id, domain
         FROM public.assets
         WHERE id = $1
           AND tenant_id = $2
           AND deleted_at IS NULL
           ${req.userScope ? 'AND domain = $3' : ''}
         FOR UPDATE`,
        req.userScope
          ? [assetId, req.user.tenantId, req.userScope]
          : [assetId, req.user.tenantId],
      );
      if (assetResult.rowCount === 0) return { notFound: true };

      if (assignedTo) {
        if (!(await assigneeExists(client, assignedTo, req.user.tenantId))) {
          return { invalidAssignee: true };
        }
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
           priority, status, assigned_to, opened_by, meter_at_service, domain
         )
         VALUES (
           $1, COALESCE($2, public.generate_work_order_number()), $3, $4, $5,
           $6, $7, 'open', $8, $9, $10, $11
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
          assetResult.rows[0].domain,
        ],
      );

      const workOrder = result.rows[0];
      if (normalizedParts?.length) {
        const savedParts = await saveWorkOrderParts(client, {
          tenantId: req.user.tenantId,
          workOrderId: workOrder.id,
          domain: workOrder.domain,
          appliedBy: req.user.id,
          parts: normalizedParts,
        });
        workOrder.parts = savedParts.parts;
      } else {
        workOrder.parts = [];
      }
      return { workOrder };
    });

    if (outcome.notFound) {
      return res.status(404).json({ message: 'Ativo não encontrado neste tenant.' });
    }
    if (outcome.invalidAssignee) {
      return res.status(400).json({ error: 'Responsável não encontrado neste tenant.' });
    }
    return res.status(201).json({ workOrder: outcome.workOrder });
  } catch (error) {
    if (error.code === 'INVALID_WORK_ORDER_PART') {
      return res.status(400).json({ message: 'Uma ou mais peças não foram encontradas neste escopo operacional.' });
    }
    if (error.code === '23505') {
      return res.status(409).json({ message: 'Já existe uma ordem de serviço com este número.' });
    }
    return next(error);
  }
});

async function updateWorkOrder(req, res, next) {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ message: 'Identificador da ordem de serviço inválido.' });
  }

  const body = req.body ?? {};
  const normalizedParts = body.parts === undefined ? undefined : normalizePartsPayload(body.parts);
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
  if (body.title !== undefined) {
    if (
      typeof body.title !== 'string' ||
      !body.title.trim() ||
      body.title.trim().length > 255
    ) {
      return res.status(400).json({ message: 'Título da ordem de serviço inválido.' });
    }
    addField('title', body.title.trim());
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      return res.status(400).json({ message: 'Descrição da ordem de serviço inválida.' });
    }
    addField('description', body.description);
  }
  if (body.meterAtService !== undefined) {
    if (
      body.meterAtService !== null &&
      (typeof body.meterAtService !== 'number' ||
        !Number.isFinite(body.meterAtService) ||
        body.meterAtService < 0)
    ) {
      return res.status(400).json({ message: 'Leitura do contador inválida.' });
    }
    addField('meter_at_service', body.meterAtService);
  }
  if (body.assignedTo !== undefined) {
    const assignedTo = body.assignedTo || null;
    if (
      assignedTo !== null
      && (typeof assignedTo !== 'string' || !UUID_PATTERN.test(assignedTo))
    ) {
      return res.status(400).json({ message: 'Técnico atribuído inválido.' });
    }
    addField('assigned_to', assignedTo);
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

  if (body.parts !== undefined && !isValidPartsPayload(normalizedParts)) {
    return res.status(400).json({ message: 'Lista de peças inválida.' });
  }
  const shouldSyncParts = body.parts !== undefined;
  if (fields.length === 0 && !shouldSyncParts) {
    return res.status(400).json({ message: 'Nenhum campo válido foi informado para atualização.' });
  }

  if (fields.length > 0 || shouldSyncParts) fields.push('updated_at = NOW()');
  if (req.userScope) values.push(req.userScope);
  const scopeClause = req.userScope ? `AND domain = $${values.length}` : '';

  try {
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      if (body.assignedTo) {
        if (!(await assigneeExists(client, body.assignedTo, req.user.tenantId))) {
          return { invalidAssignee: true };
        }
      }

      const result = await client.query(
        `UPDATE public.work_orders
         SET ${fields.join(', ')}
         WHERE id = $1
           AND tenant_id = $2
           AND deleted_at IS NULL
           ${scopeClause}
         RETURNING *`,
        values,
      );
      const workOrder = result.rows[0];
      if (!workOrder) return { workOrder: null };

      if (shouldSyncParts) {
        const savedParts = await saveWorkOrderParts(client, {
          tenantId: req.user.tenantId,
          workOrderId: workOrder.id,
          domain: workOrder.domain,
          appliedBy: req.user.id,
          parts: normalizedParts,
          replace: true,
        });
        workOrder.parts = savedParts.parts;
      } else {
        workOrder.parts = await getWorkOrderParts(
          client,
          req.user.tenantId,
          workOrder.id,
          workOrder.domain,
        );
      }
      return { workOrder };
    });

    if (outcome.invalidAssignee) {
      return res.status(400).json({ error: 'Responsável não encontrado neste tenant.' });
    }
    if (!outcome.workOrder) {
      return res.status(404).json({ message: 'Ordem de serviço não encontrada.' });
    }
    return res.json({ workOrder: outcome.workOrder });
  } catch (error) {
    if (error.code === 'INVALID_WORK_ORDER_PART') {
      return res.status(400).json({ message: 'Uma ou mais peças não foram encontradas neste escopo operacional.' });
    }
    return next(error);
  }
}

router.put('/:id', requireTenant, updateWorkOrder);
router.patch('/:id', requireTenant, updateWorkOrder);

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
           ${req.userScope ? 'AND domain = $3' : ''}
         RETURNING *`,
        req.userScope
          ? [req.params.id, req.user.tenantId, req.userScope]
          : [req.params.id, req.user.tenantId],
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

router.get('/:id/parts', requireTenant, async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ message: 'Identificador da ordem de serviço inválido.' });
  }

  try {
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const orderResult = await client.query(
        `SELECT id
         FROM public.work_orders
         WHERE id = $1
           AND tenant_id = $2
           AND deleted_at IS NULL
           ${req.userScope ? 'AND domain = $3' : ''}`,
        req.userScope
          ? [req.params.id, req.user.tenantId, req.userScope]
          : [req.params.id, req.user.tenantId],
      );
      if (orderResult.rowCount === 0) return null;

      return client.query(
        `SELECT work_order_parts.id,
                work_order_parts.work_order_id,
                work_order_parts.part_id,
                parts.name,
                parts.part_number,
                parts.unit_of_measure,
                work_order_parts.quantity,
                work_order_parts.unit_cost,
                work_order_parts.quantity * work_order_parts.unit_cost AS total_cost,
                work_order_parts.notes,
                work_order_parts.applied_by,
                work_order_parts.created_at
         FROM public.work_order_parts AS work_order_parts
         JOIN public.parts AS parts
           ON parts.id = work_order_parts.part_id
          AND parts.tenant_id = work_order_parts.tenant_id
         WHERE work_order_parts.work_order_id = $1
           AND work_order_parts.tenant_id = $2
           ${req.userScope ? 'AND parts.domain = $3' : ''}
         ORDER BY work_order_parts.created_at ASC`,
        req.userScope
          ? [req.params.id, req.user.tenantId, req.userScope]
          : [req.params.id, req.user.tenantId],
      );
    });

    if (!outcome) {
      return res.status(404).json({ message: 'Ordem de serviço não encontrada.' });
    }
    return res.json({ parts: outcome.rows });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/:id/parts',
  requireTenant,
  requireRoles('technician', 'supervisor', 'tenant_admin'),
  async (req, res, next) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ message: 'Identificador da ordem de serviço inválido.' });
    }

    const { partId, quantity, notes } = req.body ?? {};
    if (
      typeof partId !== 'string' || !UUID_PATTERN.test(partId) ||
      typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 ||
      (notes !== undefined && notes !== null && typeof notes !== 'string')
    ) {
      return res.status(400).json({ message: 'Dados da peça aplicada inválidos.' });
    }

    try {
      const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
        const orderResult = await client.query(
          `SELECT id, assigned_to, domain
           FROM public.work_orders
           WHERE id = $1
             AND tenant_id = $2
             AND deleted_at IS NULL
             ${req.userScope ? 'AND domain = $3' : ''}
           FOR UPDATE`,
          req.userScope
            ? [req.params.id, req.user.tenantId, req.userScope]
            : [req.params.id, req.user.tenantId],
        );
        const order = orderResult.rows[0];
        if (!order) return { notFound: true };

        if (req.user.role === 'technician') {
          const technicianResult = await client.query(
            `SELECT id
             FROM public.technicians
             WHERE user_id = $1
               AND tenant_id = $2
               AND deleted_at IS NULL
               ${req.userScope ? 'AND domain = $3' : ''}
             LIMIT 1`,
            req.userScope
              ? [req.user.id, req.user.tenantId, req.userScope]
              : [req.user.id, req.user.tenantId],
          );
          const technicianId = technicianResult.rows[0]?.id;
          if (
            !technicianId ||
            (order.assigned_to !== req.user.id && order.assigned_to !== technicianId)
          ) {
            return { forbidden: true };
          }
        }

        const partResult = await client.query(
          `SELECT id, name, part_number, unit_of_measure, unit_cost
           FROM public.parts
           WHERE id = $1
             AND tenant_id = $2
             AND deleted_at IS NULL
             AND domain = $3`,
          [partId, req.user.tenantId, order.domain],
        );
        const part = partResult.rows[0];
        if (!part) return { invalidPart: true };

        const appliedResult = await client.query(
          `INSERT INTO public.work_order_parts (
             tenant_id, work_order_id, part_id, quantity, unit_cost, applied_by, notes
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *, quantity * unit_cost AS total_cost`,
          [
            req.user.tenantId,
            order.id,
            part.id,
            quantity,
            part.unit_cost,
            req.user.id,
            notes?.trim() || null,
          ],
        );
        const applied = appliedResult.rows[0];
        return {
          part: {
            ...applied,
            name: part.name,
            part_number: part.part_number,
            unit_of_measure: part.unit_of_measure,
          },
        };
      });

      if (outcome.notFound) {
        return res.status(404).json({ message: 'Ordem de serviço não encontrada.' });
      }
      if (outcome.forbidden) {
        return res.status(403).json({ message: 'A ordem de serviço não está atribuída a este técnico.' });
      }
      if (outcome.invalidPart) {
        return res.status(404).json({ message: 'Peça não encontrada neste escopo operacional.' });
      }
      return res.status(201).json({ part: outcome.part });
    } catch (error) {
      return next(error);
    }
  },
);

async function closeWorkOrder(req, res, next) {
  const body = req.body ?? {};
  const downtimeHours = body.downtime_hours || body.downtimeHours || 0;
  const partsCostMzn = body.parts_cost_mzn || body.partsCostMzn ||
    body.parts_cost || body.partsCost || 0;
  const laborCostMzn = body.labor_cost_mzn || body.laborCostMzn ||
    body.labor_cost || body.laborCost || 0;
  const resolutionNotes = body.resolution_notes || body.resolutionNotes || body.notes || '';

  if (
    [downtimeHours, partsCostMzn, laborCostMzn].some(
      (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0,
    ) ||
    typeof resolutionNotes !== 'string'
  ) {
    return res.status(400).json({
      message: 'Horas de inatividade e custos devem ser números não negativos e as notas devem ser texto.',
    });
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const orderResult = await client.query(
        `SELECT id, asset_id, domain
         FROM public.work_orders
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
           ${req.userScope ? 'AND domain = $3' : ''}
         FOR UPDATE`,
        req.userScope
          ? [req.params.id, req.user.tenantId, req.userScope]
          : [req.params.id, req.user.tenantId],
      );
      const order = orderResult.rows[0];
      if (!order) return null;

      const assetResult = await client.query(
        `SELECT id FROM public.assets
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
           ${req.userScope ? 'AND domain = $3' : ''}
         FOR UPDATE`,
        req.userScope
          ? [order.asset_id, req.user.tenantId, req.userScope]
          : [order.asset_id, req.user.tenantId],
      );
      if (assetResult.rowCount === 0) return null;

      const updatedOrder = await client.query(
        `UPDATE public.work_orders
         SET status = 'completed',
             completed_at = NOW(),
             updated_at = NOW(),
             downtime_hours = $1,
             parts_cost_mzn = $2,
             labor_cost_mzn = $3,
             parts_cost = $2,
             labor_cost = $3,
             total_cost = $2 + $3,
             total_cost_mzn = $2 + $3,
             resolution_notes = $4
         WHERE id = $5 AND tenant_id = $6 AND deleted_at IS NULL
           ${req.userScope ? 'AND domain = $7' : ''}
         RETURNING *`,
        req.userScope
          ? [
              downtimeHours,
              partsCostMzn,
              laborCostMzn,
              resolutionNotes,
              req.params.id,
              req.user.tenantId,
              req.userScope,
            ]
          : [
              downtimeHours,
              partsCostMzn,
              laborCostMzn,
              resolutionNotes,
              req.params.id,
              req.user.tenantId,
            ],
      );

      await client.query(
        `UPDATE public.assets
         SET status = 'operational'
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
           ${req.userScope ? 'AND domain = $3' : ''}`,
        req.userScope
          ? [order.asset_id, req.user.tenantId, req.userScope]
          : [order.asset_id, req.user.tenantId],
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
}

router.patch(
  '/:id/close',
  requireTenant,
  requireRoles('tenant_admin', 'supervisor'),
  closeWorkOrder,
);
router.post(
  '/:id/complete',
  requireTenant,
  requireRoles('tenant_admin', 'supervisor'),
  closeWorkOrder,
);

export default router;
