import { Router } from 'express';
import { withTenantContext } from '../db.js';
import { authenticateToken } from '../middlewares/auth.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

router.use(authenticateToken);

function requireTenant(req, res, next) {
  if (!req.user.tenantId) {
    return res.status(403).json({ message: 'A empresa do utilizador não está definida.' });
  }
  return next();
}

router.get('/', requireTenant, async (req, res, next) => {
  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT t.*, COALESCE(u.email, t.email) AS user_email
         FROM public.technicians AS t
         LEFT JOIN public.app_users AS u
           ON u.id = t.user_id
          AND u.tenant_id = t.tenant_id
         WHERE t.tenant_id = $1
           AND t.deleted_at IS NULL
           AND t.status = 'active'
         ORDER BY t.name ASC`,
        [req.user.tenantId],
      ),
    );

    return res.json({ technicians: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/', requireTenant, async (req, res, next) => {
  const { name, specialty, phone, email, hourlyRate, userId } = req.body ?? {};

  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 255 ||
    (specialty !== undefined && specialty !== null && (
      typeof specialty !== 'string' || specialty.length > 255
    )) ||
    (phone !== undefined && phone !== null && typeof phone !== 'string') ||
    (email !== undefined && email !== null && (
      typeof email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    )) ||
    (hourlyRate !== undefined && hourlyRate !== null && (
      typeof hourlyRate !== 'number' || !Number.isFinite(hourlyRate) || hourlyRate < 0
    )) ||
    (userId !== undefined && userId !== null && (
      typeof userId !== 'string' || !UUID_PATTERN.test(userId)
    ))
  ) {
    return res.status(400).json({ message: 'Dados do técnico inválidos.' });
  }

  try {
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      if (userId) {
        const userResult = await client.query(
          `SELECT id
           FROM public.app_users
           WHERE id = $1
             AND tenant_id = $2
             AND role = 'technician'
             AND is_active IS TRUE`,
          [userId, req.user.tenantId],
        );
        if (userResult.rowCount === 0) return { invalidUser: true };
      }

      const result = await client.query(
        `INSERT INTO public.technicians (
           tenant_id, name, specialty, phone, email, hourly_rate, user_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          req.user.tenantId,
          name.trim(),
          specialty?.trim() || null,
          phone?.trim() || null,
          email?.trim().toLowerCase() || null,
          hourlyRate ?? null,
          userId ?? null,
        ],
      );
      return { technician: result.rows[0] };
    });

    if (outcome.invalidUser) {
      return res.status(400).json({ message: 'A conta associada não é um técnico ativo deste tenant.' });
    }
    return res.status(201).json({ technician: outcome.technician });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ message: 'Já existe um técnico associado a esta conta.' });
    }
    return next(error);
  }
});

export default router;
