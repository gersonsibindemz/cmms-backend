import { Router } from 'express';
import { withTenantContext } from '../db.js';
import {
  authenticateToken,
  enforceDomainScope,
  requireRoles,
} from '../middlewares/auth.js';

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
  if (req.userScope && req.user.role !== 'super_admin') {
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
      partNumber,
      name,
      category,
      unitOfMeasure,
      location,
      minStock,
      initialStock,
      unitCost,
    } = req.body ?? {};

    if (
      typeof partNumber !== 'string' || !partNumber.trim() ||
      typeof name !== 'string' || !name.trim() ||
      typeof category !== 'string' || !category.trim() ||
      typeof unitOfMeasure !== 'string' || !unitOfMeasure.trim() ||
      (location !== undefined && location !== null && typeof location !== 'string') ||
      [minStock, initialStock, unitCost].some(
        (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0,
      )
    ) {
      return res.status(400).json({ message: 'Dados da peça inválidos.' });
    }

    try {
      const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
        client.query(
          `INSERT INTO public.parts (
             tenant_id, domain, part_number, name, category, unit_of_measure,
             location, min_stock, current_stock, unit_cost
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            req.user.tenantId,
            req.userScope ?? null,
            partNumber.trim(),
            name.trim(),
            category.trim(),
            unitOfMeasure.trim(),
            location?.trim() || null,
            minStock,
            initialStock,
            unitCost,
          ],
        ),
      );
      return res.status(201).json({ part: result.rows[0] });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/:id/restock',
  requireTenant,
  requireRoles('tenant_admin', 'supervisor'),
  async (req, res, next) => {
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
        const updated = await client.query(
          `UPDATE public.parts
           SET unit_cost = (
                 (current_stock * COALESCE(unit_cost, 0)) + ($1 * $2)
               ) / (current_stock + $1),
               current_stock = current_stock + $1,
               updated_at = NOW()
           WHERE id = $3
             AND tenant_id = $4
             AND deleted_at IS NULL
             ${req.userScope ? 'AND domain = $5' : ''}
           RETURNING *`,
          req.userScope
            ? [quantity, unitCost, req.params.id, req.user.tenantId, req.userScope]
            : [quantity, unitCost, req.params.id, req.user.tenantId],
        );
        const part = updated.rows[0];
        if (!part) return null;

        await client.query(
          `INSERT INTO public.stock_movements (
             tenant_id, part_id, movement_type, quantity, unit_cost, reason, notes
           )
           VALUES ($1, $2, 'in', $3, $4, 'restock_purchase', $5)`,
          [req.user.tenantId, part.id, quantity, unitCost, notes?.trim() || null],
        );
        return part;
      });

      if (!outcome) {
        return res.status(404).json({ message: 'Peça não encontrada.' });
      }
      return res.json({ part: outcome });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
