import { Router } from 'express';
import { withTenantContext } from '../db.js';
import { authenticateToken, enforceDomainScope } from '../middlewares/auth.js';

const router = Router();

router.use(authenticateToken, (req, res, next) => {
  if (req.method === 'GET' && req.path === '/') {
    if (!req.user.tenantId) {
      return res.status(403).json({ message: 'A empresa do utilizador não está definida.' });
    }
    return next();
  }
  return enforceDomainScope(req, res, next);
}, (req, res, next) => {
  if (req.method === 'GET' && req.path === '/') return next();
  if (req.userScope !== 'fleet') {
    return res.status(403).json({ message: 'O módulo de combustível está disponível apenas no escopo de frota.' });
  }
  return next();
});

router.get('/reference-prices', async (req, res, next) => {
  try {
    const reference = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const tenantResult = await client.query(
        `SELECT country, currency
         FROM public.tenants
         WHERE id = $1::uuid`,
        [req.user.tenantId],
      );
      const tenant = tenantResult.rows[0];
      if (!tenant) return null;

      const pricesResult = await client.query(
        `SELECT fuel_type, price_per_liter, tenant_id
         FROM public.fuel_price_settings
         WHERE tenant_id = $1::uuid
            OR (
              tenant_id IS NULL
              AND country = $2
              AND currency = $3
            )
         ORDER BY (tenant_id = $1::uuid) DESC NULLS LAST`,
        [req.user.tenantId, tenant.country, tenant.currency],
      );
      return { tenant, prices: pricesResult.rows };
    });

    if (!reference) {
      return res.status(404).json({ error: 'Tenant não encontrado.' });
    }

    const prices = { diesel: null, gasolina: null };
    for (const price of reference.prices) {
      const fuelType = price.fuel_type.trim().toLowerCase();
      const key = fuelType === 'diesel'
        ? 'diesel'
        : ['gasolina', 'gasoline', 'petrol'].includes(fuelType)
          ? 'gasolina'
          : null;
      if (key && prices[key] === null) prices[key] = Number(price.price_per_liter);
    }

    return res.json({
      country: reference.tenant.country,
      currency: reference.tenant.currency,
      prices: {
        Diesel: prices.diesel ?? 75.00,
        Gasolina: prices.gasolina ?? 86.25,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT fl.*,
                a.name AS asset_name,
                a.code_tag AS asset_code_tag,
                a.license_plate AS asset_license_plate
         FROM public.fuel_logs AS fl
         LEFT JOIN public.assets AS a
           ON a.id = fl.asset_id
          AND a.tenant_id = fl.tenant_id
         WHERE fl.tenant_id = $1::uuid
         ORDER BY fl.logged_at DESC`,
        [req.user.tenantId],
      ),
    );

    return res.status(200).json({ fuelLogs: result.rows, total: result.rows.length });
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
    !Number.isFinite(liters) ||
    liters <= 0 ||
    typeof pricePerLiterMzn !== 'number' ||
    !Number.isFinite(pricePerLiterMzn) ||
    pricePerLiterMzn < 0 ||
    typeof currentMeter !== 'number' ||
    !Number.isFinite(currentMeter) ||
    currentMeter < 0
  ) {
    return res.status(400).json({ message: 'Dados obrigatórios do abastecimento inválidos.' });
  }

  try {
    const outcome = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const assetResult = await client.query(
        `SELECT id, current_meter, fuel_tank_capacity_liters, domain
         FROM public.assets
         WHERE id = $1::uuid
           AND tenant_id = $2::uuid
           AND deleted_at IS NULL
         FOR UPDATE`,
        [assetId, req.user.tenantId],
      );
      const asset = assetResult.rows[0];
      if (!asset) return { assetNotFound: true };
      if (asset.domain !== 'fleet') return { wrongScope: true };

      if (
        asset.fuel_tank_capacity_liters !== null
        && Number(asset.fuel_tank_capacity_liters) > 0
        && liters > Number(asset.fuel_tank_capacity_liters)
      ) {
        return {
          fuelTankCapacityExceeded: true,
          error: `O volume abastecido (${liters}L) não pode exceder a capacidade máxima do tanque (${Number(asset.fuel_tank_capacity_liters)}L).`,
        };
      }
      if (
        asset.current_meter !== null
        && currentMeter < Number(asset.current_meter)
      ) {
        return {
          meterCannotDecrease: true,
          error: `A quilometragem no abastecimento (${currentMeter}) não pode ser inferior ao último contador registrado no veículo (${Number(asset.current_meter)}).`,
        };
      }

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
      await client.query(
        `UPDATE public.assets
         SET current_meter = $1,
             updated_at = NOW()
         WHERE id = $2
           AND tenant_id = $3`,
        [currentMeter, assetId, req.user.tenantId],
      );
      return { fuelLog: result.rows[0] };
    });

    if (outcome.assetNotFound) {
      return res.status(400).json({ message: 'Ativo não encontrado neste tenant.' });
    }
    if (outcome.wrongScope) {
      return res.status(403).json({ message: 'O ativo não pertence ao escopo de frota.' });
    }
    if (outcome.fuelTankCapacityExceeded || outcome.meterCannotDecrease) {
      return res.status(400).json({ error: outcome.error });
    }
    return res.status(201).json({ fuelLog: outcome.fuelLog });
  } catch (error) {
    return next(error);
  }
});

export default router;