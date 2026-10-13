// src/routes/assets.js
import express from 'express';
import multer from 'multer';
import { basename } from 'node:path';
import { withTenantContext } from '../db.js';
import {
  authenticateToken,
  checkTenantLimits,
  enforceDomainScope,
} from '../middlewares/auth.js';
import {
  getSignedFileUrl,
  removeAssetFile,
  uploadAssetFile,
} from '../services/storage.js';

const router = express.Router();
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const MAX_DOCUMENT_SIZE_BYTES = 20 * 1024 * 1024;
const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const ASSET_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DOCUMENT_TYPES = new Set([
  'tech_sheet',
  'manual',
  'diagram',
  'inspection_certificate',
  'insurance',
  'asset_photo',
]);
const DOCUMENT_TYPE_LABELS = new Map([
  ['ficha_tecnica', 'tech_sheet'],
  ['ficha_tecnica_do_ativo', 'tech_sheet'],
  ['manual', 'manual'],
  ['diagrama', 'diagram'],
  ['certificado_de_inspecao', 'inspection_certificate'],
  ['certificado_de_vistoria', 'inspection_certificate'],
  ['seguro', 'insurance'],
  ['apolice', 'insurance'],
  ['foto', 'asset_photo'],
  ['fotografia', 'asset_photo'],
  ['foto_do_ativo', 'asset_photo'],
  ['fotografia_do_ativo', 'asset_photo'],
]);

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES, files: 1 },
  fileFilter(req, file, callback) {
    if (ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype)) {
      return callback(null, true);
    }

    const error = new Error('Tipo de arquivo não permitido.');
    error.code = 'UNSUPPORTED_FILE_TYPE';
    return callback(error);
  },
});

router.use(authenticateToken, enforceDomainScope);

function handleDocumentUpload(req, res, next) {
  documentUpload.single('file')(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: error.message });
    }

    if (error.code === 'UNSUPPORTED_FILE_TYPE') {
      return res.status(415).json({ error: error.message });
    }

    return next(error);
  });
}

function getSafeDocumentName(originalName) {
  const name = basename(originalName.replaceAll('\\', '/'))
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .slice(0, 200);

  return name && name !== '.' && name !== '..' ? name : 'document';
}

function normalizeDocumentType(value) {
  if (typeof value !== 'string') return null;

  const normalized = value
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const documentType = DOCUMENT_TYPE_LABELS.get(normalized) ?? normalized;

  return DOCUMENT_TYPES.has(documentType) ? documentType : null;
}

function requireTenant(req, res, next) {
  if (!req.user.tenantId) {
    return res.status(403).json({ error: 'A empresa do utilizador não está definida.' });
  }
  return next();
}

function validateAssetId(req, res, next) {
  if (!ASSET_ID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador do ativo inválido.' });
  }
  return next();
}

router.post('/:id/documents', requireTenant, validateAssetId, handleDocumentUpload, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum ficheiro foi enviado. Anexe um ficheiro no campo "file".' });
  }
  if (req.file.size === 0) {
    return res.status(400).json({ error: 'O ficheiro não pode estar vazio.' });
  }
  const documentType = normalizeDocumentType(req.body.documentType)
    ?? normalizeDocumentType(req.body.document_type);
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (!documentType || !title || title.length > 255) {
    return res.status(400).json({ error: 'Tipo de documento ou título inválido.' });
  }

  const fileName = getSafeDocumentName(req.file.originalname);
  let uploaded = false;
  let storagePath;

  try {
    storagePath = await uploadAssetFile(
      req.user.tenantId,
      req.params.id,
      req.file.buffer,
      fileName,
      req.file.mimetype,
    );
    uploaded = true;

    const scopeClause = req.userScope ? 'AND assets.domain = $10' : '';
    const values = [
      req.user.tenantId,
      req.params.id,
      documentType,
      title,
      storagePath,
      fileName,
      req.file.mimetype,
      req.file.size,
      req.user.id,
    ];
    if (req.userScope) values.push(req.userScope);
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `INSERT INTO public.asset_documents (
           tenant_id, asset_id, document_type, title, file_url, file_name,
           storage_path, mime_type, file_size_bytes, uploaded_by
         )
         SELECT $1, assets.id, $3, $4, $5, $6, $5, $7, $8, $9
         FROM public.assets AS assets
         WHERE assets.id = $2
           AND assets.tenant_id = $1
           AND assets.deleted_at IS NULL
           ${scopeClause}
         RETURNING id, tenant_id, asset_id, document_type, title, file_name,
                   file_url, mime_type, file_size_bytes, uploaded_by, created_at`,
        values,
      ),
    );

    if (result.rows.length === 0) {
      await removeAssetFile(storagePath);
      uploaded = false;
      return res.status(404).json({ error: 'Ativo não encontrado.' });
    }

    return res.status(201).json({ document: result.rows[0] });
  } catch (error) {
    if (uploaded && storagePath) {
      try {
        await removeAssetFile(storagePath);
      } catch (cleanupError) {
        console.error('Erro ao remover ficheiro após falha no registo:', cleanupError);
      }
    }

    console.error('Erro ao carregar documento do ativo:', error);
    return res.status(500).json({ error: 'Erro interno ao carregar documento do ativo.' });
  }
});

