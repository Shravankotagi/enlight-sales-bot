-- ==============================================================================
-- Enlight Sales OS - Scale & Performance Database Index Migration
-- Optimizes queries for Multi-Admin, Multi-Sales Manager, Many Salespersons,
-- and 1000+ customer records with sub-millisecond lookups.
-- ==============================================================================

-- 1. Employees & RBAC Hierarchy
CREATE INDEX IF NOT EXISTS idx_employees_phone ON employees(phone);
CREATE INDEX IF NOT EXISTS idx_employees_manager_id ON employees(manager_id);
CREATE INDEX IF NOT EXISTS idx_employees_manager_phone ON employees(manager_phone);
CREATE INDEX IF NOT EXISTS idx_employees_role ON employees(role);
CREATE INDEX IF NOT EXISTS idx_employees_is_active ON employees(is_active);

-- 2. Deals & Line Items
CREATE INDEX IF NOT EXISTS idx_deals_salesperson_phone ON deals(salesperson_phone);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_created_at ON deals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_won_at ON deals(won_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_customer_name ON deals(customer_name);
CREATE INDEX IF NOT EXISTS idx_deals_total_amount ON deals(total_amount);
CREATE INDEX IF NOT EXISTS idx_deals_delivery_location ON deals(delivery_location);
CREATE INDEX IF NOT EXISTS idx_deal_items_deal_id ON deal_items(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_items_sku_text ON deal_items(sku_text);

-- 3. Customers Master Directory
CREATE INDEX IF NOT EXISTS idx_recurring_customers_phone ON recurring_customers(assigned_salesperson_phone);
CREATE INDEX IF NOT EXISTS idx_recurring_customers_name ON recurring_customers(customer_name);
CREATE INDEX IF NOT EXISTS idx_recurring_customers_active ON recurring_customers(is_active);

-- 4. Visits, Payments, Complaints & KRA Logs
CREATE INDEX IF NOT EXISTS idx_customer_visits_salesperson ON customer_visits(salesperson_phone);
CREATE INDEX IF NOT EXISTS idx_customer_visits_date ON customer_visits(visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_tracking_salesperson ON payment_tracking(salesperson_phone);
CREATE INDEX IF NOT EXISTS idx_payment_tracking_status ON payment_tracking(status);
CREATE INDEX IF NOT EXISTS idx_payment_tracking_due_date ON payment_tracking(due_date);
CREATE INDEX IF NOT EXISTS idx_complaints_salesperson ON complaints(salesperson_phone);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_kra_logs_lookup ON kra_logs(salesperson_phone, kra_number, month, year);
CREATE INDEX IF NOT EXISTS idx_inquiries_phone ON inquiries(salesperson_phone);
CREATE INDEX IF NOT EXISTS idx_inquiries_created_at ON inquiries(created_at DESC);
