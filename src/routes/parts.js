import { Router } from 'express';
import { withTenantContext } from '../db.js';
import {
  authenticateToken,
  enforceDomainScope,
  requireRoles,
} from '../middlewares/auth.js';
import { sendNotificationSafe } from '../services/notificationService.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

router.use(authenticateToken, enforceDomainScope);

function requireTenant(req, res, next) {
  if (!req.user.tenantId) {
    return res.status(403).json({ message: 'A empresa do utilizador não está definida.' });
  }
  return next();
}

router.get('/', requireTenant, async (req, res, next) => {
  const values = [req.user.tenantId];
  const filters = ['tenant_id = $1', 'deleted_at IS NULL'];
  if (req.userScope) {
    values.push(req.userScope);
    filters.push(`domain = $${values.length}`);
  }

  const search = req.query.search;
  if (search !== undefined && search !== '') {
    if (typeof search !== 'string') {
      return res.status(400).json({ message: 'Termo de pesquisa inválido.' });
    }
    values.push(`%${search.trim()}%`);
    filters.push(`(name ILIKE $${values.length}
      OR part_number ILIKE $${values.length}
      OR category ILIKE $${values.length})`);
  }

  if (req.query.low_stock !== undefined) {
    if (req.query.low_stock !== 'true' && req.query.low_stock !== 'false') {
      return res.status(400).json({ message: 'Filtro low_stock inválido.' });
    }
    if (req.query.low_stock === 'true') {
      filters.push('current_stock <= min_stock');
    }
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT *
         FROM public.parts
         WHERE ${filters.join(' AND ')}
         ORDER BY name ASC`,
        values,
      ),
    );
    return res.json({ parts: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/',
  requireTenant,
  requireRoles('tenant_admin', 'supervisor'),
  async (req, res, next) => {
    const {
      name,
      partNumber,
      part_number,
      oem_reference,
      category,
      location,
      warehouse_location,
      unitOfMeasure,
      unit_of_measure,
      currentStock,
      current_stock,
      minStock,
      min_stock,
      unitCost,
      unit_cost,
    } = req.body ?? {};
    const finalName = name?.trim();
    const finalPartNumber = (partNumber || part_number || oem_reference || '').trim();
    const finalCategory = category || 'Geral';
    const finalLocation = location || warehouse_location || null;
    const finalUnit = unitOfMeasure || unit_of_measure || 'un';
    const finalStock = Number(currentStock ?? current_stock ?? 0);
    const finalMinStock = Number(minStock ?? min_stock ?? 0);
    const finalCost = Number(unitCost ?? unit_cost ?? 0);

    if (!finalName || !finalPartNumber) {
      return res.status(400).json({
        error: 'Nome da peça e Referência/OEM são obrigatórios.',
      });
    }

    try {
      const part = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
        const result = await client.query(
          `INSERT INTO public.parts (
             tenant_id, domain, part_number, name, category, unit_of_measure,
             location, current_stock, min_stock, unit_cost
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            req.user.tenantId,
            req.userScope,
            finalPartNumber,
            finalName,
            finalCategory,
            finalUnit,
            finalLocation,
            finalStock,
            finalMinStock,
            finalCost,
          ],
        );
        const createdPart = result.rows[0];

        if (finalStock > 0) {
          await client.query(
            `INSERT INTO public.stock_movements (
               tenant_id, part_id, user_id, movement_type, quantity, unit_cost, reason
             )
             VALUES ($1, $2, $3, 'in', $4, $5, 'initial_inventory')`,
            [
              req.user.tenantId,
              createdPart.id,
              req.user.id,
              finalStock,
              finalCost,
            ],
          );
        }

        return createdPart;
      });
      return res.status(201).json({ part });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  ['/:id/restock', '/:id/replenish'],
  requireTenant,
  requireRoles('tenant_admin', 'supervisor'),
  async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ message: 'Identificador da peça inválido.' });
    }

    const { quantity, unitCost, notes } = req.body ?? {};
    if (
      typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 ||
      typeof unitCost !== 'number' || !Number.isFinite(unitCost) || unitCost < 0 ||
      (notes !== undefined && notes !== null && typeof notes !== 'string')
    ) {
      return res.status(400).json({ message: 'Dados de reposição inválidos.' });
    }

    try {
      const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
        const partResult = await client.query(
          `SELECT id, current_stock, unit_cost
           FROM public.parts
           WHERE id = $1
             AND tenant_id = $2
             AND deleted_at IS NULL
             ${req.userScope ? 'AND domain = $3' : ''}
           FOR UPDATE`,
          req.userScope
            ? [req.params.id, req.user.tenantId, req.userScope]
            : [req.params.id, req.user.tenantId],
        );
        const part = partResult.rows[0];
        if (!part) return { notFound: true };

        await client.query(
          `UPDATE public.parts
           SET unit_cost = (
                 (current_stock * COALESCE(unit_cost, 0)) + ($1 * $2)
               ) / (current_stock + $1),
               current_stock = current_stock + $1,
               updated_at = NOW()
           WHERE id = $3 AND tenant_id = $4`,
          [quantity, unitCost, part.id, req.user.tenantId],
        );

        await client.query(
          `INSERT INTO public.stock_movements (
             tenant_id, part_id, user_id, movement_type, quantity, unit_cost, reason, notes
           )
           VALUES ($1, $2, $3, 'in', $4, $5, 'restock_purchase', $6)`,
          [
            req.user.tenantId,
            part.id,
            req.user.id,
            quantity,
            unitCost,
            notes?.trim() || null,
          ],
        );
        return { success: true };
      });

      if (outcome.notFound) {
        return res.status(404).json({ error: 'Peça não encontrada.' });
      }
      return res.status(200).json({ message: 'Entrada de stock registada com sucesso.' });
    } catch (error) {
      console.error('Erro ao registar entrada de stock:', error);
      return res.status(500).json({ error: 'Não foi possível registar a entrada de stock.' });
    }
  },
);

