// The admin console's team and access control. People sign in with their phone number (the same SMS code as the
// app); what they may do comes from their role. Every admin request is checked here on the server; the console
// only hides what a role can't use.
//
// Owners: the numbers in ADMIN_PHONES (server settings; always owners, can't be changed from the console, so
// nobody gets locked out) and anyone given the Owner role. Only owners can make, change or remove owners.
// Numbers that sign in with a shared code (the test number, DEMO_PHONES) can never be on the team.
//
//   GET    /api/admin/team                  → members, roles, the permissions there are
//   POST   /api/admin/team/members          { phone, name?, role }      add someone
//   PUT    /api/admin/team/members/:phone   { name?, role?, active? }   change their role, pause or resume
//   DELETE /api/admin/team/members/:phone                               remove them (at once)
//   POST   /api/admin/team/roles            { name, description?, permissions }
//   PUT    /api/admin/team/roles/:id        { name?, description?, permissions? }
//   DELETE /api/admin/team/roles/:id        (not the built-in ones; nobody may have it)
//   GET    /api/admin/team/audit            → the last 200 team changes
import { pool } from '../db/pool.js';
import { caller, loginEnabled } from '../auth.js';
import { production } from '../guard.js';
import { indianMobile } from '../login.js';
import { readJson, send, fail, route } from '../http.js';
import { z } from 'zod';

/** What a role can allow. The console shows these words. */
export const PERMISSIONS = {
  'dashboard.view': 'See the dashboard (learners, activity, spend, revenue)',
  'conversations.view': 'Read learners’ conversations (personal data)',
  'lessons.view': 'See lessons and how learners do in them',
  'settings.view': 'See the settings and their history',
  'settings.edit': 'Change settings (AI, corrections, limits, payments)',
  'playground.use': 'Use the playground (spends AI credit)',
  'evals.view': 'See evaluation runs',
  'evals.run': 'Start evaluation runs (spends AI credit)',
  'team.manage': 'Manage the team: add people, change roles',
};
const ALL = Object.keys(PERMISSIONS);

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
/** Numbers that sign in with a fixed, shared code. */
export const neverAdmin = () => new Set([process.env.FIREBASE_TEST_PHONE || '+919999900000', process.env.MSG91_TEST_PHONE, ...list(process.env.DEMO_PHONES)].filter(Boolean));
/** The owners from server settings. */
export const serverOwners = () => { const no = neverAdmin(); return new Set(list(process.env.ADMIN_PHONES).filter((p) => !no.has(p))); };

const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0] || null;
const perms = (stored) => (stored.includes('*') ? ALL : stored.filter((p) => PERMISSIONS[p]));

/**
 * Who is asking, and what they may do. Throws 401/403.
 * → { phone, name, role, roleName, permissions, fromServer }
 */
export async function whoIs(req) {
  if (!loginEnabled()) {
    if (production) throw fail(403, 'the admin console needs phone login on a public server');
    return { phone: 'local', name: 'Local development', role: 'owner', roleName: 'Owner', permissions: ALL, fromServer: true };
  }
  const who = await caller(req);
  if (!who) throw fail(401, 'login required');
  if (serverOwners().has(who.phone)) return { phone: who.phone, name: null, role: 'owner', roleName: 'Owner', permissions: ALL, fromServer: true };
  if (!pool || neverAdmin().has(who.phone)) throw fail(403, NOT_ON_TEAM);
  const m = await one(`select m.phone, m.name, m.active, m.role_id, r.name as role_name, r.permissions
      from admin_members m join admin_roles r on r.id = m.role_id where m.phone = $1`, [who.phone]);
  if (!m) throw fail(403, NOT_ON_TEAM);
  if (!m.active) throw fail(403, 'Your access to the admin console is paused. Ask an owner.');
  pool.query(`update admin_members set last_seen_at = now() where phone = $1 and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')`, [m.phone]).catch(() => {});
  return { phone: m.phone, name: m.name, role: m.role_id, roleName: m.role_name, permissions: perms(m.permissions), fromServer: false };
}
const NOT_ON_TEAM = 'This phone number isn’t on the admin team. Ask an owner to add you.';

export const can = (who, permission) => who.permissions.includes(permission);
/** Throws 403 unless [who]'s role allows [permission]. */
export function need(who, permission) {
  if (!can(who, permission)) throw fail(403, `Your role (${who.roleName}) doesn’t allow this: ${PERMISSIONS[permission].replace(/ \(.*\)$/, '').toLowerCase()}.`);
}

