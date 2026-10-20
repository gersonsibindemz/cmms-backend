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
const ASSET_CATEGORIES = new Set([
  'vehicle_light',
  'vehicle_heavy',
  'machinery',
  'plant_equipment',
  'generator',
]);
const ASSET_METER_KINDS = new Set(['odometer_km', 'hourmeter_hours']);
const ASSET_STATUSES = new Set([
  'operational',
  'under_maintenance',
  'breakdown',
  'decommissioned',
]);
const ASSET_CATEGORY_CODES = new Map([
  ['CAT-01', 'vehicle_light'],
  ['CAT-02', 'vehicle_light'],
  ['CAT-03', 'vehicle_heavy'],
  ['CAT-04', 'vehicle_heavy'],
  ['CAT-05', 'vehicle_light'],
  ['CAT-06', 'vehicle_heavy'],
  ['CAT-07', 'machinery'],
  ['CAT-08', 'machinery'],
  ['CAT-09', 'machinery'],
  ['CAT-10', 'machinery'],
  ['CAT-11', 'vehicle_heavy'],
  ['CAT-12', 'vehicle_heavy'],
  ['CAT-13', 'vehicle_light'],
  ['CAT-14', 'machinery'],
]);
const ASSET_CATEGORY_LABELS = new Map([
  ['light vehicle', 'vehicle_light'],
  ['veiculo ligeiro', 'vehicle_light'],
  ['veiculos ligeiros', 'vehicle_light'],
  ['heavy vehicle', 'vehicle_heavy'],
  ['veiculo pesado', 'vehicle_heavy'],
  ['veiculos pesados', 'vehicle_heavy'],
  ['trela', 'vehicle_heavy'],
  ['trelas', 'vehicle_heavy'],
  ['trailer', 'vehicle_heavy'],
  ['trailers', 'vehicle_heavy'],
  ['reboque', 'vehicle_heavy'],
  ['reboques', 'vehicle_heavy'],
  ['transporte de passageiros', 'vehicle_heavy'],
  ['motociclo', 'vehicle_light'],
  ['motociclos', 'vehicle_light'],
  ['equipamentos de elevacao', 'machinery'],
  ['veiculos de servico especial', 'vehicle_heavy'],
  ['veiculos de emergencia', 'vehicle_heavy'],
  ['veiculos eletricos', 'vehicle_light'],
  ['equipment', 'plant_equipment'],
  ['equipamento', 'plant_equipment'],
  ['equipamentos', 'plant_equipment'],
  ['gerador', 'generator'],
  ['geradores', 'generator'],
]);
const TECHNICAL_SHEET_BLOCK_KEYS = [
  ['identification', 'identification', 'identificacao'],
  ['manufacturer', 'manufacturer', 'fabricante'],
  ['technical_characteristics', 'technicalCharacteristics', 'technical_characteristics', 'caracteristicasTecnicas', 'caracteristicas_tecnicas'],
  ['operating_meters', 'operatingMeters', 'operating_meters', 'medidoresOperacao', 'medidores_operacao'],
  ['acquisition_compliance', 'acquisitionCompliance', 'acquisition_compliance', 'aquisicaoConformidade', 'aquisicao_conformidade'],
  ['maintenance_plan', 'maintenancePlan', 'maintenance_plan', 'planoManutencao', 'plano_manutencao'],
  ['safety_checks', 'safetyChecks', 'safety_checks', 'verificacoesSeguranca', 'verificacoes_seguranca'],
];
const ASSET_FORM_FIELDS = [
  { key: 'equipment_code', type: 'string' },
  { key: 'department', type: 'string' },
  { key: 'criticality', type: 'string' },
  { key: 'operator_name', type: 'string' },
  { key: 'manufacturer', type: 'string' },
  { key: 'model_version', type: 'string' },
  { key: 'serial_number', type: 'string' },
  { key: 'chassis_number', type: 'string' },
  { key: 'color_config', type: 'string' },
  { key: 'initial_km', type: 'nonnegative-number' },
  { key: 'initial_hour_meter', type: 'nonnegative-number' },
  { key: 'measurement_unit', type: 'string' },
  { key: 'operational_shift', type: 'string' },
  { key: 'acquisition_date', type: 'date' },
  { key: 'operation_start_date', type: 'date' },
  { key: 'acquisition_value', type: 'nonnegative-number' },
  { key: 'currency', type: 'currency' },
  { key: 'vendor_supplier', type: 'string' },
  { key: 'warranty_until', type: 'date' },
  { key: 'next_inspection_date', type: 'date' },
  { key: 'maintenance_plan_id', type: 'uuid' },
  { key: 'maintenance_type', type: 'string' },
];
const ASSET_FORM_FIELD_ALIASES = {
  equipment_code: ['equipmentCode'],
  cost_center: ['costCenter'],
  criticality: ['criticalityLevel', 'criticality_level'],
  operator_name: ['operatorName'],
  manufacturer: ['brand'],
  model_version: ['modelVersion', 'model'],
  manufacture_year: ['manufactureYear'],
  serial_number: ['serialNumber'],
  chassis_number: ['chassisNumber', 'chassisVin', 'chassis_vin'],
  engine_number: ['engineNumber'],
  initial_km: ['initialKm'],
  initial_hour_meter: ['initialHourMeter'],
  measurement_unit: ['measurementUnit'],
  operational_shift: ['operationalShift'],
  acquisition_date: ['acquisitionDate'],
  operation_start_date: ['operationStartDate'],
  acquisition_value: ['acquisitionValue'],
  vendor_supplier: ['vendorSupplier'],
  warranty_until: ['warrantyUntil'],
  insurance_expiry: ['insuranceExpiry'],
  next_inspection_date: ['nextInspectionDate'],
  maintenance_plan_id: ['maintenancePlanId'],
  maintenance_type: ['maintenanceType'],
};
const INVALID_ASSET_CATEGORY_ERROR =
  'Categoria inválida. Use uma categoria válida ou um código/rótulo de categoria reconhecido.';