router.post(
  '/:id/withdraw',
  requireTenant,
  requireRoles('tenant_admin', 'supervisor'),
  async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ error: 'Identificador da peça inválido.' });
    }

    const { quantity, notes, reason } = req.body ?? {};
    if (
      typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 ||
      (notes !== undefined && notes !== null && typeof notes !== 'string') ||
      (reason !== undefined && reason !== null && typeof reason !== 'string')
    ) {
      return res.status(400).json({ error: 'Dados de saída inválidos.' });
    }

    try {
      const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
        const partResult = await client.query(
          `SELECT id, name, unit_of_measure, current_stock, min_stock, unit_cost
           FROM public.parts
           WHERE id = $1
             AND tenant_id = $2
             AND deleted_at IS NULL
             ${req.userScope ? 'AND domain = $3' : ''}
           FOR UPDATE`,
          req.userScope
            ? [req.params.id, req.user.tenantId, req.userScope]
            : [req.params.id, req.user.tenantId],
        );
        const part = partResult.rows[0];
        if (!part) return { notFound: true };
        if (quantity > Number(part.current_stock)) return { insufficientStock: true };

        const stockResult = await client.query(
          `UPDATE public.parts
           SET current_stock = current_stock - $1,
               updated_at = NOW()
           WHERE id = $2 AND tenant_id = $3
           RETURNING current_stock, min_stock, name, unit_of_measure`,
          [quantity, part.id, req.user.tenantId],
        );

        await client.query(
          `INSERT INTO public.stock_movements (
             tenant_id, part_id, user_id, movement_type, quantity, unit_cost, reason, notes
           )
           VALUES ($1, $2, $3, 'out', $4, $5, $6, $7)`,
          [
            req.user.tenantId,
            part.id,
            req.user.id,
            -quantity,
            part.unit_cost,
            reason || 'manual_withdraw',
            notes?.trim() || null,
          ],
        );
        const updatedPart = stockResult.rows[0];
        return {
          success: true,
          lowStockNotification:
            Number(updatedPart.current_stock) <= Number(updatedPart.min_stock)
              ? {
                  name: updatedPart.name,
                  newStock: updatedPart.current_stock,
                  unitOfMeasure: updatedPart.unit_of_measure,
                }
              : null,
        };
      });

      if (outcome.notFound) {
        return res.status(404).json({ error: 'Peça não encontrada.' });
      }
      if (outcome.insufficientStock) {
        return res.status(400).json({ error: 'Stock insuficiente para efetuar a saída.' });
      }
      if (outcome.lowStockNotification) {
        void sendNotificationSafe({
          tenantId: req.user.tenantId,
          domain: req.userScope,
          targetRole: 'supervisor',
          title: 'Alerta de Stock Mínimo',
          message: `A peça "${outcome.lowStockNotification.name}" atingiu o nível crítico (${outcome.lowStockNotification.newStock} ${outcome.lowStockNotification.unitOfMeasure}).`,
          link: '/inventory',
        });
      }
      return res.status(200).json({ message: 'Saída de stock registada com sucesso.' });
    } catch (error) {
      console.error('Erro ao registar saída de stock:', error);
      return res.status(500).json({ error: 'Não foi possível registar a saída de stock.' });
    }
  },
);

export default router;
