import { Router } from 'express';
import { withTenantContext } from '../db.js';
import {
  authenticateToken,
  enforceDomainScope,
  requireRoles,
} from '../middlewares/auth.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const TRIGGER_TYPES = new Set(['time', 'meter', 'both']);
const PLAN_MANAGERS = ['tenant_admin', 'supervisor'];

router.use(authenticateToken, enforceDomainScope);

function requireTenant(req, res, next) {
  if (!req.user.tenantId) {
    return res.status(403).json({ error: 'A empresa do utilizador não está definida.' });
  }
  return next();
}

function validChecklistItems(items) {
  return Array.isArray(items)
    && items.length <= 100
    && items.every((item) => (
      (typeof item === 'string' && item.trim().length > 0)
      || (
        item !== null
        && typeof item === 'object'
        && !Array.isArray(item)
        && typeof item.title === 'string'
        && item.title.trim().length > 0
      )
    ));
}

function validatePlanFields(plan) {
  return typeof plan.title === 'string'
    && plan.title.trim().length > 0
    && plan.title.trim().length <= 255
    && typeof plan.asset_id === 'string'
    && UUID_PATTERN.test(plan.asset_id)
    && TRIGGER_TYPES.has(plan.trigger_type)
    && (
      plan.interval_days === undefined
      || plan.interval_days === null
      || (Number.isInteger(plan.interval_days) && plan.interval_days > 0)
    )
    && (
      plan.interval_meter === undefined
      || plan.interval_meter === null
      || (typeof plan.interval_meter === 'number'
        && Number.isFinite(plan.interval_meter)
        && plan.interval_meter > 0)
    )
    && (
      !['time', 'both'].includes(plan.trigger_type)
      || (Number.isInteger(plan.interval_days) && plan.interval_days > 0)
    )
    && (
      !['meter', 'both'].includes(plan.trigger_type)
      || (typeof plan.interval_meter === 'number'
        && Number.isFinite(plan.interval_meter)
        && plan.interval_meter > 0)
    )
    && (plan.checklist_items === undefined || validChecklistItems(plan.checklist_items))
    && (
      plan.assigned_technician_id === undefined
      || plan.assigned_technician_id === null
      || (typeof plan.assigned_technician_id === 'string'
        && UUID_PATTERN.test(plan.assigned_technician_id))
    );
}

async function getAsset(client, req, assetId) {
  const result = await client.query(
    `SELECT id, domain, operational_scope, current_meter
     FROM public.assets
     WHERE id = $1::uuid
       AND tenant_id = $2::uuid
       AND deleted_at IS NULL
       AND ($3 = 'all' OR domain = $3 OR operational_scope = $3)
     FOR SHARE`,
    [assetId, req.user.tenantId, req.userScope],
  );
  return result.rows[0] ?? null;
}

async function assigneeExists(client, req, assigneeId) {
  if (!assigneeId) return true;
  const result = await client.query(
    `SELECT id
     FROM public.app_users
     WHERE id = $1::uuid
       AND tenant_id = $2::uuid
       AND operational_scope = $3
       AND is_active IS TRUE
     UNION
     SELECT id
     FROM public.technicians
     WHERE id = $1::uuid
       AND tenant_id = $2::uuid
       AND domain = $3
       AND status = 'active'
       AND deleted_at IS NULL
     LIMIT 1`,
    [assigneeId, req.user.tenantId, req.userScope],
  );
  return result.rowCount > 0;
}

