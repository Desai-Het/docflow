'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { setup, login, CSRF } = require('./helpers');

let app;
let db;
let alice;
let bob;
let carol;

before(async () => {
  ({ app, db } = await setup());
  alice = await login(app, 'alice@demo.test');
  bob = await login(app, 'bob@demo.test');
  carol = await login(app, 'carol@demo.test');
});
after(async () => db.close());

const text = (t) => ({ ops: [{ insert: `${t}\n` }] });

async function newDoc(agent, title = 'History doc') {
  return (await agent.post('/api/docs').set(...CSRF).send({ title }).expect(201)).body.document;
}
async function save(agent, id, content, version) {
  return (await agent.patch(`/api/docs/${id}`).set(...CSRF).send({ content, version }).expect(200)).body.document;
}
async function share(id, email, role) {
  await alice.put(`/api/docs/${id}/shares`).set(...CSRF).send({ email, role }).expect(200);
}

describe('version history', () => {
  test('creating a document records an initial version', async () => {
    const doc = await newDoc(alice);
    const { versions, current_version: current } = (await alice.get(`/api/docs/${doc.id}/versions`).expect(200)).body;
    assert.equal(versions.length, 1);
    assert.equal(versions[0].kind, 'created');
    assert.equal(versions[0].author_name, 'Alice Owner');
    assert.equal(current, 1);
  });

  test('consecutive saves by one person are grouped; another author starts a new entry', async () => {
    const doc = await newDoc(alice);
    await share(doc.id, 'bob@demo.test', 'editor');
    let v = await save(alice, doc.id, text('one'), 1);
    v = await save(alice, doc.id, text('one two'), v.version);
    v = await save(bob, doc.id, text('one two three'), v.version);

    const { versions } = (await alice.get(`/api/docs/${doc.id}/versions`).expect(200)).body;
    assert.deepEqual(versions.map((x) => [x.kind, x.author_name]), [
      ['edited', 'Bob Collaborator'],
      ['edited', 'Alice Owner'],
      ['created', 'Alice Owner'],
    ]);
    const aliceEdit = (await alice.get(`/api/docs/${doc.id}/versions/${versions[1].id}`).expect(200)).body.version;
    assert.deepEqual(aliceEdit.content, text('one two'), 'grouped entry holds the latest content of that session');
  });

  test('restore brings old content back as a new version and keeps history', async () => {
    const doc = await newDoc(alice);
    let v = await save(alice, doc.id, text('first draft'), 1);
    await share(doc.id, 'bob@demo.test', 'editor');
    v = await save(bob, doc.id, text('rewritten by bob'), v.version);

    const { versions } = (await alice.get(`/api/docs/${doc.id}/versions`).expect(200)).body;
    const aliceVersion = versions.find((x) => x.author_name === 'Alice Owner' && x.kind === 'edited');

    // Stale client version is rejected.
    await alice.post(`/api/docs/${doc.id}/versions/${aliceVersion.id}/restore`).set(...CSRF).send({ version: 1 }).expect(409);

    const restored = (await alice.post(`/api/docs/${doc.id}/versions/${aliceVersion.id}/restore`)
      .set(...CSRF).send({ version: v.version }).expect(200)).body.document;
    assert.deepEqual(restored.content, text('first draft'));
    assert.equal(restored.version, v.version + 1);

    const after = (await alice.get(`/api/docs/${doc.id}/versions`).expect(200)).body.versions;
    assert.equal(after[0].kind, 'restored');
    assert.equal(after.length, versions.length + 1);
  });

  test('viewers can browse history but not restore; strangers get 404', async () => {
    const doc = await newDoc(alice);
    await share(doc.id, 'carol@demo.test', 'viewer');
    const { versions } = (await carol.get(`/api/docs/${doc.id}/versions`).expect(200)).body;
    await carol.get(`/api/docs/${doc.id}/versions/${versions[0].id}`).expect(200);
    await carol.post(`/api/docs/${doc.id}/versions/${versions[0].id}/restore`).set(...CSRF).send({ version: 1 }).expect(403);
    await bob.get(`/api/docs/${doc.id}/versions`).expect(404);
    await bob.get(`/api/docs/${doc.id}/versions/${versions[0].id}`).expect(404);
  });

  test('a version id from another document is not found', async () => {
    const a = await newDoc(alice, 'A');
    const b = await newDoc(alice, 'B');
    const bVersion = (await alice.get(`/api/docs/${b.id}/versions`).expect(200)).body.versions[0];
    await alice.get(`/api/docs/${a.id}/versions/${bVersion.id}`).expect(404);
    await alice.get(`/api/docs/${a.id}/versions/abc`).expect(404);
  });
});

describe('presence', () => {
  test('shows who else has the document open and whether they are editing', async () => {
    const doc = await newDoc(alice, 'Presence');
    await share(doc.id, 'bob@demo.test', 'editor');
    await share(doc.id, 'carol@demo.test', 'viewer');

    await bob.post(`/api/docs/${doc.id}/presence`).set(...CSRF).send({ editing: true }).expect(200);
    await carol.post(`/api/docs/${doc.id}/presence`).set(...CSRF).send({ editing: true }).expect(200);
    const res = (await alice.post(`/api/docs/${doc.id}/presence`).set(...CSRF).send({ editing: false }).expect(200)).body;

    assert.deepEqual(res.active.map((p) => [p.name, p.editing]), [
      ['Bob Collaborator', true],
      ['Carol Outsider', false], // viewers can never show as editing
    ]);
    assert.equal(res.version, 1);
    assert.ok(!res.active.some((p) => p.name === 'Alice Owner'), 'you do not see yourself');

    await bob.delete(`/api/docs/${doc.id}/presence`).set(...CSRF).expect(200);
    const after = (await alice.post(`/api/docs/${doc.id}/presence`).set(...CSRF).send({}).expect(200)).body;
    assert.deepEqual(after.active.map((p) => p.name), ['Carol Outsider']);
  });

  test('shares email and cursor position; viewers and invalid cursors show no cursor', async () => {
    const doc = await newDoc(alice, 'Cursors');
    await share(doc.id, 'bob@demo.test', 'editor');
    await share(doc.id, 'carol@demo.test', 'viewer');

    await bob.post(`/api/docs/${doc.id}/presence`).set(...CSRF).send({ editing: true, cursor: { index: 4, length: 2 } }).expect(200);
    await carol.post(`/api/docs/${doc.id}/presence`).set(...CSRF).send({ cursor: { index: 1, length: 0 } }).expect(200);
    let res = (await alice.post(`/api/docs/${doc.id}/presence`).set(...CSRF).send({}).expect(200)).body;
    assert.deepEqual(res.active.map((p) => [p.email, p.editing, p.cursor]), [
      ['bob@demo.test', true, { index: 4, length: 2 }],
      ['carol@demo.test', false, null],
    ]);

    for (const cursor of [{ index: -1, length: 0 }, { index: 1.5, length: 0 }, { index: 'x', length: 0 }, { index: 2 }, 'nope']) {
      await bob.post(`/api/docs/${doc.id}/presence`).set(...CSRF).send({ cursor }).expect(200);
      res = (await alice.post(`/api/docs/${doc.id}/presence`).set(...CSRF).send({}).expect(200)).body;
      assert.equal(res.active.find((p) => p.email === 'bob@demo.test').cursor, null);
    }
  });

  test('presence requires access to the document', async () => {
    const doc = await newDoc(alice, 'Private presence');
    await bob.post(`/api/docs/${doc.id}/presence`).set(...CSRF).send({}).expect(404);
  });
});
