-- WS4 owner-authorized LOCAL design, D7/D18. No shared/hosted execution authorized.
create table public.audit_logs (
 id uuid primary key default gen_random_uuid(),
 operation_id uuid not null,
 business_id uuid references public.businesses(id) on delete cascade,
 actor_id uuid,
 method text not null default 'OTHER' check (method in ('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','OTHER')),
 route_group text not null default 'other' check (route_group in ('health','widget','appointments','workflows','cron','campaigns','learning','analytics','admin','hooks','oauth','other')),
 action text not null check (action in ('api_access','dashboard_mutation','authentication','calendar_authorization','updateSettings','disconnectGoogleCalendar','createDocument','updateDocument','reviewDocumentRevision','withdrawDocument','deleteDocument','createFaq','updateFaq','reviewFaqRevision','withdrawFaq','deleteFaq','updateLifecycleSettings','updateAppointmentLifecycle','updateLeadStatus','deleteLead','updateReceptionist','createBusiness','updateBusinessProfile')),
 outcome text not null check (outcome in ('attempted','denied','succeeded','failed','unknown')),
 reason text not null check (reason in ('authorized','unauthenticated','forbidden','completed','request_failed','outcome_unknown')),
 correlation_id uuid not null,
 created_at timestamptz not null default clock_timestamp()
);
create index audit_logs_tenant_time on public.audit_logs (business_id, created_at desc);
alter table public.audit_logs enable row level security;
create policy audit_logs_read on public.audit_logs for select to authenticated
 using (public.is_business_member(business_id));
revoke all on public.audit_logs from public, anon, authenticated, service_role;
grant select on public.audit_logs to authenticated;
grant insert, select on public.audit_logs to service_role;
-- Append-only for application roles. Database owner can administer retention;
-- there is no automatic purge until the privacy owner approves a retention window.
-- Null-tenant authentication denials are visible only to service operators.
alter table public.workflow_events add column telemetry_correlation_id uuid;
alter table public.workflow_timers add column telemetry_correlation_id uuid;