router.get('/:id/documents', requireTenant, validateAssetId, async (req, res) => {
  try {
    const documents = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const values = [req.params.id, req.user.tenantId];
      const scopeClause = req.userScope ? 'AND domain = $3' : '';
      if (req.userScope) values.push(req.userScope);
      const assetResult = await client.query(
        `SELECT id
         FROM public.assets
         WHERE id = $1
           AND tenant_id = $2
           AND deleted_at IS NULL
           ${scopeClause}`,
        values,
      );

      if (assetResult.rows.length === 0) return null;

      const documentResult = await client.query(
        `SELECT id, tenant_id, asset_id, document_type, title, file_name,
                storage_path, mime_type, file_size_bytes, created_at
         FROM public.asset_documents
         WHERE asset_id = $1
           AND tenant_id = $2
           AND storage_path IS NOT NULL
         ORDER BY created_at DESC`,
        [req.params.id, req.user.tenantId],
      );

      return documentResult.rows;
    });

    if (documents === null) {
      return res.status(404).json({ error: 'Ativo não encontrado.' });
    }

    const documentsWithUrls = await Promise.all(
      documents.map(async ({ storage_path: storagePath, ...document }) => ({
        ...document,
        signed_url: await getSignedFileUrl(storagePath),
      })),
    );

    return res.json({ documents: documentsWithUrls });
  } catch (error) {
    console.error('Erro ao listar documentos do ativo:', error);
    return res.status(500).json({ error: 'Erro interno ao listar documentos do ativo.' });
  }
});

// 1. LISTAR ATIVOS (Apenas os não eliminados)
router.get('/', requireTenant, async (req, res) => {
  try {
    const values = [req.user.tenantId, req.userScope];
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `
      SELECT 
        id, code_tag, name, category, criticality_level, brand, model, manufacture_year, domain,
        current_meter, meter_kind, status, cost_center,
        license_plate, chassis_vin, engine_number, inatro_inspection_expiry,
        insurance_policy_number, insurance_company, insurance_expiry, fuel_tank_capacity_liters,
        plant_sector, voltage_specs, power_kw_kva, innoq_calibration_expiry,
        pressure_test_expiry, local_supplier_name, warranty_expiry, technical_specs,
        created_at
      FROM public.assets
      WHERE deleted_at IS NULL
        AND tenant_id = $1
        AND (domain = $2 OR to_jsonb(public.assets)->>'operational_scope' = $2)
      ORDER BY created_at DESC;
    `,
        values,
      ),
    );
    res.json({ assets: result.rows });
  } catch (error) {
    console.error('Erro ao listar ativos:', error);
    res.status(500).json({ error: 'Erro interno ao listar ativos' });
  }
});

// 2. OBTER ATIVO ESPECÍFICO PELO ID
router.get('/:id', requireTenant, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `SELECT * FROM public.assets
         WHERE (id::text = $1 OR code_tag = $1)
           AND tenant_id = $2
           AND deleted_at IS NULL
           ${req.userScope ? 'AND domain = $3' : ''};`,
        req.userScope ? [id, req.user.tenantId, req.userScope] : [id, req.user.tenantId],
      ),
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ativo não encontrado ou sem permissão de acesso.' });
    }

    return res.json({ asset: rows[0] });
  } catch (error) {
    console.error('Erro ao obter ativo:', error);
    return res.status(500).json({ error: 'Erro interno ao consultar ativo' });
  }
});

