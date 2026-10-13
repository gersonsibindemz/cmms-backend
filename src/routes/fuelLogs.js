import { Router } from 'express';
import { withTenantContext } from '../db.js';
import { authenticateToken, enforceDomainScope } from '../middlewares/auth.js';

const router = Router();

router.use(authenticateToken, enforceDomainScope, (req, res, next) => {
  if (req.userScope !== 'fleet') {
    return res.status(403).json({ message: 'O módulo de combustível está disponível apenas no escopo de frota.' });
  }
  return next();
});

router.get('/', async (req, res, next) => {
  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT fuel_logs.*, assets.code_tag AS asset_code_tag
         FROM public.fuel_logs AS fuel_logs
         JOIN public.assets AS assets
           ON assets.id = fuel_logs.asset_id
          AND assets.tenant_id = fuel_logs.tenant_id
          AND assets.deleted_at IS NULL
         WHERE fuel_logs.tenant_id = $1::uuid
           AND (assets.domain = 'fleet' OR assets.operational_scope = 'fleet')
         ORDER BY fuel_logs.logged_at DESC`,
        [req.user.tenantId],
      ),
    );

    return res.json({ fuelLogs: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/', async (req, res, next) => {
  const {
    assetId: requestedAssetId,
    asset_id: requestedAssetIdSnake,
    driverOrOperatorId,
    fuelType,
    liters,
    pricePerLiterMzn,
    currentMeter,
    previousMeter,
    stationName,
    receiptDocRef,
    receiptPhotoUrl,
  } = req.body ?? {};
  const assetId = requestedAssetId || requestedAssetIdSnake;

  if (
    typeof assetId !== 'string' ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(assetId) ||
    typeof fuelType !== 'string' ||
    !fuelType.trim() ||
    typeof liters !== 'number' ||
    typeof pricePerLiterMzn !== 'number' ||
    typeof currentMeter !== 'number'
  ) {
    return res.status(400).json({ message: 'Dados obrigatórios do abastecimento inválidos.' });
  }

  try {
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const assetResult = await client.query(
        `SELECT id, domain
         FROM public.assets
         WHERE id = $1::uuid
           AND tenant_id = $2::uuid
           AND deleted_at IS NULL`,
        [assetId, req.user.tenantId],
      );
      const asset = assetResult.rows[0];
      if (!asset) return { assetNotFound: true };
      if (asset.domain !== 'fleet') return { wrongScope: true };

      const result = await client.query(
        `INSERT INTO fuel_logs (
           tenant_id,
           asset_id,
           driver_or_operator_id,
           fuel_type,
           liters,
           price_per_liter_mzn,
           current_meter,
           previous_meter,
           station_name,
           receipt_doc_ref,
           receipt_photo_url
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          req.user.tenantId,
          assetId,
          driverOrOperatorId ?? null,
          fuelType.trim(),
          liters,
          pricePerLiterMzn,
          currentMeter,
          previousMeter ?? null,
          stationName ?? null,
          receiptDocRef ?? null,
          receiptPhotoUrl ?? null,
        ],
      );
      return { fuelLog: result.rows[0] };
    });

    if (outcome.assetNotFound) {
      return res.status(400).json({ message: 'Ativo não encontrado neste tenant.' });
    }
    if (outcome.wrongScope) {
      return res.status(403).json({ message: 'O ativo não pertence ao escopo de frota.' });
    }
    return res.status(201).json({ fuelLog: outcome.fuelLog });
  } catch (error) {
    return next(error);
  }
});

export default router;