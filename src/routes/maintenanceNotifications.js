import { Router } from 'express';
import { withTenantContext } from '../db.js';
import {
  authenticateToken,
  enforceDomainScope,
  requireRoles,
} from '../middlewares/auth.js';
import {
  createAndDispatchNotification,
  notifyWorkOrderAssigned,
} from '../services/notificationService.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const MAINTENANCE_TYPES = new Set(['corrective', 'preventive', 'inspection']);
const NOTIFICATION_STATUSES = new Set(['draft', 'pending_triage']);

router.use(authenticateToken, enforceDomainScope);

function requireTenant(req, res, next) {
  if (!req.user.tenantId) {
    return res.status(403).json({ error: 'A empresa do utilizador não está definida.' });
  }
  return next();
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsedDate = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsedDate.valueOf())
    && parsedDate.toISOString().slice(0, 10) === value;
}

async function getTechnicianUserId(client, assignedTo, tenantId, domain) {
  const result = await client.query(
    `SELECT app_users.id
     FROM public.app_users
     WHERE app_users.id = $1::uuid
       AND app_users.tenant_id = $2::uuid
       AND app_users.operational_scope = $3
       AND app_users.is_active = true
     UNION
     SELECT technicians.user_id AS id
     FROM public.technicians
     WHERE technicians.id = $1::uuid
       AND technicians.tenant_id = $2::uuid
       AND technicians.domain = $3
       AND technicians.status = 'active'
       AND technicians.deleted_at IS NULL
       AND technicians.user_id IS NOT NULL
     LIMIT 1`,
    [assignedTo, tenantId, domain],
  );
  return result.rows[0]?.id ?? null;
}

router.post('/', requireTenant, async (req, res, next) => {
  const {
    assetId,
    domain,
    areaProcess,
    occurrenceLocation,
    occurrenceDate,
    requesterName,
    operatorName,
    priority,
    maintenanceType,
    meterReading,
    operationalStatus,
    problemDescription,
    attachmentUrls,
    status = 'draft',
  } = req.body ?? {};

  if (
    typeof assetId !== 'string' ||
    !UUID_PATTERN.test(assetId) ||
    (domain !== undefined && domain !== req.userScope) ||
    (areaProcess !== undefined && areaProcess !== null && typeof areaProcess !== 'string') ||
    (occurrenceLocation !== undefined && occurrenceLocation !== null && typeof occurrenceLocation !== 'string') ||
    (occurrenceDate !== undefined && occurrenceDate !== null && !isValidDate(occurrenceDate)) ||
    typeof requesterName !== 'string' ||
    !requesterName.trim() ||
    requesterName.trim().length > 255 ||
    (operatorName !== undefined && operatorName !== null && (
      typeof operatorName !== 'string' || operatorName.length > 255
    )) ||
    !PRIORITIES.has(priority) ||
    !MAINTENANCE_TYPES.has(maintenanceType) ||
    (meterReading !== undefined && meterReading !== null && (
      typeof meterReading !== 'number' || !Number.isFinite(meterReading) || meterReading < 0
    )) ||
    (operationalStatus !== undefined && operationalStatus !== null && typeof operationalStatus !== 'string') ||
    typeof problemDescription !== 'string' ||
    !problemDescription.trim() ||
    problemDescription.trim().length > 10000 ||
    (attachmentUrls !== undefined && (
      !Array.isArray(attachmentUrls) ||
      attachmentUrls.length > 20 ||
      attachmentUrls.some((url) => typeof url !== 'string' || url.length > 2048)
    )) ||
    !NOTIFICATION_STATUSES.has(status)
  ) {
    return res.status(400).json({ error: 'Dados da solicitação de manutenção inválidos.' });
  }

  try {
    const notification = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const assetResult = await client.query(
        `SELECT id, code_tag, license_plate, plant_sector, domain, operational_scope
         FROM public.assets
         WHERE id = $1::uuid
           AND tenant_id = $2::uuid
           AND deleted_at IS NULL
           AND (domain = $3 OR operational_scope = $3)
         FOR SHARE`,
        [assetId, req.user.tenantId, req.userScope],
      );
      const asset = assetResult.rows[0];
      if (!asset) return { assetNotFound: true };

      const result = await client.query(
        `INSERT INTO public.maintenance_notifications (
           tenant_id, asset_id, asset_code, asset_registration, asset_sector,
           domain, area_process, occurrence_location, occurrence_date,
           requester_user_id, requester_name, operator_name, priority,
           maintenance_type, meter_reading, operational_status,
           problem_description, attachment_urls, status
         )
         VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::date,
           $10::uuid, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19
         )
         RETURNING *`,
        [
          req.user.tenantId,
          asset.id,
          asset.code_tag,
          asset.license_plate,
          asset.plant_sector,
          req.userScope,
          areaProcess?.trim() || null,
          occurrenceLocation?.trim() || null,
          occurrenceDate ?? null,
          req.user.id,
          requesterName.trim(),
          operatorName?.trim() || null,
          priority,
          maintenanceType,
          meterReading ?? null,
          operationalStatus?.trim() || null,
          problemDescription.trim(),
          JSON.stringify(attachmentUrls ?? []),
          status,
        ],
      );
      const savedNotif = result.rows[0];

      if (status === 'pending_triage') {
        await createAndDispatchNotification({
          tenantId: req.user.tenantId,
          domain: req.userScope,
          targetRole: 'supervisor',
          title: 'Nova Solicitação de Manutenção',
          message: `Solicitação ${savedNotif.notification_number} reportada por ${requesterName.trim()} para ${savedNotif.asset_code}.`,
          link: `/app/maintenance-notifications?id=${savedNotif.id}`,
          client,
        });
      }

      return { notification: savedNotif };
    });

    if (notification.assetNotFound) {
      return res.status(404).json({ error: 'Ativo não encontrado neste tenant e escopo.' });
    }
    return res.status(201).json({ success: true, notification: notification.notification });
  } catch (error) {
    return next(error);
  }
});