function normalizeAssetCategory(value) {
  if (typeof value !== 'string') return null;
  const category = value.trim();
  const label = category.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const normalizedCategory = ASSET_CATEGORY_CODES.get(category.toUpperCase())
    ?? ASSET_CATEGORY_LABELS.get(label)
    ?? category.toLowerCase();
  return ASSET_CATEGORIES.has(normalizedCategory) ? normalizedCategory : null;
}

function firstPresent(body, ...keys) {
  const key = keys.find((candidate) => Object.hasOwn(body, candidate));
  return key === undefined ? undefined : body[key];
}

function getAssetInputSources(body) {
  const sources = [];
  const wrapperKeys = [
    'technicalSheet', 'technical_sheet', 'fichaTecnica', 'ficha_tecnica',
  ];
  for (const key of wrapperKeys) {
    const value = body[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) sources.push(value);
  }
  for (const [, ...aliases] of TECHNICAL_SHEET_BLOCK_KEYS) {
    for (const key of aliases) {
      const value = body[key] ?? sources.flatMap((source) => [source[key]])
        .find((candidate) => candidate !== undefined);
      if (value && typeof value === 'object' && !Array.isArray(value)) sources.push(value);
    }
  }
  return sources;
}

function findAssetInput(body, ...keys) {
  const directKey = keys.find((key) => Object.hasOwn(body, key));
  if (directKey !== undefined) return { key: directKey, value: body[directKey] };
  for (const source of getAssetInputSources(body)) {
    const key = keys.find((candidate) => Object.hasOwn(source, candidate));
    if (key !== undefined) return { key, value: source[key] };
  }
  return { key: undefined, value: undefined };
}

function assetInput(body, ...keys) {
  return findAssetInput(body, ...keys).value;
}

function normalizeAssetFormFields(body) {
  const values = {};
  for (const field of ASSET_FORM_FIELDS) {
    const { key, value } = findAssetInput(
      body, field.key, ...(ASSET_FORM_FIELD_ALIASES[field.key] ?? []),
    );
    if (key === undefined) continue;
    if (value === null || value === '') {
      values[field.key] = null;
      continue;
    }
    if (field.type === 'string') {
      if (typeof value !== 'string') throw new Error(`Campo inválido: ${key}.`);
      values[field.key] = value.trim() || null;
    } else if (field.type === 'date') {
      if (!isValidDateInput(value)) throw new Error(`Data inválida: ${key}.`);
      values[field.key] = value || null;
    } else if (field.type === 'currency') {
      if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) {
        throw new Error('A moeda deve ser informada com um código de três letras.');
      }
      values[field.key] = value.trim().toUpperCase();
    } else if (field.type === 'uuid') {
      if (typeof value !== 'string' || !ASSET_ID_PATTERN.test(value)) {
        throw new Error(`Identificador inválido: ${key}.`);
      }
      values[field.key] = value;
    } else {
      const number = normalizeOptionalNumber(value, key);
      if (field.type === 'nonnegative-number' && number !== null && number < 0) {
        throw new Error(`Campo inválido: ${key}.`);
      }
      values[field.key] = number;
    }
  }
  return values;
}

function normalizeJsonObject(value, fieldName) {
  let result = value;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      throw new Error(`${fieldName} deve conter um objeto JSON válido.`);
    }
  }
  if (result === undefined || result === null || result === '') return {};
  if (typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`${fieldName} deve ser um objeto.`);
  }
  return result;
}

function buildTechnicalSpecs(body) {
  const providedSpecs = assetInput(body, 'technicalSpecs', 'technical_specs');
  const technicalSpecs = { ...normalizeJsonObject(providedSpecs, 'technical_specs') };

  const bodySheet = firstPresent(
    body, 'technicalSheet', 'technical_sheet', 'fichaTecnica', 'ficha_tecnica',
  );
  const storedSheet = technicalSpecs.ficha_tecnica ?? technicalSpecs.technical_sheet;
  for (const sheet of [bodySheet, storedSheet]) {
    if (
      sheet !== undefined &&
      (sheet === null || typeof sheet !== 'object' || Array.isArray(sheet))
    ) {
      throw new Error('A ficha técnica deve ser um objeto.');
    }
  }
  const fichaTecnica = { ...(bodySheet ?? {}), ...(storedSheet ?? {}) };
  let hasFichaTecnica = Object.keys(fichaTecnica).length > 0;
  for (const [blockName, ...aliases] of TECHNICAL_SHEET_BLOCK_KEYS) {
    if (blockName === 'safety_checks') continue;
    const found = findAssetInput(body, ...aliases);
    if (found.value === undefined) continue;
    if (
      found.value === null ||
      typeof found.value !== 'object' ||
      Array.isArray(found.value)
    ) {
      throw new Error(`O bloco "${blockName}" da ficha técnica deve ser um objeto.`);
    }
    fichaTecnica[blockName] = found.value;
    hasFichaTecnica = true;
  }
  if (hasFichaTecnica) technicalSpecs.ficha_tecnica = fichaTecnica;
  return technicalSpecs;
}

