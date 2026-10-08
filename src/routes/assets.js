import { Router } from 'express';
import { withTenantContext } from '../db.js';
import { authenticateToken, requireRoles } from '../middlewares/auth.js';

const router = Router();

router.use(authenticateToken);

router.get('/', async (req, res, next) => {
  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query('SELECT * FROM assets ORDER BY code_tag ASC'),
    );

    return res.json({ assets: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/', requireRoles('tenant_admin', 'supervisor'), async (req, res, next) => {
  const {
    codeTag,
    name,
    category,
    brand,
    model,
    manufactureYear,
    meterKind,
    costCenter,
  } = req.body ?? {};

  if (
    [codeTag, name, category, meterKind].some((value) => typeof value !== 'string' || !value.trim())
  ) {
    return res.status(400).json({ message: 'Tag, nome, categoria e tipo de medidor são obrigatórios.' });
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `INSERT INTO assets (
           tenant_id,
           code_tag,
           name,
           category,
           brand,
           model,
           manufacture_year,
           meter_kind,
           cost_center
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          req.user.tenantId,
          codeTag.trim(),
          name.trim(),
          category,
          brand ?? null,
          model ?? null,
          manufactureYear ?? null,
          meterKind,
          costCenter ?? null,
        ],
      ),
    );

    return res.status(201).json({ asset: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

export default router;