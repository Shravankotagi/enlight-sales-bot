-- Run this in Supabase SQL Editor

create table if not exists deals (
  id uuid default gen_random_uuid() primary key,
  inquiry_id uuid references inquiries(id),
  stage text default 'new_inquiry',
  po_number text,
  reference_po_number text,
  generated_po_number text,
  po_source text,
  po_status text,
  po_generated_at timestamptz,
  po_confirmed_at timestamptz,
  po_date text,
  customer_name text,
  customer_phone text,
  customer_gst text,
  customer_address text,
  delivery_location text,
  delivery_date text,
  payment_terms text,
  total_amount numeric,
  inquiry_type text,
  overall_confidence numeric,
  status text default 'needs_review',
  created_at timestamptz default now()
);

create table if not exists deal_items (
  id uuid default gen_random_uuid() primary key,
  deal_id uuid references deals(id),
  sku_text text,
  grade text,
  dimensions text,
  quantity numeric,
  unit text,
  rate numeric,
  amount numeric,
  confidence numeric,
  created_at timestamptz default now()
);

-- Also add these columns to existing inquiries table
alter table inquiries 
  add column if not exists ai_extraction_json jsonb,
    add column if not exists overall_confidence numeric,
    add column if not exists reference_po_number text,
    add column if not exists generated_po_number text,
    add column if not exists po_source text,
    add column if not exists po_status text,
    add column if not exists po_generated_at timestamptz,
    add column if not exists po_confirmed_at timestamptz;
