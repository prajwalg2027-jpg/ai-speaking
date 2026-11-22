// The admin team and access control (server/admin/team.js), against a real PostgreSQL (TEST_DATABASE_URL; skipped
// without it): owners from ADMIN_PHONES, adding people with roles, each role's limits enforced on the server,
// custom roles, pausing and removing, nobody giving out more than they have, and the record of changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { startMockRest } from './mock-sarvam-rest.js';

const url = process.env.TEST_DATABASE_URL;
const PROJECT = 'sakhi-test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let server, base, pool, mock;

before(async () => {
  if (!url) return;
  mock = await startMockRest();
  Object.assign(process.env, { SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: mock.url, DATABASE_URL: url, FIREBASE_PROJECT_ID: PROJECT, ADMIN_PHONES: '+919800009999', DEMO_PHONES: '+919000000001' });
  ({ pool } = await import('../server/db/pool.js'));
  await pool.query('drop schema public cascade; create schema public');
  await (await import('../server/db/migrate.js')).migrate(pool, () => {});
  (await import('../server/auth.js')).setKeyResolver(async () => ({ k1: publicKey }));
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); mock?.close(); await pool?.end(); });
const t = (name, fn) => test(name, { skip: !url && 'set TEST_DATABASE_URL to run' }, fn);

const iat = Math.floor(Date.now() / 1000);
function login(uid, phone) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: uid, iat, exp: iat + 3600, auth_time: iat, phone_number: phone, firebase: { sign_in_provider: 'phone' } })}`;
  return { authorization: `Bearer ${head}.${createSign('RSA-SHA256').update(head).sign(privateKey).toString('base64url')}` };
}
const call = async (method, path, headers = {}, body) => {
  const r = await fetch(`${base}/api/admin${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const owner = login('u-owner', '+919800009999');
const priya = login('u-priya', '+919800000021'), arjun = login('u-arjun', '+919800000022'), meera = login('u-meera', '+919800000023');
const add = (who, phone, role, name) => call('POST', '/team/members', who, { phone, role, name });

t('the owner from ADMIN_PHONES sees the team: themselves and the built-in roles', async () => {
  const me = (await call('GET', '/me', owner)).json;
  assert.deepEqual([me.role, me.fromServer], ['owner', true]);
  assert.ok(me.permissions.includes('team.manage'));
  const team = (await call('GET', '/team', owner)).json;
  assert.deepEqual(team.members.map((m) => [m.phone, m.role, m.fromServer]), [['+919800009999', 'owner', true]]);
  assert.deepEqual(team.roles.map((r) => r.id), ['owner', 'admin', 'analyst', 'support']);
  assert.equal(team.roles[0].everything, true);
  assert.ok(team.permissions['settings.edit']);
});

t('someone not on the team is turned away', async () => {
  const r = await call('GET', '/me', priya);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /isn’t on the admin team/);
});

t('adding people: their role decides what they can do, on the server', async () => {
  assert.equal((await add(owner, '98000 00021', 'support', 'Priya')).status, 201); // any common form of the number
  assert.equal((await add(owner, '+919800000022', 'analyst', 'Arjun')).status, 201);
  const me = (await call('GET', '/me', priya)).json;
  assert.deepEqual([me.name, me.role, me.roleName], ['Priya', 'support', 'Support']);
  // Support: dashboard, conversations, lessons. Not settings, playground, evaluations or the team.
  for (const p of ['/overview', '/conversations', '/lessons']) assert.equal((await call('GET', p, priya)).status, 200, p);
  for (const [m, p] of [['GET', '/settings'], ['POST', '/playground'], ['GET', '/evals'], ['GET', '/team']]) {
    const r = await call(m, p, priya, m === 'POST' ? { message: 'hi' } : undefined);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.match(r.json.error, /Your role \(Support\) doesn’t allow this/);
  }
  // Analyst: can read settings and evaluations, change nothing, and can't read learners' conversations.
  assert.equal((await call('GET', '/settings', arjun)).status, 200);
  assert.equal((await call('PUT', '/settings/limits', arjun, { value: {} })).status, 403);
  assert.equal((await call('POST', '/settings/limits/reset', arjun)).status, 403);
  assert.equal((await call('POST', '/evals', arjun, {})).status, 403);
  assert.equal((await call('GET', '/conversations', arjun)).status, 403);
  // Last seen is recorded.
  assert.ok((await call('GET', '/team', owner)).json.members.find((m) => m.phone === '+919800000021').lastSeenAt);
});

t('numbers that can’t be on the team, and duplicates', async () => {
  assert.match((await add(owner, '+919000000001', 'support')).json.error, /shared code/, 'a demo number');
  assert.match((await add(owner, '+919999900000', 'support')).json.error, /shared code/, 'the test number');
  assert.equal((await add(owner, '+919800009999', 'support')).status, 409, 'already an owner from the server settings');
  assert.equal((await add(owner, '+919800000021', 'admin')).status, 409, 'already on the team');
  assert.equal((await add(owner, '12345', 'support')).status, 400);
  assert.equal((await add(owner, '+919800000030', 'nobody')).status, 400, 'no such role');
});