function buildSafetyChecks(body) {
  const providedChecks = assetInput(body, 'safetyChecks', 'safety_checks');
  return normalizeJsonObject(providedChecks, 'safety_checks');
}

function isValidMeterReading(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  if (typeof value !== 'string') return false;
  if (!value.trim()) return true;
  const reading = Number(value);
  return Number.isFinite(reading) && reading >= 0;
}

function normalizeOptionalNumber(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(normalized)) throw new Error(`Campo numérico inválido: ${fieldName}.`);
  return normalized;
}

function isValidDateInput(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return true;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

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
  const domain = req.query.domain;
  if (domain !== undefined && !['fleet', 'plant'].includes(domain)) {
    return res.status(400).json({ error: 'Escopo operacional inválido.' });
  }

  try {
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `
      SELECT 
        id, code_tag, name, category, criticality_level, brand, model, manufacture_year, domain,
        equipment_code, department, criticality, operator_name, manufacturer, model_version,
        serial_number, chassis_number, color_config, initial_km::double precision AS initial_km,
        initial_hour_meter::double precision AS initial_hour_meter, measurement_unit,
        operational_shift, acquisition_date, operation_start_date,
        acquisition_value::double precision AS acquisition_value, currency, vendor_supplier,
        warranty_until, next_inspection_date, maintenance_plan_id, maintenance_type,
        asset_type, asset_subtype, energy_type, ownership_type, axle_config,
        operational_scope, status, cost_center, province,
        license_plate, chassis_vin, engine_number, inatro_inspection_expiry,
        insurance_policy_number, insurance_company, insurance_expiry,
        fuel_tank_capacity_liters::double precision AS fuel_tank_capacity_liters,
        plant_sector, voltage_specs, power_kw_kva, innoq_calibration_expiry,
        pressure_test_expiry, local_supplier_name, warranty_expiry, technical_specs,
        safety_checks, created_at
      FROM public.assets
      WHERE tenant_id = $1::uuid
        AND ($2::text IS NULL OR domain = $2)
        AND deleted_at IS NULL
      ORDER BY created_at DESC;
    `,
        [req.user.tenantId, domain ?? null],
      ),
    );
    res.status(200).json({ assets: result.rows, total: result.rows.length });
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
        `SELECT *
         FROM public.assets
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

    return res.json({
      asset: {
        ...rows[0],
        current_meter: rows[0].current_meter === null ? null : Number(rows[0].current_meter),
        fuel_tank_capacity_liters: rows[0].fuel_tank_capacity_liters === null
          ? null
          : Number(rows[0].fuel_tank_capacity_liters),
      },
    });
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

router.post('/bulk', requireTenant, async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const { userScope } = req;
  const assets = req.body?.assets;

  if (!Array.isArray(assets) || assets.length === 0 || assets.length > 100) {
    return res.status(400).json({
      error: 'O lote deve conter entre 1 e 100 ativos.',
    });
  }

  try {
    const result = await withTenantContext(tenantId, req.user.role, async (client) => {
      const tenantResult = await client.query(
        `SELECT max_assets_limit
         FROM public.tenants
         WHERE id = $1::uuid
         FOR UPDATE`,
        [tenantId],
      );
      const tenant = tenantResult.rows[0];
      if (!tenant) return { tenantNotFound: true };

      const countResult = await client.query(
        `SELECT COUNT(*) AS total
         FROM public.assets
         WHERE tenant_id = $1::uuid
           AND deleted_at IS NULL`,
        [tenantId],
      );
      const total = Number(countResult.rows[0].total);
      const maxAssetsLimit = Number(tenant.max_assets_limit);
      if (total + assets.length > maxAssetsLimit) {
        return {
          limitExceeded: true,
          error: `O lote excede o limite contratado. Espaço disponível: ${maxAssetsLimit - total} ativos.`,
        };
      }

      const insertedRows = [];
      for (const [index, item] of assets.entries()) {
        try {
          if (
            item === null ||
            typeof item !== 'object' ||
            Array.isArray(item) ||
            typeof assetInput(item, 'name') !== 'string' ||
            !assetInput(item, 'name').trim() ||
            typeof assetInput(item, 'category', 'asset_category', 'assetCategory') !== 'string' ||
            !assetInput(item, 'category', 'asset_category', 'assetCategory').trim()
          ) {
            throw new Error('Nome e categoria são obrigatórios.');
          }
          const category = normalizeAssetCategory(
            assetInput(item, 'category', 'asset_category', 'assetCategory'),
          );
          if (!category) {
            throw new Error(INVALID_ASSET_CATEGORY_ERROR);
          }

          const codeTagValue = item.codeTag ?? item.code_tag;
          if (
            codeTagValue !== undefined &&
            codeTagValue !== null &&
            typeof codeTagValue !== 'string'
          ) {
            throw new Error('Código do ativo inválido.');
          }
          const codeTag = typeof codeTagValue === 'string' ? codeTagValue.trim() : '';
          const initialMeterValue = assetInput(item, 'initialMeter', 'initial_meter');
          const currentMeterValue = assetInput(item, 'currentMeter', 'current_meter');
          if (!isValidMeterReading(initialMeterValue) || !isValidMeterReading(currentMeterValue)) {
            throw new Error('Leitura do contador inválida.');
          }
          const initialMeter = emptyToNull(initialMeterValue) === null
            ? null
            : Number(initialMeterValue);
          const currentMeter = emptyToNull(currentMeterValue) === null
            ? 0
            : Number(currentMeterValue);

          for (const [field, ...aliases] of [
            ['brand'],
            ['model'],
            ['licensePlate', 'license_plate'],
            ['chassisVin', 'chassis_vin'],
            ['plantSector', 'plant_sector'],
            ['voltageSpecs', 'voltage_specs'],
            ['asset_type', 'assetType'],
            ['asset_subtype', 'assetSubtype'],
            ['energy_type', 'energyType'],
            ['ownership_type', 'ownershipType'],
          ]) {
            const value = assetInput(item, field, ...aliases);
            if (value !== undefined && value !== null && typeof value !== 'string') {
              throw new Error(`Campo inválido: ${field}.`);
            }
          }
          const axleConfig = assetInput(item, 'axle_config', 'axleConfig');
          if (axleConfig !== undefined && axleConfig !== null &&
            (!Number.isInteger(axleConfig) || axleConfig < 1)) {
            throw new Error('Configuração de eixos inválida.');
          }
          for (const field of ['manufactureYear', 'manufacture_year', 'powerKwKva', 'power_kw_kva']) {
            const value = assetInput(item, field);
            if (value !== undefined && value !== null &&
              typeof value !== 'number' && typeof value !== 'string') {
              throw new Error(`Campo inválido: ${field}.`);
            }
          }
          const technicalSpecs = buildTechnicalSpecs(item);
          const status = assetInput(item, 'status') ?? 'operational';
          if (!ASSET_STATUSES.has(status)) throw new Error('Estado do ativo inválido.');
          const meterKind = assetInput(item, 'meterKind', 'meter_kind')
            ?? (userScope === 'fleet' ? 'odometer_km' : 'hourmeter_hours');
          if (!ASSET_METER_KINDS.has(meterKind)) throw new Error('Tipo de contador inválido.');
          for (const [field, ...aliases] of [
            ['criticalityLevel', 'criticality_level'],
            ['costCenter', 'cost_center'],
            ['province'],
            ['engineNumber', 'engine_number'],
            ['inatroInspectionExpiry', 'inatro_inspection_expiry'],
            ['insurancePolicyNumber', 'insurance_policy_number'],
            ['insuranceCompany', 'insurance_company'],
            ['insuranceExpiry', 'insurance_expiry'],
            ['fuelTankCapacityLiters', 'fuel_tank_capacity_liters'],
            ['innoqCalibrationExpiry', 'innoq_calibration_expiry'],
            ['pressureTestExpiry', 'pressure_test_expiry'],
            ['localSupplierName', 'local_supplier_name'],
            ['warrantyExpiry', 'warranty_expiry'],
          ]) {
            const value = assetInput(item, field, ...aliases);
            if (value !== undefined && value !== null && typeof value !== 'string') {
              throw new Error(`Campo inválido: ${field}.`);
            }
          }
          for (const field of [
            'inatroInspectionExpiry', 'inatro_inspection_expiry',
            'insuranceExpiry', 'insurance_expiry',
            'innoqCalibrationExpiry', 'innoq_calibration_expiry',
            'pressureTestExpiry', 'pressure_test_expiry',
            'warrantyExpiry', 'warranty_expiry',
          ]) {
            if (!isValidDateInput(assetInput(item, field))) {
              throw new Error(`Data inválida: ${field}.`);
            }
          }
          const manufactureYear = normalizeOptionalNumber(
            assetInput(item, 'manufactureYear', 'manufacture_year'),
            'manufacture_year',
          );
          if (manufactureYear !== null && !Number.isInteger(manufactureYear)) {
            throw new Error('Ano de fabrico inválido.');
          }
          const fuelTankCapacityLiters = normalizeOptionalNumber(
            assetInput(item, 'fuelTankCapacityLiters', 'fuel_tank_capacity_liters'),
            'fuel_tank_capacity_liters',
          );
          const powerKwKva = normalizeOptionalNumber(
            assetInput(item, 'powerKwKva', 'power_kw_kva'),
            'power_kw_kva',
          );
          if (
            [fuelTankCapacityLiters, powerKwKva].some((value) => value !== null && value < 0)
          ) {
            throw new Error('Valor numérico não pode ser negativo.');
          }

          let finalCodeTag = codeTag;
          if (!finalCodeTag) {
            const codeResult = await client.query(
              'SELECT public.fn_generate_asset_code($1::uuid, $2::varchar) AS generated_code',
              [tenantId, category],
            );
            finalCodeTag = codeResult.rows[0]?.generated_code;
            if (typeof finalCodeTag !== 'string' || !finalCodeTag) {
              throw new Error('Não foi possível gerar o código do ativo.');
            }
          }

          const insertResult = await client.query(
            `INSERT INTO public.assets (
               tenant_id, domain, operational_scope, name, code_tag, category,
               criticality_level, status, brand, model, manufacture_year, meter_kind,
               initial_meter, current_meter, cost_center, province, license_plate, chassis_vin,
               engine_number, inatro_inspection_expiry, insurance_policy_number,
               insurance_company, insurance_expiry, fuel_tank_capacity_liters, plant_sector,
               voltage_specs, power_kw_kva, innoq_calibration_expiry, asset_type, asset_subtype,
               energy_type, ownership_type, axle_config, pressure_test_expiry,
               local_supplier_name, warranty_expiry, technical_specs
               )
               VALUES (
                 $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
                 $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37::jsonb
               )
               RETURNING *`,
            [
              tenantId,
              userScope,
              userScope,
              assetInput(item, 'name').trim(),
              finalCodeTag,
              category,
              assetInput(item, 'criticalityLevel', 'criticality_level') ?? null,
              status,
              assetInput(item, 'brand') ?? null,
              assetInput(item, 'model') ?? null,
              manufactureYear,
              meterKind,
              initialMeter,
              currentMeter,
              assetInput(item, 'costCenter', 'cost_center') ?? null,
              assetInput(item, 'province') ?? null,
              assetInput(item, 'licensePlate', 'license_plate') ?? null,
              assetInput(item, 'chassisVin', 'chassis_vin') ?? null,
              assetInput(item, 'engineNumber', 'engine_number') ?? null,
              emptyToNull(assetInput(item, 'inatroInspectionExpiry', 'inatro_inspection_expiry')),
              assetInput(item, 'insurancePolicyNumber', 'insurance_policy_number') ?? null,
              assetInput(item, 'insuranceCompany', 'insurance_company') ?? null,
              emptyToNull(assetInput(item, 'insuranceExpiry', 'insurance_expiry')),
              fuelTankCapacityLiters,
              assetInput(item, 'plantSector', 'plant_sector') ?? null,
              assetInput(item, 'voltageSpecs', 'voltage_specs') ?? null,
              powerKwKva,
              emptyToNull(assetInput(item, 'innoqCalibrationExpiry', 'innoq_calibration_expiry')),
              assetInput(item, 'asset_type', 'assetType') ?? null,
              assetInput(item, 'asset_subtype', 'assetSubtype') ?? null,
              assetInput(item, 'energy_type', 'energyType') ?? null,
              assetInput(item, 'ownership_type', 'ownershipType') ?? null,
              axleConfig,
              emptyToNull(assetInput(item, 'pressureTestExpiry', 'pressure_test_expiry')),
              assetInput(item, 'localSupplierName', 'local_supplier_name') ?? null,
              emptyToNull(assetInput(item, 'warrantyExpiry', 'warranty_expiry')),
              JSON.stringify(technicalSpecs),
            ],
          );
          insertedRows.push(insertResult.rows[0]);
        } catch (error) {
          error.bulkLine = index + 1;
          throw error;
        }
      }

      return { assets: insertedRows };
    });

    if (result.tenantNotFound) {
      return res.status(404).json({ error: 'Tenant não encontrado.' });
    }
    if (result.limitExceeded) {
      return res.status(400).json({ error: result.error });
    }
    return res.status(201).json({
      success: true,
      count: result.assets.length,
      assets: result.assets,
    });
  } catch (error) {
    if (error.bulkLine) {
      return res.status(400).json({
        error: `Erro na linha ${error.bulkLine}: ${error.message}`,
      });
    }
    return next(error);
  }
});

// 3. CRIAR NOVO ATIVO (Com geração automática de código se não fornecido)
router.post('/', requireTenant, checkTenantLimits('assets'), async (req, res) => {
  try {
    const body = req.body ?? {};
    const codeTag = assetInput(body, 'codeTag', 'code_tag', 'equipment_code', 'equipmentCode');
    const name = assetInput(body, 'name');
    const category = normalizeAssetCategory(
      assetInput(body, 'category', 'asset_category', 'assetCategory'),
    );
    let standardFields;
    let safetyChecks;
    try {
      standardFields = normalizeAssetFormFields(body);
      safetyChecks = buildSafetyChecks(body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const criticalityLevel = assetInput(body, 'criticalityLevel', 'criticality_level');
    const status = assetInput(body, 'status') ?? 'operational';
    const brand = assetInput(body, 'brand', 'manufacturer');
    const model = assetInput(body, 'model', 'model_version', 'modelVersion');
    const manufactureYear = assetInput(body, 'manufactureYear', 'manufacture_year');
    const initialMeter = assetInput(body, 'initialMeter', 'initial_meter');
    const currentMeter = assetInput(body, 'currentMeter', 'current_meter');
    const meterKind = assetInput(body, 'meterKind', 'meter_kind');
    const costCenter = assetInput(body, 'costCenter', 'cost_center');
    const province = assetInput(body, 'province');
    const licensePlate = assetInput(body, 'licensePlate', 'license_plate');
    const chassisVin = assetInput(
      body, 'chassisVin', 'chassis_vin', 'chassis_number', 'chassisNumber',
    );
    const engineNumber = assetInput(body, 'engineNumber', 'engine_number');
    const inatroInspectionExpiry = assetInput(
      body, 'inatroInspectionExpiry', 'inatro_inspection_expiry',
    );
    const insurancePolicyNumber = assetInput(
      body, 'insurancePolicyNumber', 'insurance_policy_number',
    );
    const insuranceCompany = assetInput(body, 'insuranceCompany', 'insurance_company');
    const insuranceExpiry = assetInput(body, 'insuranceExpiry', 'insurance_expiry');
    const fuelTankCapacityLiters = assetInput(
      body, 'fuelTankCapacityLiters', 'fuel_tank_capacity_liters',
    );
    const plantSector = assetInput(body, 'plantSector', 'plant_sector');
    const voltageSpecs = assetInput(body, 'voltageSpecs', 'voltage_specs');
    const powerKwKva = assetInput(body, 'powerKwKva', 'power_kw_kva');
    const innoqCalibrationExpiry = assetInput(
      body, 'innoqCalibrationExpiry', 'innoq_calibration_expiry',
    );
    const pressureTestExpiry = assetInput(body, 'pressureTestExpiry', 'pressure_test_expiry');
    const localSupplierName = assetInput(body, 'localSupplierName', 'local_supplier_name');
    const warrantyExpiry = assetInput(
      body, 'warrantyExpiry', 'warranty_expiry', 'warranty_until', 'warrantyUntil',
    );
    const assetType = assetInput(body, 'assetType', 'asset_type');
    const assetSubtype = assetInput(body, 'assetSubtype', 'asset_subtype');
    const energyType = assetInput(body, 'energyType', 'energy_type');
    const ownershipType = assetInput(body, 'ownershipType', 'ownership_type');
    const axleConfig = assetInput(body, 'axleConfig', 'axle_config');
    let normalizedManufactureYear;
    let normalizedFuelTankCapacityLiters;
    let normalizedPowerKwKva;
    try {
      normalizedManufactureYear = normalizeOptionalNumber(manufactureYear, 'manufacture_year');
      normalizedFuelTankCapacityLiters = normalizeOptionalNumber(
        fuelTankCapacityLiters, 'fuel_tank_capacity_liters',
      );
      normalizedPowerKwKva = normalizeOptionalNumber(powerKwKva, 'power_kw_kva');
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    let technicalSpecs;
    try {
      technicalSpecs = buildTechnicalSpecs(body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    if (
      typeof name !== 'string' || !name.trim()
      || !category
      || [assetType, assetSubtype, energyType, ownershipType].some(
        (value) => value !== undefined && value !== null
          && (typeof value !== 'string' || value.length > 255),
      )
      || (axleConfig !== undefined && axleConfig !== null
        && (!Number.isInteger(axleConfig) || axleConfig < 1))
      || (normalizedManufactureYear !== null && !Number.isInteger(normalizedManufactureYear))
      || !isValidMeterReading(initialMeter)
      || !isValidMeterReading(currentMeter)
      || (meterKind != null && meterKind !== ''
        && !ASSET_METER_KINDS.has(meterKind))
      || !ASSET_STATUSES.has(status)
      || [
        codeTag, criticalityLevel, brand, model, costCenter, province, licensePlate, chassisVin, engineNumber,
        inatroInspectionExpiry, insurancePolicyNumber, insuranceCompany, insuranceExpiry,
        plantSector, voltageSpecs, innoqCalibrationExpiry, pressureTestExpiry,
        localSupplierName, warrantyExpiry,
      ].some((value) => value !== undefined && value !== null && typeof value !== 'string')
      || [normalizedFuelTankCapacityLiters, normalizedPowerKwKva]
        .some((value) => value !== null && value < 0)
      || [
        inatroInspectionExpiry, insuranceExpiry, innoqCalibrationExpiry, pressureTestExpiry,
        warrantyExpiry,
      ].some((value) => !isValidDateInput(value))
    ) {
      if (typeof name === 'string' && name.trim() && !category) {
        return res.status(400).json({ error: INVALID_ASSET_CATEGORY_ERROR });
      }
      return res.status(400).json({ error: 'Dados do ativo inválidos.' });
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

    const standardColumns = ASSET_FORM_FIELDS.map(({ key }) => key);
    const standardPlaceholders = ASSET_FORM_FIELDS.map(
      (_, index) => `$${37 + index}`,
    );
    const safetyChecksPlaceholder = `$${37 + ASSET_FORM_FIELDS.length}::jsonb`;
    const insertQuery = `
      INSERT INTO public.assets (
        tenant_id, code_tag, name, category, criticality_level, status, brand, model, manufacture_year,
        initial_meter, current_meter, meter_kind, cost_center, province,
        license_plate, chassis_vin, engine_number, inatro_inspection_expiry,
        insurance_policy_number, insurance_company, insurance_expiry, fuel_tank_capacity_liters,
        plant_sector, voltage_specs, power_kw_kva, innoq_calibration_expiry,
        asset_type, asset_subtype, energy_type, ownership_type, axle_config,
        pressure_test_expiry, local_supplier_name, warranty_expiry, technical_specs, domain,
        ${standardColumns.join(', ')}, safety_checks
      ) VALUES (
        $1, $2, $3, $4, COALESCE($5, 'B'), $6, $7, $8, $9,
        $10, COALESCE($11, 0), COALESCE($12, 'odometer_km')::meter_type, $13, $14,
        $15, $16, $17, $18,
        $19, $20, $21, $22, $23,
        $24, $25, $26,
        $27, $28, $29, $30, $31,
        $32, $33, $34, COALESCE($35, '{}'::jsonb), $36,
        ${standardPlaceholders.join(', ')}, ${safetyChecksPlaceholder}
      ) RETURNING *;
    `;

    const values = [
      req.user.tenantId, finalCodeTag, name, category, emptyToNull(criticalityLevel),
      status, emptyToNull(brand), emptyToNull(model), normalizedManufactureYear,
      emptyToNull(initialMeter), emptyToNull(currentMeter) ?? 0,
      emptyToNull(meterKind) ?? (req.userScope === 'plant' ? 'hourmeter_hours' : 'odometer_km'),
      emptyToNull(costCenter), emptyToNull(province), emptyToNull(licensePlate), emptyToNull(chassisVin),
      emptyToNull(engineNumber), emptyToNull(inatroInspectionExpiry),
      emptyToNull(insurancePolicyNumber), emptyToNull(insuranceCompany),
      emptyToNull(insuranceExpiry), normalizedFuelTankCapacityLiters,
      emptyToNull(plantSector), emptyToNull(voltageSpecs), normalizedPowerKwKva,
      emptyToNull(innoqCalibrationExpiry),
      emptyToNull(assetType), emptyToNull(assetSubtype), emptyToNull(energyType),
      emptyToNull(ownershipType), emptyToNull(axleConfig),
      emptyToNull(pressureTestExpiry), emptyToNull(localSupplierName), emptyToNull(warrantyExpiry),
      emptyToNull(technicalSpecs) ? JSON.stringify(technicalSpecs) : '{}',
      assetDomain,
      ...ASSET_FORM_FIELDS.map(({ key }) => standardFields[key] ?? null),
      JSON.stringify(safetyChecks),
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
async function updateAsset(req, res) {
  try {
    const { id } = req.params;
    const body = req.body ?? {};
    let standardFields;
    try {
      standardFields = normalizeAssetFormFields(body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const fields = [
      ['name', 'name'],
      ['category', 'category'],
      ['assetType', 'asset_type'],
      ['assetSubtype', 'asset_subtype'],
      ['energyType', 'energy_type'],
      ['ownershipType', 'ownership_type'],
      ['axleConfig', 'axle_config'],
      ['criticalityLevel', 'criticality_level'],
      ['brand', 'brand'],
      ['model', 'model'],
      ['manufactureYear', 'manufacture_year'],
      ['initialMeter', 'initial_meter'],
      ['currentMeter', 'current_meter'],
      ['meterKind', 'meter_kind'],
      ['costCenter', 'cost_center'],
      ['province', 'province'],
      ['status', 'status'],
      ['licensePlate', 'license_plate'],
      ['chassisVin', 'chassis_vin'],
      ['engineNumber', 'engine_number'],
      ['inatroInspectionExpiry', 'inatro_inspection_expiry'],
      ['insurancePolicyNumber', 'insurance_policy_number'],
      ['insuranceCompany', 'insurance_company'],
      ['insuranceExpiry', 'insurance_expiry'],
      ['fuelTankCapacityLiters', 'fuel_tank_capacity_liters'],
      ['plantSector', 'plant_sector'],
      ['voltageSpecs', 'voltage_specs'],
      ['powerKwKva', 'power_kw_kva'],
      ['innoqCalibrationExpiry', 'innoq_calibration_expiry'],
      ['pressureTestExpiry', 'pressure_test_expiry'],
      ['localSupplierName', 'local_supplier_name'],
      ['warrantyExpiry', 'warranty_expiry'],
    ];

    const values = [];
    const assignments = [];
    for (const [bodyKey, column] of fields) {
      const snakeKey = bodyKey.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      const aliases = {
        category: ['asset_category', 'assetCategory'],
        brand: ['manufacturer'],
        model: ['model_version', 'modelVersion'],
        chassisVin: ['chassis_number', 'chassisNumber'],
        warrantyExpiry: ['warranty_until', 'warrantyUntil'],
      }[bodyKey] ?? [];
      const input = findAssetInput(body, bodyKey, ...aliases, snakeKey);
      if (input.key === undefined) continue;
      let value = input.value;
      if (bodyKey === 'category') {
        value = normalizeAssetCategory(value);
        if (!value) {
          return res.status(400).json({ error: INVALID_ASSET_CATEGORY_ERROR });
        }
      }
      if (
        ['initialMeter', 'currentMeter'].includes(bodyKey)
        && !isValidMeterReading(value)
      ) {
        return res.status(400).json({ error: 'Leitura do contador inválida.' });
      }
      if (
        bodyKey === 'meterKind'
        && value !== null
        && value !== ''
        && !ASSET_METER_KINDS.has(value)
      ) {
        return res.status(400).json({ error: 'Tipo de contador inválido.' });
      }
      if (bodyKey === 'meterKind') {
        value = emptyToNull(value);
      }
      if (['initialMeter', 'currentMeter'].includes(bodyKey)) {
        value = emptyToNull(value);
      }
      if (
        [
          'name', 'criticalityLevel', 'brand', 'model', 'costCenter', 'province',
          'licensePlate', 'chassisVin', 'engineNumber', 'insurancePolicyNumber',
          'insuranceCompany', 'plantSector', 'voltageSpecs', 'assetType',
          'assetSubtype', 'energyType', 'ownershipType', 'localSupplierName',
        ].includes(bodyKey)
        && value !== null
        && typeof value !== 'string'
      ) {
        return res.status(400).json({ error: `Campo inválido: ${input.key}.` });
      }
      if (bodyKey === 'technicalSpecs' && value !== null) {
        value = JSON.stringify(value);
      }
      if (
        ['assetType', 'assetSubtype', 'energyType', 'ownershipType'].includes(bodyKey)
        && value !== null
        && (typeof value !== 'string' || value.length > 255)
      ) {
        return res.status(400).json({ error: `Campo inválido: ${input.key}.` });
      }
      if (
        bodyKey === 'axleConfig'
        && value !== null
        && (!Number.isInteger(value) || value < 1)
      ) {
        return res.status(400).json({ error: 'Configuração de eixos inválida.' });
      }
      if (bodyKey === 'status' && !ASSET_STATUSES.has(value)) {
        return res.status(400).json({ error: 'Estado do ativo inválido.' });
      }
      if (['manufactureYear', 'fuelTankCapacityLiters', 'powerKwKva'].includes(bodyKey)) {
        try {
          value = normalizeOptionalNumber(value, input.key);
        } catch (error) {
          return res.status(400).json({ error: error.message });
        }
        if (
          ['fuelTankCapacityLiters', 'powerKwKva'].includes(bodyKey)
          && value !== null
          && value < 0
        ) {
          return res.status(400).json({ error: `Campo inválido: ${input.key}.` });
        }
        if (bodyKey === 'manufactureYear' && value !== null && !Number.isInteger(value)) {
          return res.status(400).json({ error: `Campo inválido: ${input.key}.` });
        }
      }
      if (
        [
          'inatroInspectionExpiry', 'insuranceExpiry', 'innoqCalibrationExpiry',
          'pressureTestExpiry', 'warrantyExpiry',
        ].includes(bodyKey)
        && !isValidDateInput(value)
      ) {
        return res.status(400).json({ error: `Data inválida: ${input.key}.` });
      }
      if (
        [
          'inatroInspectionExpiry', 'insuranceExpiry', 'innoqCalibrationExpiry',
          'pressureTestExpiry', 'warrantyExpiry',
        ].includes(bodyKey)
      ) {
        value = emptyToNull(value);
      }
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    for (const { key } of ASSET_FORM_FIELDS) {
      if (findAssetInput(body, key, ...(ASSET_FORM_FIELD_ALIASES[key] ?? [])).key === undefined) {
        continue;
      }
      values.push(standardFields[key] ?? null);
      assignments.push(`${key} = $${values.length}`);
    }
    const technicalSpecKeys = [
      'technicalSpecs',
      'technical_specs',
      'technicalSheet',
      'technical_sheet',
      'fichaTecnica',
      'ficha_tecnica',
      ...TECHNICAL_SHEET_BLOCK_KEYS
        .filter(([blockName]) => blockName !== 'safety_checks')
        .flatMap(([, ...aliases]) => aliases),
    ];
    if (findAssetInput(body, ...technicalSpecKeys).key !== undefined) {
      let technicalSpecs;
      try {
        technicalSpecs = buildTechnicalSpecs(body);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      values.push(JSON.stringify(technicalSpecs));
      assignments.push(
        `technical_specs = jsonb_set(
           COALESCE(technical_specs, '{}'::jsonb) || $${values.length}::jsonb,
           '{ficha_tecnica}',
           COALESCE(technical_specs->'ficha_tecnica', '{}'::jsonb)
             || COALESCE($${values.length}::jsonb->'ficha_tecnica', '{}'::jsonb),
           true
         )`,
      );
    }
    if (findAssetInput(body, 'safetyChecks', 'safety_checks').key !== undefined) {
      const safetyChecks = buildSafetyChecks(body);
      values.push(JSON.stringify(safetyChecks));
      assignments.push(
        `safety_checks = COALESCE(safety_checks, '{}'::jsonb) || $${values.length}::jsonb`,
      );
    }
    assignments.push('updated_at = NOW()');

    values.push(id, req.user.tenantId);
    const idParameter = values.length - 1;
    const tenantParameter = values.length;
    let scopeClause = '';
    if (req.userScope) {
      values.push(req.userScope);
      scopeClause = `AND domain = $${values.length}`;
    }
    const updateQuery = `
      UPDATE public.assets
      SET ${assignments.join(', ')}
      WHERE id = $${idParameter}
        AND deleted_at IS NULL
        AND tenant_id = $${tenantParameter}
        ${scopeClause}
      RETURNING *;
    `;

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
}

router.put('/:id', requireTenant, updateAsset);
router.patch('/:id', requireTenant, updateAsset);

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