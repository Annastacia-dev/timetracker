-- TimeTracker team schema for Supabase.
-- Run once in the Supabase dashboard: SQL Editor → New query → paste this file → Run.
--
-- Access model
--   owner / admin : manage the team, clients, projects, rates, invoices; see everyone's time and screenshots
--   member        : track time against team projects; sees only their own time and screenshots
-- All data access is enforced here with row-level security, not in the app.

-- ---------------------------------------------------------------------------------------------
-- Types and tables
-- ---------------------------------------------------------------------------------------------
create type public.team_role as enum ('owner', 'admin', 'member');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  created_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  business_name text not null default '',
  business_details text not null default '',
  invoice_due_days int not null default 14 check (invoice_due_days between 0 and 365),
  idle_minutes numeric(6, 2) not null default 5 check (idle_minutes >= 0),
  screenshots_enabled boolean not null default false,
  blur_screenshots boolean not null default false,
  next_invoice_no int not null default 1,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.team_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_idx on public.team_members (user_id);

create table public.team_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email like '%_@_%'),
  role public.team_role not null default 'member' check (role <> 'owner'),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (team_id, email)
);
create index team_invites_email_idx on public.team_invites (email);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  email text not null default '',
  address text not null default '',
  rate numeric(12, 2) not null default 0 check (rate >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index clients_team_idx on public.clients (team_id);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  client_id uuid not null references public.clients (id),
  name text not null check (length(btrim(name)) between 1 and 200),
  rate numeric(12, 2) check (rate is null or rate >= 0), -- null = use the client's rate
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index projects_team_idx on public.projects (team_id);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  client_id uuid not null references public.clients (id),
  number text not null,
  period_from timestamptz not null,
  period_to timestamptz not null,
  lines jsonb not null default '[]',
  total numeric(14, 2) not null default 0,
  notes text not null default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  due_at timestamptz not null,
  unique (team_id, number)
);

