# Contexto Arquitetural do Backend CMMS

Stack: Node.js (ES Modules, "type": "module"), Express, PostgreSQL (via biblioteca "pg"), Supabase.
Hospedagem API: Render.
Hospedagem Frontend: Vercel (React).

Regras de Segurança e Banco de Dados:
1. Autenticação via Cookies HttpOnly ('auth_token') contendo JWT assinado.
2. Não usamos o Supabase JS Client; conectamos diretamente via Pool do 'pg' com SSL habilitado.
3. Isolamento multi-tenant obrigatório via PostgreSQL RLS usando as variáveis:
   - 'app.current_tenant' (UUID)
   - 'app.current_user_role' (TEXT)
4. Toda query operacional deve rodar dentro da função helper 'withTenantContext(tenantId, role, callback)' que abre uma transação BEGIN, roda set_config, executa a query e faz COMMIT/ROLLBACK.
5. Tabelas do banco:
   - tenants (id, name, trade_name, nuit, province, is_active, max_assets_limit, max_users_limit, operational_scope, default_operational_scope)
     - operational_scope: 'fleet', 'plant' ou 'mixed'; default_operational_scope: 'fleet' ou 'plant'
   - app_users (id, tenant_id, email, password_hash, full_name, phone, role, operational_scope, is_active)
     - roles: 'super_admin', 'tenant_admin', 'supervisor', 'technician', 'driver_operator'
     - operational_scope: 'fleet' ou 'plant'
   - assets (id, tenant_id, code_tag, name, category, brand, model, manufacture_year, meter_kind, current_meter, status, cost_center, domain)
     - categories: 'vehicle_light', 'vehicle_heavy', 'machinery', 'plant_equipment', 'generator'
     - meter_kind: 'odometer_km', 'hourmeter_hours'
     - status: 'operational', 'under_maintenance', 'breakdown', 'decommissioned'
   - work_orders (id, tenant_id, asset_id, wo_number, title, description, order_type, priority, status, meter_at_service, reported_by, assigned_to, downtime_hours, parts_cost_mzn, labor_cost_mzn, total_cost_mzn, opened_at, closed_at, domain)
     - order_type: 'corrective', 'preventive', 'inspection'
     - status: 'open', 'assigned', 'in_progress', 'waiting_parts', 'completed', 'cancelled'
   - technicians (id, tenant_id, user_id, name, domain)
   - fuel_logs (id, tenant_id, asset_id, driver_or_operator_id, logged_at, fuel_type, liters, price_per_liter_mzn, total_cost_mzn, current_meter, previous_meter, station_name, receipt_doc_ref, receipt_photo_url)