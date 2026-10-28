const rows = new Map();
const Invoices = {
  async find(id, tenantId) { const r = rows.get(id); return r && r.tenantId === tenantId ? r : null; },
  async void(id, tenantId) { const r = rows.get(id); if (r && r.tenantId === tenantId) r.voided = true; },
};
module.exports = { Invoices };