-- Time entries and activity blocks are created on the device (offline first), so their ids come
-- from the client. updated_at drives incremental sync; deletes are soft so they sync too.
create table public.time_entries (
  id uuid primary key,
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null references public.projects (id),
  task text not null default '',
  started_at timestamptz not null,
  ended_at timestamptz, -- null while the timer is running
  manual boolean not null default false,
  invoice_id uuid references public.invoices (id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (ended_at is null or ended_at > started_at)
);
create index time_entries_sync_idx on public.time_entries (team_id, updated_at);
create index time_entries_user_idx on public.time_entries (team_id, user_id, started_at);

create table public.activity_blocks (
  id uuid primary key,
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  entry_id uuid not null references public.time_entries (id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  activity smallint not null check (activity between 0 and 100),
  screenshot_path text, -- object path in the "screenshots" storage bucket
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (ended_at >= started_at)
);
create index activity_blocks_sync_idx on public.activity_blocks (team_id, updated_at);

-- ---------------------------------------------------------------------------------------------
-- Helpers (security definer so policies can call them without recursing into team_members RLS)
-- ---------------------------------------------------------------------------------------------
create function public.is_member(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team_members where team_id = p_team and user_id = auth.uid());
$$;

create function public.is_admin(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team and user_id = auth.uid() and role in ('owner', 'admin')
  );
$$;

create function public.shares_team(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members a join public.team_members b on a.team_id = b.team_id
    where a.user_id = auth.uid() and b.user_id = p_user
  );
$$;

-- Team id from a storage path "<team_id>/<user_id>/<day>/<file>"; null when malformed.
create function public.path_team(p_name text) returns uuid
language plpgsql immutable as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger teams_touch before update on public.teams for each row execute function public.touch_updated_at();
create trigger clients_touch before update on public.clients for each row execute function public.touch_updated_at();
create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();
create trigger entries_touch before update on public.time_entries for each row execute function public.touch_updated_at();
create trigger blocks_touch before update on public.activity_blocks for each row execute function public.touch_updated_at();

-- Invoiced time is locked, ownership never changes, and invoice links are set only by the
-- invoice functions (which set tt.invoicing for their transaction).
create function public.guard_time_entry() returns trigger
language plpgsql as $$
declare
  invoicing boolean := coalesce(current_setting('tt.invoicing', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if new.invoice_id is not null and not invoicing then
      raise exception 'invoice_id is set by invoices only';
    end if;
    return new;
  end if;
  if new.team_id <> old.team_id or new.user_id <> old.user_id then
    raise exception 'Time entries cannot move between users or teams';
  end if;
  if new.invoice_id is distinct from old.invoice_id and not invoicing then
    raise exception 'invoice_id is set by invoices only';
  end if;
  if old.invoice_id is not null and not invoicing and (
    new.started_at <> old.started_at or new.ended_at is distinct from old.ended_at
    or new.project_id <> old.project_id or new.deleted_at is distinct from old.deleted_at
  ) then
    raise exception 'This time is on an invoice. Delete the invoice to change it.';
  end if;
  return new;
end;
$$;
create trigger time_entries_guard before insert or update on public.time_entries
  for each row execute function public.guard_time_entry();

create function public.guard_owned_row() returns trigger
language plpgsql as $$
begin
  if new.team_id <> old.team_id or new.user_id <> old.user_id then
    raise exception 'Rows cannot move between users or teams';
  end if;
  return new;
end;
$$;
create trigger activity_blocks_guard before update on public.activity_blocks
  for each row execute function public.guard_owned_row();

create function public.guard_team_row() returns trigger
language plpgsql as $$
begin
  if new.team_id <> old.team_id then
    raise exception 'Rows cannot move between teams';
  end if;
  return new;
end;
$$;
create trigger clients_guard before update on public.clients for each row execute function public.guard_team_row();
create trigger projects_guard before update on public.projects for each row execute function public.guard_team_row();

-- ---------------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;
alter table public.clients enable row level security;
alter table public.projects enable row level security;
alter table public.invoices enable row level security;
alter table public.time_entries enable row level security;
alter table public.activity_blocks enable row level security;

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_team(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy teams_read on public.teams for select to authenticated using (public.is_member(id));
create policy teams_update on public.teams for update to authenticated
  using (public.is_admin(id)) with check (public.is_admin(id));

create policy members_read on public.team_members for select to authenticated using (public.is_member(team_id));
create policy invites_read on public.team_invites for select to authenticated using (public.is_admin(team_id));

create policy clients_read on public.clients for select to authenticated using (public.is_member(team_id));
create policy clients_insert on public.clients for insert to authenticated with check (public.is_admin(team_id));
create policy clients_update on public.clients for update to authenticated
  using (public.is_admin(team_id)) with check (public.is_admin(team_id));

create policy projects_read on public.projects for select to authenticated using (public.is_member(team_id));
create policy projects_insert on public.projects for insert to authenticated
  with check (public.is_admin(team_id)
    and exists (select 1 from public.clients c where c.id = client_id and c.team_id = projects.team_id));
create policy projects_update on public.projects for update to authenticated
  using (public.is_admin(team_id))
  with check (public.is_admin(team_id)
    and exists (select 1 from public.clients c where c.id = client_id and c.team_id = projects.team_id));

create policy invoices_read on public.invoices for select to authenticated using (public.is_admin(team_id));

create policy entries_read on public.time_entries for select to authenticated
  using ((user_id = auth.uid() and public.is_member(team_id)) or public.is_admin(team_id));
create policy entries_insert on public.time_entries for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(team_id)
    and exists (select 1 from public.projects p where p.id = project_id and p.team_id = time_entries.team_id));
create policy entries_update on public.time_entries for update to authenticated
  using ((user_id = auth.uid() and public.is_member(team_id)) or public.is_admin(team_id))
  with check (((user_id = auth.uid() and public.is_member(team_id)) or public.is_admin(team_id))
    and exists (select 1 from public.projects p where p.id = project_id and p.team_id = time_entries.team_id));

create policy blocks_read on public.activity_blocks for select to authenticated
  using ((user_id = auth.uid() and public.is_member(team_id)) or public.is_admin(team_id));
create policy blocks_insert on public.activity_blocks for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(team_id)
    and exists (select 1 from public.time_entries e
                where e.id = entry_id and e.user_id = activity_blocks.user_id and e.team_id = activity_blocks.team_id));
create policy blocks_update on public.activity_blocks for update to authenticated
  using ((user_id = auth.uid() and public.is_member(team_id)) or public.is_admin(team_id))
  with check ((user_id = auth.uid() and public.is_member(team_id)) or public.is_admin(team_id));

-- No delete policies: rows are soft-deleted (deleted_at) so deletions sync to every device.

-- ---------------------------------------------------------------------------------------------
-- Team and invoice operations (the only way to change memberships, invites and invoices)
-- ---------------------------------------------------------------------------------------------
create function public.create_team(p_name text) returns public.teams
language plpgsql security definer set search_path = public as $$
declare t public.teams;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public.teams (name, created_by) values (btrim(p_name), auth.uid()) returning * into t;
  insert into public.team_members (team_id, user_id, role) values (t.id, auth.uid(), 'owner');
  return t;
end;
$$;

create function public.invite_member(p_team uuid, p_email text, p_role public.team_role default 'member')
returns public.team_invites
language plpgsql security definer set search_path = public as $$
declare i public.team_invites; v_email text := lower(btrim(p_email));
begin
  if not public.is_admin(p_team) then raise exception 'Only team admins can invite people'; end if;
  if p_role = 'owner' then raise exception 'Invite as admin, then transfer ownership'; end if;
  if exists (select 1 from public.team_members m join public.profiles p on p.id = m.user_id
             where m.team_id = p_team and lower(p.email) = v_email) then
    raise exception 'That person is already in the team';
  end if;
  insert into public.team_invites (team_id, email, role, invited_by)
  values (p_team, v_email, p_role, auth.uid())
  on conflict (team_id, email) do update set role = excluded.role, invited_by = excluded.invited_by
  returning * into i;
  return i;
end;
$$;

create function public.revoke_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_team uuid;
begin
  select team_id into v_team from public.team_invites where id = p_invite;
  if v_team is null or not public.is_admin(v_team) then raise exception 'Invite not found'; end if;
  delete from public.team_invites where id = p_invite;
end;
$$;

-- Joins every team that invited the signed-in user's email address.
create function public.accept_invites() returns setof public.teams
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null or v_email = '' then return; end if;
  insert into public.team_members (team_id, user_id, role)
  select team_id, auth.uid(), role from public.team_invites where email = v_email
  on conflict (team_id, user_id) do nothing;
  delete from public.team_invites where email = v_email;
  return query select t.* from public.teams t join public.team_members m on m.team_id = t.id
               where m.user_id = auth.uid();
end;
$$;

create function public.set_member_role(p_team uuid, p_user uuid, p_role public.team_role) returns void
language plpgsql security definer set search_path = public as $$
declare v_mine public.team_role; v_theirs public.team_role;
begin
  select role into v_mine from public.team_members where team_id = p_team and user_id = auth.uid();
  select role into v_theirs from public.team_members where team_id = p_team and user_id = p_user;
  if v_mine is null or v_mine = 'member' then raise exception 'Only team admins can change roles'; end if;
  if v_theirs is null then raise exception 'That person is not in the team'; end if;
  if (p_role = 'owner' or v_theirs = 'owner') and v_mine <> 'owner' then
    raise exception 'Only an owner can change ownership';
  end if;
  if v_theirs = 'owner' and p_role <> 'owner'
     and (select count(*) from public.team_members where team_id = p_team and role = 'owner') = 1 then
    raise exception 'A team needs at least one owner';
  end if;
  update public.team_members set role = p_role where team_id = p_team and user_id = p_user;
end;
$$;

create function public.remove_member(p_team uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_mine public.team_role; v_theirs public.team_role;
begin
  select role into v_mine from public.team_members where team_id = p_team and user_id = auth.uid();
  select role into v_theirs from public.team_members where team_id = p_team and user_id = p_user;
  if v_mine is null or v_theirs is null then raise exception 'That person is not in the team'; end if;
  if p_user <> auth.uid() and v_mine = 'member' then raise exception 'Only team admins can remove people'; end if;
  if v_theirs = 'owner' and p_user <> auth.uid() and v_mine <> 'owner' then
    raise exception 'Only an owner can remove an owner';
  end if;
  if v_theirs = 'owner'
     and (select count(*) from public.team_members where team_id = p_team and role = 'owner') = 1 then
    raise exception 'A team needs at least one owner. Make someone else owner first.';
  end if;
  delete from public.team_members where team_id = p_team and user_id = p_user;
end;
$$;

create function public.create_invoice(p_team uuid, p_client uuid, p_from timestamptz, p_to timestamptz, p_notes text default '')
returns public.invoices
language plpgsql security definer set search_path = public as $$
declare
  v_team public.teams;
  v_lines jsonb;
  v_total numeric(14, 2);
  v_inv public.invoices;
begin
  if not public.is_admin(p_team) then raise exception 'Only team admins can create invoices'; end if;
  if not exists (select 1 from public.clients where id = p_client and team_id = p_team) then
    raise exception 'Client not found';
  end if;
  select * into v_team from public.teams where id = p_team for update;

  with picked as (
    select e.project_id, sum(extract(epoch from (e.ended_at - e.started_at))) / 3600.0 as hours
    from public.time_entries e join public.projects p on p.id = e.project_id
    where e.team_id = p_team and p.client_id = p_client and e.deleted_at is null and e.ended_at is not null
      and e.invoice_id is null and e.started_at >= p_from and e.started_at < p_to
    group by e.project_id
  ), priced as (
    select k.project_id, p.name, round(k.hours::numeric, 2) as hours,
           coalesce(p.rate, c.rate, 0) as rate
    from picked k join public.projects p on p.id = k.project_id join public.clients c on c.id = p.client_id
  )
  select jsonb_agg(jsonb_build_object(
           'projectId', project_id, 'description', name, 'hours', hours, 'rate', rate,
           'amount', round(hours * rate, 2)) order by name),
         coalesce(sum(round(hours * rate, 2)), 0)
    into v_lines, v_total
  from priced;

  if v_lines is null then raise exception 'No unbilled time for this client in that period.'; end if;

  insert into public.invoices (team_id, client_id, number, period_from, period_to, lines, total, notes, created_by, due_at)
  values (p_team, p_client, 'INV-' || lpad(v_team.next_invoice_no::text, 4, '0'), p_from, p_to, v_lines, v_total,
          coalesce(p_notes, ''), auth.uid(), now() + make_interval(days => v_team.invoice_due_days))
  returning * into v_inv;
  update public.teams set next_invoice_no = next_invoice_no + 1 where id = p_team;

  perform set_config('tt.invoicing', 'on', true);
  update public.time_entries e set invoice_id = v_inv.id
  from public.projects p
  where p.id = e.project_id and e.team_id = p_team and p.client_id = p_client and e.deleted_at is null
    and e.ended_at is not null and e.invoice_id is null and e.started_at >= p_from and e.started_at < p_to;
  perform set_config('tt.invoicing', 'off', true);
  return v_inv;
end;
$$;

create function public.delete_invoice(p_invoice uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_team uuid;
begin
  select team_id into v_team from public.invoices where id = p_invoice;
  if v_team is null or not public.is_admin(v_team) then raise exception 'Invoice not found'; end if;
  perform set_config('tt.invoicing', 'on', true);
  update public.time_entries set invoice_id = null where invoice_id = p_invoice;
  perform set_config('tt.invoicing', 'off', true);
  delete from public.invoices where id = p_invoice;
end;
$$;

-- Only signed-in users may call the operations.
revoke execute on function public.create_team(text), public.invite_member(uuid, text, public.team_role),
  public.revoke_invite(uuid), public.accept_invites(), public.set_member_role(uuid, uuid, public.team_role),
  public.remove_member(uuid, uuid), public.create_invoice(uuid, uuid, timestamptz, timestamptz, text),
  public.delete_invoice(uuid)
  from public, anon;
grant execute on function public.create_team(text), public.invite_member(uuid, text, public.team_role),
  public.revoke_invite(uuid), public.accept_invites(), public.set_member_role(uuid, uuid, public.team_role),
  public.remove_member(uuid, uuid), public.create_invoice(uuid, uuid, timestamptz, timestamptz, text),
  public.delete_invoice(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Screenshot storage: private bucket, paths "<team_id>/<user_id>/<YYYY-MM-DD>/<block_id>.jpg"
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('screenshots', 'screenshots', false, 262144, array['image/jpeg'])
on conflict (id) do nothing;

create policy tt_screens_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'screenshots'
    and split_part(name, '/', 2) = auth.uid()::text
    and public.is_member(public.path_team(name)));
create policy tt_screens_read on storage.objects for select to authenticated
  using (bucket_id = 'screenshots'
    and ((split_part(name, '/', 2) = auth.uid()::text and public.is_member(public.path_team(name)))
         or public.is_admin(public.path_team(name))));
create policy tt_screens_delete on storage.objects for delete to authenticated
  using (bucket_id = 'screenshots'
    and (split_part(name, '/', 2) = auth.uid()::text or public.is_admin(public.path_team(name))));
