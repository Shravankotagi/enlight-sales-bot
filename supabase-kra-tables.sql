-- Recurring customers master list
create table if not exists recurring_customers (
  id uuid default gen_random_uuid() primary key,
  customer_name text not null,
  customer_phone text,
  customer_gst text,
  customer_address text,
  assigned_salesperson_phone text not null,
  last_order_date date,
  avg_order_frequency_days integer default 30,
  is_active boolean default true,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- KRA activity logs
create table if not exists kra_logs (
  id uuid default gen_random_uuid() primary key,
  salesperson_phone text not null,
  kra_number integer not null,
  kra_type text not null,
  description text,
  customer_name text,
  value numeric,
  month integer,
  year integer,
  created_at timestamptz default now()
);

-- Follow-up tasks
create table if not exists followup_tasks (
  id uuid default gen_random_uuid() primary key,
  task_type text not null,
  customer_name text,
  customer_phone text,
  salesperson_phone text not null,
  due_date timestamptz,
  status text default 'pending',
  reminder_sent_at timestamptz,
  escalated_at timestamptz,
  resolved_at timestamptz,
  resolution_notes text,
  follow_up_count integer default 0,
  created_at timestamptz default now()
);

-- Customer visits (KRA 9)
create table if not exists customer_visits (
  id uuid default gen_random_uuid() primary key,
  salesperson_phone text not null,
  customer_name text,
  customer_address text,
  person_met text,
  contact_no text,
  remarks text,
  visited_at timestamptz default now()
);

-- Complaints (KRA 8)
create table if not exists complaints (
  id uuid default gen_random_uuid() primary key,
  customer_name text,
  complaint_type text,
  affected_product text,
  description text,
  reported_by text,
  reported_at timestamptz default now(),
  sla_due_at timestamptz,
  resolved_at timestamptz,
  resolution_notes text,
  resolution_time_hrs numeric,
  status text default 'pending',
  escalated boolean default false
);

ALTER TABLE complaints ADD COLUMN IF NOT EXISTS affected_product text;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS sla_due_at timestamptz;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS resolution_notes text;

-- Payment tracking (KRA 5)
create table if not exists payment_tracking (
  id uuid default gen_random_uuid() primary key,
  deal_id uuid references deals(id),
  customer_name text,
  invoice_amount numeric,
  credit_period_days integer,
  due_date date,
  paid_date date,
  outstanding numeric,
  salesperson_phone text,
  status text default 'pending',
  last_reminder_at timestamptz,
  created_at timestamptz default now()
);

-- Seed some test recurring customers
insert into recurring_customers 
  (customer_name, customer_phone, assigned_salesperson_phone, 
   last_order_date, avg_order_frequency_days, notes)
values
  ('Dynamic Industries', '9370816366', '919187305823', 
   '2026-06-03', 30, 'Monthly MS Sheet orders'),
  ('ABC Fabricators', '9876543210', '919187305823', 
   '2026-06-15', 25, 'Regular HR Coil buyer'),
  ('SB Scafform Technovert', '9999999999', '919187305823', 
   '2026-07-04', 45, 'Structural steel orders');
