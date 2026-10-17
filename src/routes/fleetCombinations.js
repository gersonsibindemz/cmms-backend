import { Router } from 'express';
import { withTenantContext } from '../db.js';
import { enforceDomainScope } from '../middlewares/auth.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const TRAILER_ROLES = new Set(['leader', 'follower']);

router.use(enforceDomainScope('fleet'));

function requireTenant(req, res, next) {
  if (!req.user?.tenantId) {
    return res.status(403).json({ error: 'A empresa do utilizador não está definida.' });
  }
  return next();
}

router.get('/', requireTenant, async (req, res, next) => {
  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT combinations.id,
                combinations.tenant_id,
                combinations.combination_code,
                combinations.truck_id,
                combinations.status,
                combinations.started_at,
                combinations.ended_at,
                combinations.created_at,
                combinations.updated_at,
                truck.code_tag AS truck_code_tag,
                truck.name AS truck_name,
                COALESCE(
                  jsonb_agg(
                    jsonb_build_object(
                      'trailer_id', trailers.trailer_id,
                      'code_tag', trailer_asset.code_tag,
                      'name', trailer_asset.name,
                      'role_in_combination', trailers.role_in_combination,
                      'position_order', trailers.position_order
                    )
                    ORDER BY trailers.position_order
                  ) FILTER (WHERE trailers.id IS NOT NULL),
                  '[]'::jsonb
                ) AS trailers
         FROM public.fleet_combinations AS combinations
         JOIN public.assets AS truck
           ON truck.id = combinations.truck_id
          AND truck.tenant_id = combinations.tenant_id
         LEFT JOIN public.fleet_combination_trailers AS trailers
           ON trailers.combination_id = combinations.id
          AND trailers.tenant_id = combinations.tenant_id
         LEFT JOIN public.assets AS trailer_asset
           ON trailer_asset.id = trailers.trailer_id
          AND trailer_asset.tenant_id = combinations.tenant_id
         WHERE combinations.tenant_id = $1::uuid
         GROUP BY combinations.id, truck.code_tag, truck.name
         ORDER BY (combinations.status = 'active') DESC,
                  combinations.created_at DESC`,
        [req.user.tenantId],
      ),
    );
    return res.json({ fleetCombinations: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/', requireTenant, async (req, res, next) => {
  const { truck_id: truckId, combination_code: combinationCode, trailers } = req.body ?? {};
  if (
    typeof truckId !== 'string'
    || !UUID_PATTERN.test(truckId)
    || typeof combinationCode !== 'string'
    || !combinationCode.trim()
    || combinationCode.trim().length > 255
    || !Array.isArray(trailers)
    || trailers.length === 0
    || trailers.some((trailer) => (
      !trailer
      || typeof trailer !== 'object'
      || Array.isArray(trailer)
      || typeof trailer.trailer_id !== 'string'
      || !UUID_PATTERN.test(trailer.trailer_id)
      || !TRAILER_ROLES.has(trailer.role_in_combination)
      || !Number.isInteger(trailer.position_order)
      || trailer.position_order < 1
    ))
  ) {
    return res.status(400).json({ error: 'Dados do conjunto rodoviário inválidos.' });
  }

  const trailerIds = trailers.map(({ trailer_id: id }) => id);
  if (
    new Set(trailerIds).size !== trailerIds.length
    || trailerIds.includes(truckId)
    || new Set(trailers.map(({ position_order: position }) => position)).size !== trailers.length
  ) {
    return res.status(400).json({ error: 'Camião, trelas e posições do conjunto devem ser únicos.' });
  }

  try {
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const assetIds = [truckId, ...trailerIds].sort();
      const assetsResult = await client.query(
        `SELECT id
         FROM public.assets
         WHERE tenant_id = $1::uuid
           AND domain = 'fleet'
           AND deleted_at IS NULL
           AND id = ANY($2::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [req.user.tenantId, assetIds],
      );
      if (assetsResult.rowCount !== assetIds.length) return { invalidAssets: true };

      const occupiedResult = await client.query(
        `SELECT combinations.truck_id AS asset_id
         FROM public.fleet_combinations AS combinations
         WHERE combinations.tenant_id = $1::uuid
           AND combinations.status = 'active'
           AND combinations.truck_id = ANY($2::uuid[])
         UNION
         SELECT trailers.trailer_id AS asset_id
         FROM public.fleet_combination_trailers AS trailers
         JOIN public.fleet_combinations AS combinations
           ON combinations.id = trailers.combination_id
          AND combinations.tenant_id = trailers.tenant_id
         WHERE combinations.tenant_id = $1::uuid
           AND combinations.status = 'active'
           AND trailers.trailer_id = ANY($2::uuid[])`,
        [req.user.tenantId, assetIds],
      );
      if (occupiedResult.rowCount > 0) return { assetsOccupied: true };

      const combinationResult = await client.query(
        `INSERT INTO public.fleet_combinations (
           tenant_id, combination_code, truck_id
         )
         VALUES ($1::uuid, $2, $3::uuid)
         RETURNING id`,
        [req.user.tenantId, combinationCode.trim(), truckId],
      );
      const combinationId = combinationResult.rows[0].id;

      for (const trailer of trailers) {
        await client.query(
          `INSERT INTO public.fleet_combination_trailers (
             tenant_id, combination_id, trailer_id, role_in_combination, position_order
           )
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
          [
            req.user.tenantId,
            combinationId,
            trailer.trailer_id,
            trailer.role_in_combination,
            trailer.position_order,
          ],
        );
      }
      return { combinationId };
    });

    if (outcome.invalidAssets) {
      return res.status(400).json({ error: 'Camião ou trela inválidos neste tenant.' });
    }
    if (outcome.assetsOccupied) {
      return res.status(400).json({ error: 'O camião ou uma das trelas já pertence a um conjunto ativo.' });
    }
    return res.status(201).json({ id: outcome.combinationId });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Já existe um conjunto com este código neste tenant.' });
    }
    return next(error);
  }
});

router.patch('/:id/terminate', requireTenant, async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador do conjunto inválido.' });
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `UPDATE public.fleet_combinations
         SET status = 'terminated',
             ended_at = NOW(),
             updated_at = NOW()
         WHERE id = $1::uuid
           AND tenant_id = $2::uuid
           AND status = 'active'
         RETURNING *`,
        [req.params.id, req.user.tenantId],
      ),
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: 'Conjunto ativo não encontrado.' });
    }
    return res.json({ fleetCombination: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

export default router;
