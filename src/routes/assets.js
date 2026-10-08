// src/routes/assets.js
import express from 'express';
import pool from '../db.js';
import { requireAuth } from '../middlewares/auth.js';

const router = express.Router();

router.use(requireAuth);

// 1. LISTAR ATIVOS (Apenas os não eliminados)
router.get('/', async (req, res) => {
  try {
    const query = `
      SELECT 
        id, code_tag, name, category, criticality_level, brand, model, manufacture_year,
        current_meter, meter_kind, status, cost_center,
        license_plate, chassis_vin, engine_number, inatro_inspection_expiry,
        insurance_policy_number, insurance_company, insurance_expiry, fuel_tank_capacity_liters,
        plant_sector, voltage_specs, power_kw_kva, innoq_calibration_expiry,
        pressure_test_expiry, local_supplier_name, warranty_expiry, technical_specs,
        created_at
      FROM public.assets
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC;
    `;
    const { rows } = await pool.query(query);
    res.json({ assets: rows });
  } catch (error) {
    console.error('Erro ao listar ativos:', error);
    res.status(500).json({ error: 'Erro interno ao listar ativos' });
  }
});

// 2. OBTER ATIVO ESPECÍFICO PELO ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT * FROM public.assets WHERE id = $1 AND deleted_at IS NULL;',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ativo não encontrado' });
    }

    res.json({ asset: rows[0] });
  } catch (error) {
    console.error('Erro ao obter ativo:', error);
    res.status(500).json({ error: 'Erro interno ao consultar ativo' });
  }
});

// 3. CRIAR NOVO ATIVO (Com geração automática de código se não fornecido)
router.post('/', async (req, res) => {
  try {
    const {
      codeTag, name, category, criticalityLevel, brand, model, manufactureYear,
      currentMeter, meterKind, costCenter,
      licensePlate, chassisVin, engineNumber, inatroInspectionExpiry,
      insurancePolicyNumber, insuranceCompany, insuranceExpiry, fuelTankCapacityLiters,
      plantSector, voltageSpecs, powerKwKva, innoqCalibrationExpiry,
      pressureTestExpiry, localSupplierName, warrantyExpiry, technicalSpecs
    } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'Nome e categoria são obrigatórios.' });
    }

    let finalCodeTag = codeTag;
    if (!finalCodeTag || finalCodeTag.trim() === '') {
      const codeRes = await pool.query(
        'SELECT public.fn_generate_asset_code($1::uuid, $2::varchar) AS generated_code;',
        [req.user.tenantId, category]
      );
      finalCodeTag = codeRes.rows[0].generated_code;
    }

    const insertQuery = `
      INSERT INTO public.assets (
        tenant_id, code_tag, name, category, criticality_level, brand, model, manufacture_year,
        current_meter, meter_kind, cost_center,
        license_plate, chassis_vin, engine_number, inatro_inspection_expiry,
        insurance_policy_number, insurance_company, insurance_expiry, fuel_tank_capacity_liters,
        plant_sector, voltage_specs, power_kw_kva, innoq_calibration_expiry,
        pressure_test_expiry, local_supplier_name, warranty_expiry, technical_specs
      ) VALUES (
        $1, $2, $3, $4, COALESCE($5, 'B'), $6, $7, $8,
        COALESCE($9, 0), COALESCE($10, 'odometer_km'), $11,
        $12, $13, $14, $15,
        $16, $17, $18, $19,
        $20, $21, $22, $23,
        $24, $25, $26, COALESCE($27, '{}'::jsonb)
      ) RETURNING *;
    `;

    const values = [
      req.user.tenantId, finalCodeTag, name, category, criticalityLevel, brand, model, manufactureYear || null,
      currentMeter || 0, meterKind || 'odometer_km', costCenter || null,
      licensePlate || null, chassisVin || null, engineNumber || null, inatroInspectionExpiry || null,
      insurancePolicyNumber || null, insuranceCompany || null, insuranceExpiry || null, fuelTankCapacityLiters || null,
      plantSector || null, voltageSpecs || null, powerKwKva || null, innoqCalibrationExpiry || null,
      pressureTestExpiry || null, localSupplierName || null, warrantyExpiry || null, technicalSpecs ? JSON.stringify(technicalSpecs) : '{}'
    ];

    const { rows } = await pool.query(insertQuery, values);
    res.status(201).json({ asset: rows[0] });
  } catch (error) {
    console.error('Erro ao criar ativo:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Já existe um ativo com este código/matrícula nesta empresa.' });
    }
    res.status(500).json({ error: 'Erro interno ao cadastrar ativo' });
  }
});

