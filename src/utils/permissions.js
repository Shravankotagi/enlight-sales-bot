const { createClient } = require('@supabase/supabase-js');
const builtin = require('./builtinRoles.json');

const CACHE_MS = 10_000;
const cache = new Map();
const mockPermissionsMap = globalThis.__botMockPermissions || new Map();
globalThis.__botMockPermissions = mockPermissionsMap;

function invalidateBotPermissions(phone) {
  if (!phone) {
    cache.clear();
    mockPermissionsMap.clear();
    return;
  }
  const key = String(phone || '').replace(/\D/g, '').slice(-10);
  if (key) {
    cache.delete(key);
    mockPermissionsMap.delete(key);
  }
}

function setMockPermissions(phone, value) {
  const key = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!key) return;
  if (value === null) {
    mockPermissionsMap.delete(key);
    cache.delete(key);
  } else {
    mockPermissionsMap.set(key, value);
    cache.set(key, { at: Date.now(), value });
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_KEY ||
    'placeholder',
);

const KEYS = new Set(builtin.keys);

function normalizeRoleId(role) {
  const raw = String(role || '').trim();
  if (raw === 'manager') return 'sales_manager';
  return raw || 'salesperson';
}

function mergePermissions(rolePerms, overrides) {
  const merged = { ...(builtin.templates.salesperson || {}) };
  for (const source of [rolePerms, overrides]) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) {
      if (KEYS.has(key) && typeof value === 'boolean') merged[key] = value;
    }
  }
  return merged;
}

function builtinFor(roleId, overrides) {
  const id = builtin.templates[roleId] ? roleId : 'salesperson';
  return {
    permissions: mergePermissions(builtin.templates[id], overrides),
    dataScope: builtin.scopes[id] || 'own',
    role: id,
    isActive: true,
  };
}

async function resolvePermissions(phone) {
  const key = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!key) return null;
  if (mockPermissionsMap.has(key)) {
    return mockPermissionsMap.get(key);
  }
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  try {
    const { data: employees, error } = await supabase
      .from('employees')
      .select('id, phone, name, role, permissions, is_active')
      .ilike('phone', `%${key}`)
      .eq('is_active', true);
    if (error) throw error;
    const employee = (employees || []).find(
      (row) => String(row.phone || '').replace(/\D/g, '').slice(-10) === key,
    );
    if (!employee) return null;
    const roleId = normalizeRoleId(employee.role);
    let value = builtinFor(roleId, employee.permissions);
    const { data: roleRow, error: roleError } = await supabase
      .from('roles')
      .select('name, data_scope, permissions, is_active')
      .eq('id', roleId)
      .maybeSingle();
    if (!roleError && roleRow) {
      if (roleRow.is_active === false) {
        value = builtinFor('salesperson', employee.permissions);
      } else if (!builtin.templates[roleId]) {
        // Custom roles: use custom roleRow permissions and scope from database
        const scope = ['own', 'team', 'all'].includes(roleRow.data_scope)
          ? roleRow.data_scope
          : 'own';
        value = {
          permissions: mergePermissions(roleRow.permissions, employee.permissions),
          dataScope: scope,
          role: roleId,
          roleName: roleRow.name,
          isActive: true,
          employee,
        };
      } else {
        // Builtin fixed roles: keep fixed permissions, just carry display roleName if present
        value.roleName = roleRow.name || value.role;
      }
    }
    value.employee = employee;
    value.isActive = employee.is_active !== false;
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (hit?.value) return hit.value;
    if (process.env.NODE_ENV === 'test') {
      return builtinFor('salesperson');
    }
    console.warn('Bot permission lookup failed:', err?.message || err);
    return null;
  }
}

async function can(phone, permissionKey) {
  const resolved = await resolvePermissions(phone);
  if (!resolved || resolved.isActive === false) return false;
  return resolved.permissions?.[permissionKey] === true;
}

const ACTION_KEYS = {
  LOG_VISIT: ['visits.log', 'log visits'],
  UPDATE_VISIT: ['visits.update', 'update visits'],
  LOG_INQUIRY: ['inquiries.manage', 'log inquiries'],
  UPDATE_INQUIRY: ['inquiries.edit', 'edit inquiries'],
  LOG_ORDER: ['orders.create', 'log orders'],
  UPDATE_ORDER: ['orders.update', 'update orders'],
  LOG_COMPLAINT: ['complaints.log', 'log complaints'],
  UPDATE_COMPLAINT: ['complaints.update', 'update complaints'],
  LOG_NEW_CUSTOMER: ['customers.create', 'onboard new customers'],
  ADD_PRICE: ['inquiries.fill_base_prices', 'add inquiry prices'],
};

async function denialReply(phone, action) {
  if (action === 'ADD_PRICE') {
    const allowed = (await can(phone, 'inquiries.fill_base_prices')) || (await can(phone, 'inquiries.price_override'));
    if (allowed) return null;
    return 'You do not have permission to add inquiry prices. Please contact your admin.';
  }
  const spec = ACTION_KEYS[action];
  if (!spec) return null;
  try {
    const allowed = await can(phone, spec[0]);
    if (allowed) return null;
    return `You do not have permission to ${spec[1]}. Please contact your admin.`;
  } catch (err) {
    console.warn('Bot permission denial failed closed:', err?.message || err);
    return `You do not have permission to ${spec[1]}. Please contact your admin.`;
  }
}

module.exports = {
  resolvePermissions,
  can,
  denialReply,
  mergePermissions,
  normalizeRoleId,
  invalidateBotPermissions,
  setMockPermissions,
  builtinFor,
};
