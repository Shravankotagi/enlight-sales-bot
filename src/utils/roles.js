function isProcurementManager(role) {
  return String(role || '').toLowerCase() === 'procurement_manager';
}

function isProcurementPerson(role) {
  return String(role || '').toLowerCase() === 'procurement_person';
}

/** Check this before any role.includes('manager'): procurement_manager contains "manager". */
function isProcurementRole(role) {
  return isProcurementManager(role) || isProcurementPerson(role);
}

module.exports = {
  isProcurementManager,
  isProcurementPerson,
  isProcurementRole,
};