router.get('/', requireTenant, async (req, res, next) => {
  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT plans.*,
                assets.name AS asset_name,
                assets.code_tag AS asset_code,
                COALESCE(technicians.name, assigned_users.full_name) AS assigned_technician_name
         FROM public.maintenance_plans AS plans
         LEFT JOIN public.assets AS assets
           ON assets.id = plans.asset_id
          AND assets.tenant_id = plans.tenant_id
          AND assets.deleted_at IS NULL
         LEFT JOIN public.technicians AS technicians
           ON technicians.id = plans.assigned_technician_id
          AND technicians.tenant_id = plans.tenant_id
          AND technicians.deleted_at IS NULL
         LEFT JOIN public.app_users AS assigned_users
           ON assigned_users.id = plans.assigned_technician_id
          AND assigned_users.tenant_id = plans.tenant_id
         WHERE plans.tenant_id = $1::uuid
           AND plans.deleted_at IS NULL
           AND ($2 = 'all' OR plans.domain = $2)
         ORDER BY plans.created_at DESC`,
        [req.user.tenantId, req.userScope],
      ),
    );
    return res.json({ plans: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/',
  requireTenant,
  requireRoles(...PLAN_MANAGERS),
  async (req, res, next) => {
    const plan = req.body ?? {};
    if (!validatePlanFields(plan)) {
      return res.status(400).json({ error: 'Dados do plano de manutenção inválidos.' });
    }

    try {
      const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
        const asset = await getAsset(client, req, plan.asset_id);
        if (!asset) return { assetNotFound: true };
        if (!(await assigneeExists(client, req, plan.assigned_technician_id))) {
          return { invalidAssignee: true };
        }
        const result = await client.query(
          `INSERT INTO public.maintenance_plans (
             tenant_id, asset_id, domain, title, trigger_type, interval_days,
             interval_meter, checklist_items, assigned_technician_id,
             next_due_at, next_due_meter
           )
           VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid,
             CASE WHEN $5 IN ('time', 'both')
               THEN CURRENT_DATE + $6::integer ELSE NULL END,
             CASE WHEN $5 IN ('meter', 'both')
               THEN COALESCE($10::numeric, 0) + $7::numeric ELSE NULL END
           )
           RETURNING *`,
          [
            req.user.tenantId,
            asset.id,
            asset.domain,
            plan.title.trim(),
            plan.trigger_type,
            plan.interval_days ?? null,
            plan.interval_meter ?? null,
            JSON.stringify(plan.checklist_items ?? []),
            plan.assigned_technician_id ?? null,
            asset.current_meter,
          ],
        );
        return { plan: result.rows[0] };
      });

      if (outcome.assetNotFound) {
        return res.status(404).json({ error: 'Ativo não encontrado neste escopo operacional.' });
      }
      if (outcome.invalidAssignee) {
        return res.status(400).json({ error: 'Técnico inválido ou indisponível neste escopo.' });
      }
      return res.status(201).json({ plan: outcome.plan });
    } catch (error) {
      return next(error);
    }
  },
);

router.put(
  '/:id',
  requireTenant,
  requireRoles(...PLAN_MANAGERS),
  async (req, res, next) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ error: 'Identificador do plano inválido.' });
    }
    const input = req.body ?? {};

    try {
      const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
        const currentResult = await client.query(
          `SELECT *
           FROM public.maintenance_plans
           WHERE id = $1::uuid
             AND tenant_id = $2::uuid
             AND deleted_at IS NULL
             AND ($3 = 'all' OR domain = $3)
           FOR UPDATE`,
          [req.params.id, req.user.tenantId, req.userScope],
        );
        const current = currentResult.rows[0];
        if (!current) return { notFound: true };

        const updated = {
          title: input.title ?? current.title,
          asset_id: input.asset_id ?? current.asset_id,
          trigger_type: input.trigger_type ?? current.trigger_type,
          interval_days: input.interval_days ?? current.interval_days,
          interval_meter: input.interval_meter ?? current.interval_meter,
          checklist_items: input.checklist_items ?? current.checklist_items,
          assigned_technician_id: input.assigned_technician_id === undefined
            ? current.assigned_technician_id
            : input.assigned_technician_id,
        };
        if (!validatePlanFields(updated)) return { invalid: true };

        const asset = await getAsset(client, req, updated.asset_id);
        if (!asset) return { assetNotFound: true };
        if (!(await assigneeExists(client, req, updated.assigned_technician_id))) {
          return { invalidAssignee: true };
        }

        const result = await client.query(
          `UPDATE public.maintenance_plans
           SET asset_id = $1::uuid,
               domain = $2,
               title = $3,
               trigger_type = $4,
               interval_days = $5,
               interval_meter = $6,
               checklist_items = $7::jsonb,
               assigned_technician_id = $8::uuid,
               next_due_at = CASE WHEN $4 IN ('time', 'both')
                 THEN CURRENT_DATE + $5::integer ELSE NULL END,
               next_due_meter = CASE WHEN $4 IN ('meter', 'both')
                 THEN COALESCE($9::numeric, 0) + $6::numeric ELSE NULL END,
               updated_at = NOW()
           WHERE id = $10::uuid
             AND tenant_id = $11::uuid
           RETURNING *`,
          [
            asset.id,
            asset.domain,
            updated.title.trim(),
            updated.trigger_type,
            updated.interval_days ?? null,
            updated.interval_meter ?? null,
            JSON.stringify(updated.checklist_items),
            updated.assigned_technician_id,
            asset.current_meter,
            req.params.id,
            req.user.tenantId,
          ],
        );
        return { plan: result.rows[0] };
      });

      if (outcome.notFound) return res.status(404).json({ error: 'Plano não encontrado.' });
      if (outcome.invalid) return res.status(400).json({ error: 'Dados do plano inválidos.' });
      if (outcome.assetNotFound) {
        return res.status(404).json({ error: 'Ativo não encontrado neste escopo operacional.' });
      }
      if (outcome.invalidAssignee) {
        return res.status(400).json({ error: 'Técnico inválido ou indisponível neste escopo.' });
      }
      return res.json({ plan: outcome.plan });
    } catch (error) {
      return next(error);
    }
  },
);

router.patch(
  '/:id/toggle',
  requireTenant,
  requireRoles(...PLAN_MANAGERS),
  async (req, res, next) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ error: 'Identificador do plano inválido.' });
    }
    try {
      const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
        client.query(
          `UPDATE public.maintenance_plans
           SET is_active = NOT is_active,
               updated_at = NOW()
           WHERE id = $1::uuid
             AND tenant_id = $2::uuid
             AND deleted_at IS NULL
             AND ($3 = 'all' OR domain = $3)
           RETURNING *`,
          [req.params.id, req.user.tenantId, req.userScope],
        ),
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Plano não encontrado.' });
      return res.json({ plan: result.rows[0] });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/:id/generate-wo',
  requireTenant,
  requireRoles('tenant_admin', 'supervisor', 'technician'),
  async (req, res, next) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ error: 'Identificador do plano inválido.' });
    }
    const automatic = req.body?.automatic ?? false;
    if (typeof automatic !== 'boolean') {
      return res.status(400).json({ error: 'O campo automatic deve ser booleano.' });
    }

    try {
      const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
        const result = await client.query(
          `SELECT plans.*,
                  assets.current_meter,
                  assets.domain AS asset_domain
           FROM public.maintenance_plans AS plans
           JOIN public.assets AS assets
             ON assets.id = plans.asset_id
            AND assets.tenant_id = plans.tenant_id
            AND assets.deleted_at IS NULL
           WHERE plans.id = $1::uuid
             AND plans.tenant_id = $2::uuid
             AND plans.deleted_at IS NULL
             AND ($3 = 'all' OR plans.domain = $3)
           FOR UPDATE OF plans`,
          [req.params.id, req.user.tenantId, req.userScope],
        );
        const plan = result.rows[0];
        if (!plan) return { notFound: true };
        if (automatic) {
          const timeDue = plan.next_due_at
            && new Date(plan.next_due_at).getTime() <= Date.now();
          const meterDue = plan.next_due_meter !== null
            && Number(plan.current_meter ?? 0) >= Number(plan.next_due_meter);
          if (!plan.is_active || !(timeDue || meterDue)) return { notDue: true };
        }

        const orderResult = await client.query(
          `INSERT INTO public.work_orders (
             tenant_id, asset_id, title, description, order_type, priority, status,
             assigned_to, opened_by, meter_at_service, domain, checklist_items
           )
           VALUES (
             $1::uuid, $2::uuid, $3, $4, 'preventive', 'medium', 'open',
             $5::uuid, $6::uuid, $7::numeric, $8, $9::jsonb
           )
           RETURNING *`,
          [
            req.user.tenantId,
            plan.asset_id,
            plan.title,
            `Ordem preventiva gerada pelo plano ${plan.title}.`,
            plan.assigned_technician_id,
            req.user.id,
            plan.current_meter,
            plan.asset_domain,
            JSON.stringify(plan.checklist_items),
          ],
        );
        await client.query(
          `UPDATE public.maintenance_plans
           SET last_generated_at = NOW(),
               last_work_order_id = $1::uuid,
               next_due_at = CASE WHEN trigger_type IN ('time', 'both')
                 THEN CURRENT_DATE + interval_days ELSE NULL END,
               next_due_meter = CASE WHEN trigger_type IN ('meter', 'both')
                 THEN COALESCE($2::numeric, 0) + interval_meter ELSE NULL END,
               updated_at = NOW()
           WHERE id = $3::uuid
             AND tenant_id = $4::uuid`,
          [orderResult.rows[0].id, plan.current_meter, plan.id, req.user.tenantId],
        );
        return { workOrder: orderResult.rows[0] };
      });

      if (outcome.notFound) return res.status(404).json({ error: 'Plano não encontrado.' });
      if (outcome.notDue) {
        return res.status(409).json({ error: 'O plano está pausado ou ainda não atingiu o próximo disparo.' });
      }
      return res.status(201).json({ workOrder: outcome.workOrder });
    } catch (error) {
      return next(error);
    }
  },
);

router.delete(
  '/:id',
  requireTenant,
  requireRoles(...PLAN_MANAGERS),
  async (req, res, next) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ error: 'Identificador do plano inválido.' });
    }
    try {
      const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
        client.query(
          `UPDATE public.maintenance_plans
           SET deleted_at = NOW(),
               is_active = FALSE,
               updated_at = NOW()
           WHERE id = $1::uuid
             AND tenant_id = $2::uuid
             AND deleted_at IS NULL
             AND ($3 = 'all' OR domain = $3)
           RETURNING id`,
          [req.params.id, req.user.tenantId, req.userScope],
        ),
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Plano não encontrado.' });
      return res.status(204).send();
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
