import { EventEmitter } from 'events';
import { pool } from '../db.js';

export const notificationBus = new EventEmitter();
notificationBus.setMaxListeners(100);

export async function createAndDispatchNotification({
  tenantId,
  domain,
  userId,
  targetRole,
  title,
  message,
  link,
  client,
}) {
  const query = client ? client.query.bind(client) : pool.query.bind(pool);
  const result = await query(
    `INSERT INTO public.notifications (
       tenant_id, domain, user_id, target_role, title, message, link, is_read, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, NOW())
     RETURNING *`,
    [
      tenantId,
      domain,
      userId ?? null,
      targetRole ?? null,
      title,
      message,
      link ?? null,
    ],
  );
  const savedNotification = result.rows[0];
  notificationBus.emit('new_notification', savedNotification);
  return savedNotification;
}

export async function notifyWorkOrderAssigned(wo, technicianUserId, asset, client) {
  return createAndDispatchNotification({
    tenantId: wo.tenant_id,
    domain: wo.domain,
    userId: technicianUserId,
    title: 'Nova Ordem de Serviço Atribuída',
    message: `Foi-lhe atribuída a ordem ${wo.os_number}: ${wo.title}${asset?.name ? ` — ${asset.name}` : ''}.`,
    link: `/app/work-orders?id=${wo.id}`,
    client,
  });
}

export async function notifyCriticalWorkOrder(wo, asset, client) {
  if (!['urgent', 'high'].includes(wo.priority)) return null;

  return createAndDispatchNotification({
    tenantId: wo.tenant_id,
    domain: wo.domain,
    targetRole: 'supervisor',
    title: 'Intervenção crítica necessária',
    message: `A ordem ${wo.os_number} (${wo.priority}) requer intervenção${asset?.name ? ` no ativo ${asset.name}` : ''}: ${wo.title}.`,
    link: `/app/work-orders?id=${wo.id}`,
    client,
  });
}

export async function notifyLowStock(part, client) {
  const message = `O item ${part.name} (${part.part_number}) atingiu o stock mínimo (${part.current_stock}${part.unit_of_measure}).`;
  const notification = {
    tenantId: part.tenant_id,
    domain: part.domain,
    title: 'Alerta de stock mínimo',
    message,
    link: '/app/inventory',
    client,
  };

  const createdNotifications = [];
  for (const targetRole of ['supervisor', 'tenant_admin']) {
    createdNotifications.push(await createAndDispatchNotification({
      ...notification,
      targetRole,
    }));
  }
  return createdNotifications;
}