router.get('/', requireTenant, async (req, res, next) => {
  const { status } = req.query;
  const assetId = req.query.asset_id ?? req.query.assetId;
  if (
    (status !== undefined && (
      typeof status !== 'string' ||
      !new Set([...NOTIFICATION_STATUSES, 'converted_to_wo']).has(status)
    )) ||
    (assetId !== undefined && (
      typeof assetId !== 'string' || !UUID_PATTERN.test(assetId)
    ))
  ) {
    return res.status(400).json({ error: 'Filtro inválido.' });
  }

  const values = [req.user.tenantId, req.userScope];
  const filters = ['notifications.tenant_id = $1::uuid', 'notifications.domain = $2'];
  if (status !== undefined) {
    values.push(status);
    filters.push(`notifications.status = $${values.length}`);
  }
  if (assetId !== undefined) {
    values.push(assetId);
    filters.push(`notifications.asset_id = $${values.length}::uuid`);
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT notifications.*,
                to_jsonb(assets) AS asset
         FROM public.maintenance_notifications AS notifications
         JOIN public.assets AS assets
           ON assets.id = notifications.asset_id
          AND assets.tenant_id = notifications.tenant_id
         WHERE ${filters.join(' AND ')}
         ORDER BY notifications.created_at DESC`,
        values,
      ),
    );
    return res.json({ notifications: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', requireTenant, async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador da solicitação inválido.' });
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT notifications.*,
                to_jsonb(assets) AS asset
         FROM public.maintenance_notifications AS notifications
         JOIN public.assets AS assets
           ON assets.id = notifications.asset_id
          AND assets.tenant_id = notifications.tenant_id
         WHERE notifications.id = $1::uuid
           AND notifications.tenant_id = $2::uuid
           AND notifications.domain = $3`,
        [req.params.id, req.user.tenantId, req.userScope],
      ),
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Solicitação de manutenção não encontrada.' });
    }
    return res.json({ notification: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/:id/convert-to-wo',
  requireTenant,
  requireRoles('tenant_admin', 'supervisor'),
  async (req, res, next) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ error: 'Identificador da solicitação inválido.' });
    }

    const {
      assignedTo,
      estimatedHours,
      plannedDate,
      notes,
    } = req.body ?? {};
    if (
      (assignedTo !== undefined && assignedTo !== null && (
        typeof assignedTo !== 'string' || !UUID_PATTERN.test(assignedTo)
      )) ||
      (estimatedHours !== undefined && estimatedHours !== null && (
        typeof estimatedHours !== 'number' ||
        !Number.isFinite(estimatedHours) ||
        estimatedHours < 0
      )) ||
      (plannedDate !== undefined && plannedDate !== null && !isValidDate(plannedDate)) ||
      (notes !== undefined && notes !== null && (
        typeof notes !== 'string' || notes.length > 10000
      ))
    ) {
      return res.status(400).json({ error: 'Dados de atribuição inválidos.' });
    }

    try {
      const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
        const notificationResult = await client.query(
          `SELECT *
           FROM public.maintenance_notifications
           WHERE id = $1::uuid
             AND tenant_id = $2::uuid
             AND domain = $3
           FOR UPDATE`,
          [req.params.id, req.user.tenantId, req.userScope],
        );
        const notification = notificationResult.rows[0];
        if (!notification) return { notFound: true };
        if (notification.status !== 'pending_triage') return { invalidStatus: true };

        let technicianUserId = null;
        if (assignedTo) {
          technicianUserId = await getTechnicianUserId(
            client,
            assignedTo,
            req.user.tenantId,
            notification.domain,
          );
          if (!technicianUserId) return { invalidAssignee: true };
        }

        const title = `OS - ${notification.notification_number} - ${notification.problem_description}`
          .slice(0, 255);
        const workOrderResult = await client.query(
          `INSERT INTO public.work_orders (
             tenant_id, asset_id, domain, title, description, priority,
             order_type, status, meter_at_service, reported_by, opened_by,
             assigned_to, estimated_hours, planned_date, notes
           )
           VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'open', $8,
             $9::uuid, $9::uuid, $10::uuid, $11, $12::date, $13
           )
           RETURNING *`,
          [
            notification.tenant_id,
            notification.asset_id,
            notification.domain,
            title,
            notification.problem_description,
            notification.priority,
            notification.maintenance_type,
            notification.meter_reading,
            notification.requester_user_id,
            assignedTo ?? null,
            estimatedHours ?? null,
            plannedDate ?? null,
            notes?.trim() || null,
          ],
        );
        const workOrder = workOrderResult.rows[0];

        await client.query(
          `UPDATE public.maintenance_notifications
           SET status = 'converted_to_wo',
               work_order_id = $2::uuid,
               triaged_by = $3::uuid,
               triaged_at = NOW(),
               updated_at = NOW()
           WHERE id = $1::uuid`,
          [notification.id, workOrder.id, req.user.id],
        );

        if (technicianUserId) {
          const assetResult = await client.query(
            `SELECT id, name
             FROM public.assets
             WHERE id = $1::uuid
               AND tenant_id = $2::uuid`,
            [notification.asset_id, notification.tenant_id],
          );
          await notifyWorkOrderAssigned(
            workOrder,
            technicianUserId,
            assetResult.rows[0] ?? null,
            client,
          );
        }

        return { workOrder };
      });

      if (outcome.notFound) {
        return res.status(404).json({ error: 'Solicitação de manutenção não encontrada.' });
      }
      if (outcome.invalidStatus) {
        return res.status(409).json({ error: 'A solicitação não está pendente de triagem.' });
      }
      if (outcome.invalidAssignee) {
        return res.status(400).json({ error: 'Técnico atribuído não encontrado neste tenant e escopo.' });
      }
      return res.status(200).json({ success: true, workOrder: outcome.workOrder });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