router.patch('/:id/meter', requireTenant, async (req, res) => {
  const { meterValue } = req.body ?? {};
  if (typeof meterValue !== 'number' || !Number.isFinite(meterValue) || meterValue < 0) {
    return res.status(400).json({ error: 'Valor do contador inválido.' });
  }

  try {
    const asset = await withTenantContext(req.user.tenantId, req.user.role, async (client) => {
      const currentAsset = await client.query(
        `SELECT id, current_meter
         FROM public.assets
         WHERE (id::text = $1 OR code_tag = $1)
           AND tenant_id = $2
           AND deleted_at IS NULL
           ${req.userScope ? 'AND domain = $3' : ''}
         FOR UPDATE;`,
        req.userScope
          ? [req.params.id, req.user.tenantId, req.userScope]
          : [req.params.id, req.user.tenantId],
      );

      if (currentAsset.rows.length === 0) return null;
      if (
        currentAsset.rows[0].current_meter !== null
        && meterValue < Number(currentAsset.rows[0].current_meter)
      ) {
        return { meterCannotDecrease: true };
      }

      const result = await client.query(
        `UPDATE public.assets
         SET current_meter = $1, updated_at = NOW()
         WHERE id = $2
           AND tenant_id = $3
           AND deleted_at IS NULL
           ${req.userScope ? 'AND domain = $4' : ''}
         RETURNING *;`,
        req.userScope
          ? [meterValue, currentAsset.rows[0].id, req.user.tenantId, req.userScope]
          : [meterValue, currentAsset.rows[0].id, req.user.tenantId],
      );
      return { asset: result.rows[0] };
    });

    if (asset === null) {
      return res.status(404).json({ error: 'Ativo não encontrado ou sem permissão de acesso.' });
    }
    if ('meterCannotDecrease' in asset) {
      return res.status(400).json({ error: 'O novo valor do contador não pode ser inferior à leitura atual.' });
    }

    return res.status(200).json({ asset: asset.asset, message: 'Contador atualizado com sucesso.' });
  } catch (error) {
    console.error('Erro ao atualizar contador do ativo:', error);
    return res.status(500).json({ error: 'Erro interno ao atualizar contador do ativo.' });
  }
});

// 3. CRIAR NOVO ATIVO (Com geração automática de código se não fornecido)
router.post('/', requireTenant, checkTenantLimits('assets'), async (req, res) => {
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

    const assetDomain = req.userScope;
    if (!['fleet', 'plant'].includes(assetDomain)) {
      return res.status(400).json({ error: 'Domínio do ativo inválido.' });
    }

    let finalCodeTag = emptyToNull(codeTag);
    if (!finalCodeTag) {
      const codeRes = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
        client.query(
          'SELECT public.fn_generate_asset_code($1::uuid, $2::varchar) AS generated_code;',
          [req.user.tenantId, category],
        ),
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
        pressure_test_expiry, local_supplier_name, warranty_expiry, technical_specs, domain
      ) VALUES (
        $1, $2, $3, $4, COALESCE($5, 'B'), $6, $7, $8,
        COALESCE($9, 0), COALESCE($10, 'odometer_km')::meter_type, $11,
        $12, $13, $14, $15,
        $16, $17, $18, $19,
        $20, $21, $22, $23,
        $24, $25, $26, COALESCE($27, '{}'::jsonb), $28
      ) RETURNING *;
    `;

    const values = [
      req.user.tenantId, finalCodeTag, name, category, emptyToNull(criticalityLevel),
      emptyToNull(brand), emptyToNull(model), emptyToNull(manufactureYear),
      emptyToNull(currentMeter) ?? 0, emptyToNull(meterKind) ?? 'odometer_km',
      emptyToNull(costCenter), emptyToNull(licensePlate), emptyToNull(chassisVin),
      emptyToNull(engineNumber), emptyToNull(inatroInspectionExpiry),
      emptyToNull(insurancePolicyNumber), emptyToNull(insuranceCompany),
      emptyToNull(insuranceExpiry), emptyToNull(fuelTankCapacityLiters),
      emptyToNull(plantSector), emptyToNull(voltageSpecs), emptyToNull(powerKwKva),
      emptyToNull(innoqCalibrationExpiry), emptyToNull(pressureTestExpiry),
      emptyToNull(localSupplierName), emptyToNull(warrantyExpiry),
      emptyToNull(technicalSpecs) ? JSON.stringify(technicalSpecs) : '{}',
      assetDomain,
    ];

    const { rows } = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(insertQuery, values),
    );
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
router.put('/:id', requireTenant, async (req, res) => {
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
      WHERE id = $25 AND deleted_at IS NULL AND tenant_id = $26
        ${req.userScope ? 'AND domain = $27' : ''}
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
      id, req.user.tenantId
    ];

    if (req.userScope) values.push(req.userScope);
    const { rows } = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(updateQuery, values),
    );
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
router.delete('/:id', requireTenant, async (req, res) => {
  try {
    const { id } = req.params;
    const values = [id, req.user.tenantId];
    const scopeClause = req.userScope ? 'AND domain = $3' : '';
    if (req.userScope) values.push(req.userScope);
    const { rows } = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `UPDATE public.assets SET deleted_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL AND tenant_id = $2 ${scopeClause}
         RETURNING id, code_tag;`,
        values,
      ),
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