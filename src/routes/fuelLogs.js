import { Router } from 'express';
import { withTenantContext } from '../db.js';
import { authenticateToken } from '../middlewares/auth.js';

const router = Router();

router.use(authenticateToken);

router.get('/', async (req, res, next) => {
  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT fuel_logs.*, assets.code_tag AS asset_code_tag
         FROM fuel_logs
         JOIN assets
           ON assets.id = fuel_logs.asset_id
          AND assets.tenant_id = fuel_logs.tenant_id
         ORDER BY fuel_logs.logged_at DESC`,
      ),
    );

    return res.json({ fuelLogs: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/', async (req, res, next) => {
  const {
    assetId,
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

  if (
    !assetId ||
    typeof fuelType !== 'string' ||
    !fuelType.trim() ||
    typeof liters !== 'number' ||
    typeof pricePerLiterMzn !== 'number' ||
    typeof currentMeter !== 'number'
  ) {
    return res.status(400).json({ message: 'Dados obrigatórios do abastecimento inválidos.' });
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
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
      ),
    );

    return res.status(201).json({ fuelLog: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

export default router;