// 4. ATUALIZAR ATIVO (Edição com auditoria automática pelo trigger)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, category, criticalityLevel, brand, model, manufactureYear,
      costCenter, status,
      licensePlate, chassisVin, engineNumber, inatroInspectionExpiry,
      insurancePolicyNumber, insuranceCompany, insuranceExpiry, fuelTankCapacityLiters,
      plantSector, voltageSpecs, powerKwKva, innoqCalibrationExpiry,
      pressureTestExpiry, localSupplierName, warrantyExpiry, technicalSpecs
    } = req.body;

    const updateQuery = `
      UPDATE public.assets SET
        name = COALESCE($1, name),
        category = COALESCE($2, category),
        criticality_level = COALESCE($3, criticality_level),
        brand = COALESCE($4, brand),
        model = COALESCE($5, model),
        manufacture_year = COALESCE($6, manufacture_year),
        cost_center = COALESCE($7, cost_center),
        status = COALESCE($8, status),
        license_plate = COALESCE($9, license_plate),
        chassis_vin = COALESCE($10, chassis_vin),
        engine_number = COALESCE($11, engine_number),
        inatro_inspection_expiry = COALESCE($12, inatro_inspection_expiry),
        insurance_policy_number = COALESCE($13, insurance_policy_number),
        insurance_company = COALESCE($14, insurance_company),
        insurance_expiry = COALESCE($15, insurance_expiry),
        fuel_tank_capacity_liters = COALESCE($16, fuel_tank_capacity_liters),
        plant_sector = COALESCE($17, plant_sector),
        voltage_specs = COALESCE($18, voltage_specs),
        power_kw_kva = COALESCE($19, power_kw_kva),
        innoq_calibration_expiry = COALESCE($20, innoq_calibration_expiry),
        pressure_test_expiry = COALESCE($21, pressure_test_expiry),
        local_supplier_name = COALESCE($22, local_supplier_name),
        warranty_expiry = COALESCE($23, warranty_expiry),
        technical_specs = COALESCE($24, technical_specs),
        updated_at = NOW()
      WHERE id = $25 AND deleted_at IS NULL
      RETURNING *;
    `;

    const values = [
      name, category, criticalityLevel, brand, model, manufactureYear,
      costCenter, status,
      licensePlate, chassisVin, engineNumber, inatroInspectionExpiry,
      insurancePolicyNumber, insuranceCompany, insuranceExpiry, fuelTankCapacityLiters,
      plantSector, voltageSpecs, powerKwKva, innoqCalibrationExpiry,
      pressureTestExpiry, localSupplierName, warrantyExpiry,
      technicalSpecs ? JSON.stringify(technicalSpecs) : null,
      id
    ];

    const { rows } = await pool.query(updateQuery, values);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ativo não encontrado para atualização' });
    }

    res.json({ asset: rows[0] });
  } catch (error) {
    console.error('Erro ao atualizar ativo:', error);
    res.status(500).json({ error: 'Erro interno ao atualizar ativo' });
  }
});

// 5. SOFT-DELETE (Inativação com auditoria)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'UPDATE public.assets SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, code_tag;',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ativo não encontrado ou já removido' });
    }

    res.json({ message: 'Ativo arquivado com sucesso', asset: rows[0] });
  } catch (error) {
    console.error('Erro ao arquivar ativo:', error);
    res.status(500).json({ error: 'Erro interno ao remover ativo' });
  }
});

export default router;