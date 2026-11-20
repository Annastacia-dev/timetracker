// Loads supabase/schema.sql into PGlite (in-process Postgres) with minimal stand-ins for Supabase's
// auth and storage schemas, then checks the access rules as different users.
// Run: npm run test:schema
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed++;
};

// ---- Supabase stand-ins ----
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth; create schema storage;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
  alter table storage.objects enable row level security;
`);
await db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
await db.exec(`
  grant usage on schema public, auth, storage to authenticated, anon;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant execute on all functions in schema auth to authenticated, anon;
`);

const U = {
  owner: '00000000-0000-0000-0000-00000000000a',
  admin: '00000000-0000-0000-0000-00000000000b',
  alice: '00000000-0000-0000-0000-00000000000c',
  bob: '00000000-0000-0000-0000-00000000000d',
  eve: '00000000-0000-0000-0000-00000000000e', // not in the team
};
for (const [name, id] of Object.entries(U)) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [
    id, `${name}@example.test`, JSON.stringify({ full_name: name }),
  ]);
}

// Run SQL as a signed-in user (or as postgres when who is null). Returns { rows } or { error }.
async function as(who, sql, params = []) {
  try {
    const res = await db.transaction(async (tx) => {
      if (who) {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [
          U[who], JSON.stringify({ sub: U[who], email: `${who}@example.test` }),
        ]);
        await tx.exec('set local role authenticated');
      }
      return tx.query(sql, params);
    });
    return { rows: res.rows };
  } catch (error) {
    return { error: error.message };
  }
}
const one = async (who, sql, params) => (await as(who, sql, params)).rows?.[0];

// ---- setup through the public operations ----
ok((await one(null, `select count(*)::int n from public.profiles`)).n === 5, 'profiles are created for new users');

const team = await one('owner', `select * from public.create_team('Studio')`);
ok(team?.name === 'Studio', 'owner creates a team');
const T = team.id;
ok((await as('eve', `select * from public.create_team('  ')`)).error, 'blank team names are rejected');

ok(!(await as('owner', `select public.invite_member($1, 'Admin@Example.test', 'admin')`, [T])).error, 'owner invites an admin (email normalised)');
ok(!(await as('owner', `select public.invite_member($1, 'alice@example.test')`, [T])).error, 'owner invites alice');
ok(!(await as('owner', `select public.invite_member($1, 'bob@example.test')`, [T])).error, 'owner invites bob');
ok((await as('alice', `select public.invite_member($1, 'eve@example.test')`, [T])).error, 'non-member cannot invite');
ok((await as('owner', `select public.invite_member($1, 'x@example.test', 'owner')`, [T])).error, 'cannot invite straight to owner');

for (const who of ['admin', 'alice', 'bob']) await as(who, `select * from public.accept_invites()`);
const roles = (await as(null, `select p.full_name, m.role from public.team_members m join public.profiles p on p.id = m.user_id order by 1`)).rows;
ok(JSON.stringify(roles.map((r) => `${r.full_name}:${r.role}`)) === '["admin:admin","alice:member","bob:member","owner:owner"]', 'invites accepted with the right roles');
ok((await one('eve', `select count(*)::int n from public.accept_invites()`)).n === 0, 'uninvited user joins nothing');

// ---- clients and projects ----
const client = await one('admin', `insert into public.clients (team_id, name, rate) values ($1, 'Acme', 50) returning *`, [T]);
ok(!!client, 'admin creates a client');
ok((await as('alice', `insert into public.clients (team_id, name) values ($1, 'Sneaky')`, [T])).error, 'member cannot create clients');
const project = await one('admin', `insert into public.projects (team_id, client_id, name) values ($1, $2, 'Site') returning *`, [T, client.id]);
ok(!!project, 'admin creates a project');
ok((await one('alice', `select count(*)::int n from public.projects`)).n === 1, 'member can see team projects');
ok((await one('eve', `select count(*)::int n from public.projects`)).n === 0, 'outsider sees no projects');
ok((await as('alice', `update public.projects set rate = 999 where id = $1`, [project.id])).rows?.length === 0
  && (await one(null, `select rate from public.projects where id = $1`, [project.id])).rate === null, 'member cannot change rates');

// ---- time entries ----
const e1 = '10000000-0000-0000-0000-000000000001';
const e2 = '10000000-0000-0000-0000-000000000002';
ok(!(await as('alice', `insert into public.time_entries (id, team_id, user_id, project_id, started_at, ended_at)
  values ($1, $2, $3, $4, now() - interval '2 hours', now() - interval '1 hour')`, [e1, T, U.alice, project.id])).error, 'member logs own time');
ok((await as('alice', `insert into public.time_entries (id, team_id, user_id, project_id, started_at, ended_at)
  values (gen_random_uuid(), $1, $2, $3, now() - interval '2 hours', now())`, [T, U.bob, project.id])).error, 'member cannot log time as someone else');
ok((await as('eve', `insert into public.time_entries (id, team_id, user_id, project_id, started_at, ended_at)
  values (gen_random_uuid(), $1, $2, $3, now() - interval '2 hours', now())`, [T, U.eve, project.id])).error, 'outsider cannot log time to the team');
await as('bob', `insert into public.time_entries (id, team_id, user_id, project_id, started_at, ended_at)
  values ($1, $2, $3, $4, now() - interval '3 hours', now() - interval '2 hours')`, [e2, T, U.bob, project.id]);

ok((await one('bob', `select count(*)::int n from public.time_entries`)).n === 1, "member sees only their own time (not alice's)");
ok((await one('admin', `select count(*)::int n from public.time_entries`)).n === 2, "admin sees everyone's time");
ok((await as('bob', `update public.time_entries set task = 'hacked' where id = $1`, [e1])).rows?.length === 0
  && (await one(null, `select task from public.time_entries where id = $1`, [e1])).task === '', "member cannot edit someone else's time");
ok((await as('alice', `update public.time_entries set user_id = $1 where id = $2`, [U.bob, e1])).error, 'entries cannot change owner');
ok((await as('alice', `update public.time_entries set invoice_id = gen_random_uuid() where id = $1`, [e1])).error, 'members cannot set invoice links');
ok((await one('alice', `select count(*)::int n from public.profiles`)).n === 4, 'members see teammates’ profiles, not outsiders');

// ---- activity blocks and screenshots ----
const b1 = '20000000-0000-0000-0000-000000000001';
ok(!(await as('alice', `insert into public.activity_blocks (id, team_id, user_id, entry_id, started_at, ended_at, activity, screenshot_path)
  values ($1, $2, $3, $4, now() - interval '2 hours', now() - interval '110 minutes', 80, $5)`,
  [b1, T, U.alice, e1, `${T}/${U.alice}/2026-11-20/${b1}.jpg`])).error, 'member records an activity block');
ok((await as('bob', `insert into public.activity_blocks (id, team_id, user_id, entry_id, started_at, ended_at, activity)
  values (gen_random_uuid(), $1, $2, $3, now(), now(), 50)`, [T, U.bob, e1])).error, "member cannot attach blocks to another person's entry");
ok((await one('bob', `select count(*)::int n from public.activity_blocks`)).n === 0, "member cannot see others' activity");
ok((await one('admin', `select count(*)::int n from public.activity_blocks`)).n === 1, "admin sees members' activity");

const path = `${T}/${U.alice}/2026-11-20/${b1}.jpg`;
ok(!(await as('alice', `insert into storage.objects (bucket_id, name) values ('screenshots', $1)`, [path])).error, 'member uploads own screenshot');
ok((await as('alice', `insert into storage.objects (bucket_id, name) values ('screenshots', $1)`, [`${T}/${U.bob}/x/y.jpg`])).error, "member cannot upload into someone else's folder");
ok((await as('eve', `insert into storage.objects (bucket_id, name) values ('screenshots', $1)`, [`${T}/${U.eve}/x/y.jpg`])).error, 'outsider cannot upload to the team');
ok((await as('alice', `insert into storage.objects (bucket_id, name) values ('screenshots', 'garbage/path.jpg')`)).error, 'malformed storage paths are rejected');
ok((await one('bob', `select count(*)::int n from storage.objects`)).n === 0, "member cannot read others' screenshots");
ok((await one('admin', `select count(*)::int n from storage.objects`)).n === 1, "admin can read members' screenshots");
ok((await one('eve', `select count(*)::int n from storage.objects`)).n === 0, 'outsider cannot read screenshots');

// ---- invoices ----
ok((await as('alice', `select * from public.create_invoice($1, $2, now() - interval '1 day', now())`, [T, client.id])).error, 'member cannot create invoices');
const inv = await one('admin', `select * from public.create_invoice($1, $2, now() - interval '1 day', now(), 'Thanks')`, [T, client.id]);
ok(inv?.number === 'INV-0001' && Number(inv.total) === 100, `admin invoices 2 h × $50 = $100 (got ${inv?.total})`);
ok((await one(null, `select count(*)::int n from public.time_entries where invoice_id = $1`, [inv.id])).n === 2, 'invoiced entries are linked');
ok((await as('admin', `select * from public.create_invoice($1, $2, now() - interval '1 day', now())`, [T, client.id])).error, 'the same time cannot be invoiced twice');
ok((await as('alice', `update public.time_entries set ended_at = now() where id = $1`, [e1])).error, 'invoiced time is locked for members');
ok((await as('admin', `update public.time_entries set deleted_at = now() where id = $1`, [e1])).error, 'invoiced time is locked for admins too');
ok((await one('alice', `select count(*)::int n from public.invoices`)).n === 0, 'members cannot see invoices');
await as('admin', `select public.delete_invoice($1)`, [inv.id]);
ok((await one(null, `select count(*)::int n from public.time_entries where invoice_id is not null`)).n === 0, 'deleting an invoice frees its time');
ok(!(await as('alice', `update public.time_entries set deleted_at = now() where id = $1`, [e1])).error, 'freed time can be edited again');

// ---- roles ----
ok((await as('admin', `select public.set_member_role($1, $2, 'owner')`, [T, U.alice])).error, 'admin cannot grant ownership');
ok((await as('alice', `select public.set_member_role($1, $2, 'admin')`, [T, U.alice])).error, 'member cannot promote themselves');
ok((await as('admin', `select public.remove_member($1, $2)`, [T, U.owner])).error, 'admin cannot remove the owner');
ok((await as('owner', `select public.remove_member($1, $2)`, [T, U.owner])).error, 'last owner cannot leave');
ok(!(await as('admin', `select public.remove_member($1, $2)`, [T, U.bob])).error, 'admin removes a member');
ok((await one('bob', `select count(*)::int n from public.projects`)).n === 0, 'removed member loses access');
ok(!(await as('alice', `select public.remove_member($1, $2)`, [T, U.alice])).error, 'member can leave the team');

console.log(failed ? `\n${failed} check(s) failed` : '\nAll schema checks passed');
process.exit(failed ? 1 : 0);
