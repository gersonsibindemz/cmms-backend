import { Router } from 'express';
import { withTenantContext } from '../db.js';
import { authenticateToken, requireRoles } from '../middlewares/auth.js';
import {
  createTenantHandler,
  toggleTenantStatusHandler,
} from './adminTenants.js';

const router = Router();

router.use(authenticateToken, requireRoles('super_admin'));

router.post('/tenants', createTenantHandler);
router.patch('/tenants/:id/toggle-status', toggleTenantStatusHandler);

router.get('/tenants', async (req, res, next) => {
  try {
    const result = await withTenantContext(null, 'super_admin', (client) =>
      client.query(
        `SELECT
           t.id,
           t.name,
           t.trade_name,
           t.nuit,
           t.province,
           t.country,
           t.currency,
           t.is_active,
           t.suspension_reason,
           t.max_assets_limit,
           (SELECT COUNT(*)::int FROM assets AS a WHERE a.tenant_id = t.id) AS total_assets,
           (SELECT COUNT(*)::int FROM app_users AS u WHERE u.tenant_id = t.id) AS total_users
         FROM tenants AS t
         ORDER BY t.name`,
      ),
    );

    return res.json({ tenants: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get('/fuel-prices', async (req, res, next) => {
  try {
    const result = await withTenantContext(null, 'super_admin', (client) =>
      client.query(
        `SELECT fuel_prices.id,
                fuel_prices.country,
                fuel_prices.currency,
                fuel_prices.tenant_id,
                tenants.name AS tenant_name,
                fuel_prices.fuel_type,
                fuel_prices.price_per_liter,
                fuel_prices.created_at,
                fuel_prices.updated_at
         FROM public.fuel_price_settings AS fuel_prices
         LEFT JOIN public.tenants AS tenants
           ON tenants.id = fuel_prices.tenant_id
         ORDER BY fuel_prices.country,
                  fuel_prices.currency,
                  fuel_prices.tenant_id NULLS FIRST,
                  fuel_prices.fuel_type`,
      ),
    );
    return res.json({ fuelPrices: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/fuel-prices', async (req, res, next) => {
  const {
    country,
    currency,
    tenantId = null,
    fuelType,
    pricePerLiter,
    diesel_price: dieselPrice,
    dieselPrice: dieselPriceCamel,
    gasoline_price: gasolinePrice,
    gasolinePrice: gasolinePriceCamel,
  } = req.body ?? {};
  const requestedDieselPrice = dieselPrice ?? dieselPriceCamel;
  const requestedGasolinePrice = gasolinePrice ?? gasolinePriceCamel;

  if (
    typeof country !== 'string' ||
    !country.trim() ||
    country.trim().length > 100 ||
    typeof currency !== 'string' ||
    !/^[A-Za-z]{3}$/.test(currency.trim()) ||
    (tenantId !== null && (
      typeof tenantId !== 'string' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(tenantId)
    )) ||
    (
      fuelType !== undefined
      && (
        typeof fuelType !== 'string'
        || !fuelType.trim()
        || fuelType.trim().length > 100
        || typeof pricePerLiter !== 'number'
        || !Number.isFinite(pricePerLiter)
        || pricePerLiter < 0
      )
    ) ||
    (
      (requestedDieselPrice !== undefined || requestedGasolinePrice !== undefined)
      && (
        typeof requestedDieselPrice !== 'number'
        || !Number.isFinite(requestedDieselPrice)
        || requestedDieselPrice < 0
        || typeof requestedGasolinePrice !== 'number'
        || !Number.isFinite(requestedGasolinePrice)
        || requestedGasolinePrice < 0
      )
    ) ||
    (
      fuelType === undefined
      && requestedDieselPrice === undefined
      && requestedGasolinePrice === undefined
    )
  ) {
    return res.status(400).json({ error: 'Dados do preço de combustível inválidos.' });
  }

  try {
    const singlePrice = fuelType !== undefined;
    const pricesToSave = singlePrice
      ? [{ fuelType: fuelType.trim(), price: pricePerLiter }]
      : [
        { fuelType: 'Diesel', price: requestedDieselPrice },
        { fuelType: 'Gasolina', price: requestedGasolinePrice },
      ];
    const fuelPrices = await withTenantContext(null, 'super_admin', async (client) => {
      const savedPrices = [];
      for (const item of pricesToSave) {
        const result = await client.query(
          `INSERT INTO public.fuel_price_settings (
             country, currency, tenant_id, fuel_type, price_per_liter
           )
           VALUES ($1, $2, $3::uuid, $4, $5)
           ON CONFLICT ON CONSTRAINT fuel_price_settings_scope_unique
           DO UPDATE SET price_per_liter = EXCLUDED.price_per_liter,
                         updated_at = NOW()
           RETURNING *`,
          [
            country.trim(),
            currency.trim().toUpperCase(),
            tenantId,
            item.fuelType,
            item.price,
          ],
        );
        savedPrices.push(result.rows[0]);
      }
      return savedPrices;
    });
    return res.status(200).json(singlePrice
      ? { fuelPrice: fuelPrices[0] }
      : { fuelPrices });
  } catch (error) {
    return next(error);
  }
});

router.delete('/fuel-prices/:id', async (req, res, next) => {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador do preço inválido.' });
  }

  try {
    const result = await withTenantContext(null, 'super_admin', (client) =>
      client.query(
        `DELETE FROM public.fuel_price_settings
         WHERE id = $1::uuid
         RETURNING id`,
        [req.params.id],
      ),
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Preço de combustível não encontrado.' });
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

export default router;