t('changing a role, pausing and removing take effect at once', async () => {
  assert.equal((await call('PUT', '/team/members/+919800000021', owner, { role: 'admin' })).status, 200);
  assert.equal((await call('GET', '/settings', priya)).status, 200, 'now an admin');
  assert.equal((await call('PUT', '/team/members/+919800000021', owner, { active: false })).status, 200);
  assert.match((await call('GET', '/me', priya)).json.error, /paused/);
  await call('PUT', '/team/members/+919800000021', owner, { active: true });
  assert.equal((await call('GET', '/me', priya)).status, 200);
  assert.equal((await call('DELETE', '/team/members/+919800000022', owner)).status, 200);
  assert.equal((await call('GET', '/me', arjun)).status, 403, 'removed');
  assert.match((await call('PUT', '/team/members/+919800009999', owner, { role: 'support' })).json.error, /server settings/);
});

t('custom roles: made, used, changed; in use or built-in can’t be deleted; Owner can’t be changed', async () => {
  const r = await call('POST', '/team/roles', owner, { name: 'Content team', description: 'Lessons', permissions: ['lessons.view', 'settings.view', 'lessons.view'] });
  assert.equal(r.status, 201);
  const role = r.json.roles.find((x) => x.id === 'content-team');
  assert.deepEqual(role.permissions, ['lessons.view', 'settings.view']);
  assert.equal((await call('POST', '/team/roles', owner, { name: 'Content Team', permissions: [] })).status, 409, 'same name');
  assert.equal((await call('POST', '/team/roles', owner, { name: 'Bad', permissions: ['everything'] })).status, 400);
  await add(owner, '+919800000023', 'content-team', 'Meera');
  assert.equal((await call('GET', '/lessons', meera)).status, 200);
  assert.equal((await call('GET', '/overview', meera)).status, 403);
  await call('PUT', '/team/roles/content-team', owner, { permissions: ['lessons.view', 'dashboard.view'] });
  assert.equal((await call('GET', '/overview', meera)).status, 200, 'the change applies at once');
  assert.equal((await call('DELETE', '/team/roles/content-team', owner)).status, 409, 'Meera has it');
  assert.equal((await call('DELETE', '/team/roles/support', owner)).status, 400, 'built in');
  assert.equal((await call('PUT', '/team/roles/owner', owner, { permissions: [] })).status, 400);
});

t('a team manager who isn’t an owner can’t give out more than they have', async () => {
  await call('POST', '/team/roles', owner, { name: 'Team lead', permissions: ['team.manage', 'dashboard.view', 'lessons.view'] });
  await call('PUT', '/team/members/+919800000023', owner, { role: 'team-lead' });
  const lead = meera;
  assert.equal((await call('GET', '/team', lead)).status, 200);
  assert.match((await add(lead, '+919800000031', 'owner')).json.error, /Only an owner/);
  assert.match((await add(lead, '+919800000031', 'admin')).json.error, /permissions you don’t have/);
  assert.match((await call('POST', '/team/roles', lead, { name: 'Sneaky', permissions: ['settings.edit'] })).json.error, /permissions you don’t have/);
  assert.equal((await call('POST', '/team/roles', lead, { name: 'Viewer', permissions: ['dashboard.view'] })).status, 201);
  assert.equal((await add(lead, '+919800000031', 'viewer')).status, 201);
  assert.match((await call('PUT', '/team/members/+919800000021', lead, { role: 'viewer' })).json.error, /permissions you don’t have/, 'can’t demote an admin');
  assert.match((await call('PUT', '/team/members/+919800000023', lead, { role: 'admin' })).json.error, /yourself/);
});

t('only owners manage owners', async () => {
  assert.equal((await call('PUT', '/team/members/+919800000021', owner, { role: 'owner' })).status, 200);
  assert.equal((await call('GET', '/team', priya)).status, 200, 'a second owner manages the team');
  assert.match((await call('DELETE', '/team/members/+919800000021', meera)).json.error, /Only an owner/);
  assert.match((await call('DELETE', '/team/members/+919800000021', priya)).json.error, /yourself/);
});

t('every team change is recorded with who made it', async () => {
  const { changes } = (await call('GET', '/team/audit', owner)).json;
  const actions = changes.map((c) => `${c.actor} ${c.action} ${c.target}`);
  assert.ok(actions.includes('+919800009999 member.added +919800000021'));
  assert.ok(actions.includes('+919800009999 member.removed +919800000022'));
  assert.ok(actions.includes('+919800009999 role.created content-team'));
  assert.ok(actions.includes('+919800000023 member.added +919800000031'));
  assert.equal(changes.find((c) => c.action === 'member.changed' && c.detail.to.role === 'owner').detail.from.role, 'admin');
});
