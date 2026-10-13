import { withTenantContext } from '../db.js';

export async function sendNotificationSafe({
  tenantId,
  domain,
  userId = null,
  targetRole = null,
  title,
  message,
  link = null,
}) {
  try {
    await withTenantContext(tenantId, 'tenant_admin', (client) =>
      client.query(
        `INSERT INTO public.notifications (
           tenant_id, domain, user_id, target_role, title, message, link
         )
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
        [tenantId, domain, userId, targetRole, title, message, link],
      ),
    );
  } catch (err) {
    console.error('[Notification Warn]:', err.message);
  }
}