const audit = (actor, action, target, detail) =>
  pool.query('insert into admin_audit (actor, action, target, detail) values ($1, $2, $3, $4)', [actor, action, target, detail ? JSON.stringify(detail) : null]);

const Name = z.string().trim().max(80);
const Permissions = z.array(z.enum(ALL)).max(ALL.length).transform((a) => [...new Set(a)]);
const NewMember = z.strictObject({ phone: z.string().max(20), name: Name.optional(), role: z.string().max(40) });
const MemberChange = z.strictObject({ name: Name.optional(), role: z.string().max(40).optional(), active: z.boolean().optional() });
const NewRole = z.strictObject({ name: z.string().trim().min(2).max(40), description: z.string().trim().max(200).optional(), permissions: Permissions });
const RoleChange = z.strictObject({ name: z.string().trim().min(2).max(40).optional(), description: z.string().trim().max(200).optional(), permissions: Permissions.optional() });
function parse(schema, body) {
  const r = schema.safeParse(body);
  if (!r.success) throw fail(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

async function roleOrFail(id) {
  const r = await one('select * from admin_roles where id = $1', [id]);
  if (!r) throw fail(400, `there's no role "${id}"`);
  return r;
}
/** Someone who isn't an owner can't give out (or take away) more than their own permissions. */
function withinMine(who, permissions, what) {
  if (who.role === 'owner') return;
  const extra = perms(permissions).filter((x) => !can(who, x));
  if (extra.length) throw fail(403, `You can’t ${what} with permissions you don’t have yourself: ${extra.join(', ')}.`);
}
const ownerOnly = (who, what) => { if (who.role !== 'owner') throw fail(403, `Only an owner can ${what}.`); };

async function team() {
  const members = await q(`select m.phone, m.name, m.role_id as role, m.active, m.added_by as "addedBy", m.created_at as "createdAt",
      m.last_seen_at as "lastSeenAt" from admin_members m order by m.created_at`);
  const roles = await q(`select r.id, r.name, r.description, r.permissions, r.builtin, (select count(*)::int from admin_members m where m.role_id = r.id) as members
      from admin_roles r order by r.builtin desc, r.created_at`);
  const inDb = new Set(members.map((m) => m.phone));
  const fromServer = [...serverOwners()].filter((p) => !inDb.has(p)).map((phone) => ({ phone, name: null, role: 'owner', active: true, fromServer: true }));
  return {
    members: [...fromServer, ...members.map((m) => ({ ...m, fromServer: serverOwners().has(m.phone) }))],
    roles: roles.map((r) => ({ ...r, permissions: perms(r.permissions), everything: r.permissions.includes('*') })),
    permissions: PERMISSIONS,
  };
}

/** /api/admin/team/** for someone allowed to manage the team. → true when handled */
export async function handleTeam(req, res, url, who) {
  const p = url.pathname, m = req.method;
  if (!p.startsWith('/api/admin/team')) return false;
  if (!pool) throw fail(503, 'the team needs the database (DATABASE_URL)');
  need(who, 'team.manage');
  let a;

  if (m === 'GET' && p === '/api/admin/team') return send(res, 200, await team()), true;
  if (m === 'GET' && p === '/api/admin/team/audit') {
    return send(res, 200, { changes: await q('select at, actor, action, target, detail from admin_audit order by at desc limit 200') }), true;
  }

  if (m === 'POST' && p === '/api/admin/team/members') {
    const b = parse(NewMember, await readJson(req));
    const phone = indianMobile(b.phone);
    if (!phone) throw fail(400, 'That isn’t an Indian mobile number (like +91 98765 43210). Sign-in is by SMS, so it must be one.');
    if (neverAdmin().has(phone)) throw fail(400, 'That number signs in with a shared code (test or demo), so it can’t be on the team.');
    if (serverOwners().has(phone)) throw fail(409, 'That number is already an owner (from the server settings).');
    const role = await roleOrFail(b.role);
    if (role.id === 'owner') ownerOnly(who, 'add an owner');
    withinMine(who, role.permissions, 'give someone a role');
    const row = await one(`insert into admin_members (phone, name, role_id, added_by) values ($1, $2, $3, $4) on conflict (phone) do nothing returning phone`,
      [phone, b.name || null, role.id, who.phone]);
    if (!row) throw fail(409, 'That number is already on the team.');
    await audit(who.phone, 'member.added', phone, { name: b.name || null, role: role.id });
    return send(res, 201, await team()), true;
  }
  if ((a = route('/api/admin/team/members/:phone', p)) && (m === 'PUT' || m === 'DELETE')) {
    const phone = indianMobile(a.phone) || a.phone;
    if (serverOwners().has(phone)) throw fail(400, 'Owners from the server settings (ADMIN_PHONES) can only be changed there.');
    if (phone === who.phone) throw fail(400, 'You can’t change or remove yourself. Ask another owner.');
    const cur = await one('select * from admin_members where phone = $1', [phone]);
    if (!cur) throw fail(404, 'not on the team');
    if (cur.role_id === 'owner') ownerOnly(who, 'change or remove an owner');
    withinMine(who, (await roleOrFail(cur.role_id)).permissions, 'change someone');
    if (m === 'DELETE') {
      await lastOwnerCheck(phone);
      await pool.query('delete from admin_members where phone = $1', [phone]);
      await audit(who.phone, 'member.removed', phone, { role: cur.role_id });
      return send(res, 200, await team()), true;
    }
    const b = parse(MemberChange, await readJson(req));
    const role = b.role ? await roleOrFail(b.role) : null;
    if (role?.id === 'owner') ownerOnly(who, 'make someone an owner');
    if (role) withinMine(who, role.permissions, 'give someone a role');
    if ((role && role.id !== 'owner' && cur.role_id === 'owner') || (b.active === false && cur.role_id === 'owner')) await lastOwnerCheck(phone);
    await pool.query(`update admin_members set name = coalesce($2, name), role_id = coalesce($3, role_id), active = coalesce($4, active), updated_at = now() where phone = $1`,
      [phone, b.name ?? null, role?.id ?? null, b.active ?? null]);
    const changes = Object.fromEntries(Object.entries({ name: b.name, role: role?.id, active: b.active }).filter(([, v]) => v !== undefined));
    await audit(who.phone, 'member.changed', phone, { from: { name: cur.name, role: cur.role_id, active: cur.active }, to: changes });
    return send(res, 200, await team()), true;
  }

  if (m === 'POST' && p === '/api/admin/team/roles') {
    const b = parse(NewRole, await readJson(req));
    withinMine(who, b.permissions, 'make a role');
    const id = b.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (!id) throw fail(400, 'give the role a name with letters or numbers');
    const row = await one(`insert into admin_roles (id, name, description, permissions) values ($1, $2, $3, $4) on conflict (id) do nothing returning id`,
      [id, b.name, b.description || null, b.permissions]);
    if (!row) throw fail(409, 'There’s already a role with that name.');
    await audit(who.phone, 'role.created', id, { name: b.name, permissions: b.permissions });
    return send(res, 201, await team()), true;
  }
  if ((a = route('/api/admin/team/roles/:id', p)) && (m === 'PUT' || m === 'DELETE')) {
    const role = await one('select * from admin_roles where id = $1', [a.id]);
    if (!role) throw fail(404, 'no such role');
    if (role.id === 'owner') throw fail(400, 'The Owner role always has every permission.');
    if (m === 'DELETE') {
      if (role.builtin) throw fail(400, 'Built-in roles can’t be deleted (you can change what they allow).');
      withinMine(who, role.permissions, 'delete a role');
      const n = (await one('select count(*)::int as n from admin_members where role_id = $1', [role.id])).n;
      if (n) throw fail(409, `${n} ${n === 1 ? 'person has' : 'people have'} this role. Give them another role first.`);
      await pool.query('delete from admin_roles where id = $1', [role.id]);
      await audit(who.phone, 'role.deleted', role.id, { name: role.name });
      return send(res, 200, await team()), true;
    }
    const b = parse(RoleChange, await readJson(req));
    withinMine(who, role.permissions, 'change a role');
    if (b.permissions) withinMine(who, b.permissions, 'change a role');
    await pool.query(`update admin_roles set name = coalesce($2, name), description = coalesce($3, description), permissions = coalesce($4, permissions), updated_at = now() where id = $1`,
      [role.id, b.name ?? null, b.description ?? null, b.permissions ?? null]);
    await audit(who.phone, 'role.changed', role.id, { from: { name: role.name, permissions: role.permissions }, to: b });
    return send(res, 200, await team()), true;
  }
  throw fail(404, 'not found');
}

/** The team must keep at least one owner who can sign in (when there are none in the server settings). */
async function lastOwnerCheck(leaving) {
  if (serverOwners().size) return;
  const n = (await one(`select count(*)::int as n from admin_members where role_id = 'owner' and active and phone <> $1`, [leaving])).n;
  if (!n) throw fail(400, 'This is the last owner. Make someone else an owner first.');
}
