import { Router } from 'express';
import { Pool } from 'pg';
import { authenticateToken } from '../middlewares/auth.js';

const router = Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

router.use(authenticateToken);

// Middleware: apenas super_admin, it_staff ou tenant_admin podem aceder a logs
function requireItAccess(req, res, next) {
  if (req.user?.role === 'super_admin' || req.user?.role === 'tenant_admin' || req.user?.role === 'supervisor') {
    return next();
  }
  return res.status(403).json({ error: 'Acesso restrito à equipa de IT / Administração.' });
}

router.use(requireItAccess);

// GET /api/it-logs - lista logs com filtros
router.get('/', async (req, res) => {
  const { tenant_id, user_id, log_type, status, search } = req.query;

  try {
    let query = `
      SELECT l.id, l.tenant_id, l.user_id, l.action, l.entity_type, l.entity_id,
             l.client_ip, l.user_agent, l.created_at,
             COALESCE(l.status, 'start') AS status,
             COALESCE(l.is_read, false) AS is_read,
             COALESCE(l.is_opened, false) AS is_opened,
             l.opened_at, l.read_at,
             COALESCE(l.log_type, 'success') AS log_type,
             l.error_message,
             l.old_data, l.new_data,
             t.name AS tenant_name,
             u.full_name AS user_name,
             u.email AS user_email,
             u.role AS user_role
      FROM public.audit_logs l
      LEFT JOIN public.tenants t ON t.id = l.tenant_id
      LEFT JOIN public.app_users u ON u.id = l.user_id
      WHERE TRUE
    `;
    const params = [];

    // Se não for super_admin, restringe ao tenant ativo
    if (req.user.role !== 'super_admin') {
      params.push(req.user.tenantId);
      query += ` AND l.tenant_id = $${params.length}::uuid`;
    } else if (tenant_id) {
      params.push(tenant_id);
      query += ` AND l.tenant_id = $${params.length}::uuid`;
    }

    if (user_id) {
      params.push(user_id);
      query += ` AND l.user_id = $${params.length}::uuid`;
    }

    if (log_type && log_type !== 'all') {
      params.push(log_type);
      query += ` AND COALESCE(l.log_type, 'success') = $${params.length}`;
    }

    if (status && status !== 'all') {
      params.push(status);
      query += ` AND COALESCE(l.status, 'start') = $${params.length}`;
    }

    if (search) {
      params.push(`%${search.trim().toLowerCase()}%`);
      query += ` AND (
        LOWER(l.action) LIKE $${params.length} OR
        LOWER(COALESCE(l.error_message, '')) LIKE $${params.length} OR
        LOWER(COALESCE(u.full_name, '')) LIKE $${params.length} OR
        LOWER(COALESCE(u.email, '')) LIKE $${params.length} OR
        LOWER(COALESCE(t.name, '')) LIKE $${params.length}
      )`;
    }

    query += ' ORDER BY l.created_at DESC LIMIT 100';

    const result = await pool.query(query, params);
    return res.json({ logs: result.rows });
  } catch (err) {
    console.error('Erro ao consultar it-logs:', err);
    return res.status(500).json({ error: 'Erro ao obter logs de auditoria do sistema.' });
  }
});

// POST /api/it-logs - para frontend registar logs explícitos de erro ou sucesso
router.post('/', async (req, res) => {
  const { action, log_type, error_message, entity_type, entity_id, details } = req.body;
  try {
    const tenantId = req.user.tenantId || req.body.tenant_id;
    if (!tenantId && req.user.role !== 'super_admin') {
      return res.status(400).json({ error: 'Tenant ID obrigatório.' });
    }

    const insertResult = await pool.query(`
      INSERT INTO public.audit_logs (
        tenant_id, user_id, action, log_type, error_message, entity_type, entity_id, new_data, client_ip, user_agent, status, created_at
      )
      VALUES (
        $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, $9, $10, 'start', NOW()
      )
      RETURNING *
    `, [
      tenantId,
      req.user.id,
      action || 'USER_ACTION',
      log_type || 'success',
      error_message || null,
      entity_type || 'system',
      entity_id && /^[0-9a-f-]{36}$/i.test(entity_id) ? entity_id : null,
      details ? JSON.stringify(details) : null,
      req.ip || '127.0.0.1',
      req.headers['user-agent'] || 'browser',
    ]);

    return res.status(201).json({ log: insertResult.rows[0] });
  } catch (err) {
    console.error('Erro ao gravar it-log:', err);
    return res.status(500).json({ error: 'Erro ao registar log.' });
  }
});

// PATCH /api/it-logs/:id/open - Rastreia log aberto
router.patch('/:id/open', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`
      UPDATE public.audit_logs
      SET is_opened = true, opened_at = COALESCE(opened_at, NOW())
      WHERE id = $1::uuid
    `, [id]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/it-logs/:id/read - Rastreia log lido
router.patch('/:id/read', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`
      UPDATE public.audit_logs
      SET is_read = true, read_at = COALESCE(read_at, NOW())
      WHERE id = $1::uuid
    `, [id]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/it-logs/status - Transição de estados individual ou em massa (multi selection)
// Estados permitidos: start -> pause -> finished -> closed (ou solved)
router.patch('/status', async (req, res) => {
  const { logIds, status } = req.body;
  const validStatuses = ['start', 'pause', 'finished', 'closed', 'solved'];

  if (!Array.isArray(logIds) || logIds.length === 0) {
    return res.status(400).json({ error: 'Forneça uma lista de IDs de logs (logIds).' });
  }

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Estado inválido. Válidos: ${validStatuses.join(', ')}` });
  }

  try {
    await pool.query(`
      UPDATE public.audit_logs
      SET status = $1, is_read = true, read_at = COALESCE(read_at, NOW())
      WHERE id = ANY($2::uuid[])
    `, [status, logIds]);

    return res.json({ success: true, updatedCount: logIds.length, status });
  } catch (err) {
    console.error('Erro ao atualizar status dos logs:', err);
    return res.status(500).json({ error: 'Falha ao atualizar estado dos logs.' });
  }
});

export default router;
