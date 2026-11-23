'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
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

const sampleDelta = {
  ops: [
    { insert: 'Plan' },
    { insert: '\n', attributes: { header: 1 } },
    { insert: 'Ship it', attributes: { bold: true } },
    { insert: '\n', attributes: { list: 'bullet' } },
  ],
};

async function createDoc(agent, title = 'Test doc') {
  const res = await agent.post('/api/docs').set(...CSRF).send({ title }).expect(201);
  return res.body.document;
}

describe('authentication', () => {
  test('API rejects anonymous requests', async () => {
    await request(app).get('/api/docs').expect(401);
  });

  test('wrong password is rejected with a generic message', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set(...CSRF)
      .send({ email: 'alice@demo.test', password: 'nope-nope' })
      .expect(401);
    assert.equal(res.body.error, 'Incorrect email or password.');
  });

  test('session cookie is httpOnly', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set(...CSRF)
      .send({ email: 'bob@demo.test', password: 'Password123!' })
      .expect(200);
    assert.match(res.headers['set-cookie'][0], /HttpOnly/i);
  });

  test('session probe returns null when signed out and the user when signed in', async () => {
    const anon = await request(app).get('/api/auth/session').expect(200);
    assert.equal(anon.body.user, null);
    const bad = await request(app).get('/api/auth/session').set('Cookie', 'docflow_session=forged.token.value').expect(200);
    assert.equal(bad.body.user, null);
    const me = await alice.get('/api/auth/session').expect(200);
    assert.equal(me.body.user.email, 'alice@demo.test');
  });

  test('mutations without the CSRF header are refused', async () => {
    await alice.post('/api/docs').send({ title: 'x' }).expect(403);
  });

  test('register validates email, password rules and confirmation, and blocks duplicates', async () => {
    const reg = (body) => request(app).post('/api/auth/register').set(...CSRF).send(body);
    const base = { name: 'Dan', email: 'dan@demo.test', password: 'Secret#123', confirmPassword: 'Secret#123' };

    for (const email of ['not-an-email', 'dan@', 'dan@demo', 'dan..x@demo.test', 'dan @demo.test']) {
      const res = await reg({ ...base, email }).expect(400);
      assert.match(res.body.error, /valid email/);
    }
    const weak = [
      ['Sh#1', /8 to 128/],
      ['NoSpecial123', /special character/],
      ['NoNumber!!', /number/],
      ['12345678!', /letter/],
      ['Has Space#1', /spaces/],
    ];
    for (const [password, msg] of weak) {
      const res = await reg({ ...base, password, confirmPassword: password }).expect(400);
      assert.match(res.body.error, msg);
    }
    const mismatch = await reg({ ...base, confirmPassword: 'Secret#124' }).expect(400);
    assert.equal(mismatch.body.error, 'Passwords do not match.');

    await reg(base).expect(201);
    await reg({ ...base, email: 'DAN@demo.test' }).expect(409);
  });
});

describe('documents', () => {
  test('create, rename, save and reopen preserves formatting', async () => {
    const doc = await createDoc(alice, 'Draft');
    assert.equal(doc.version, 1);

    await alice.patch(`/api/docs/${doc.id}`).set(...CSRF).send({ title: '  Q3 Plan  ' }).expect(200);
    const saved = await alice.patch(`/api/docs/${doc.id}`).set(...CSRF)
      .send({ content: sampleDelta, version: 1 }).expect(200);
    assert.equal(saved.body.document.version, 2);

    const reopened = await alice.get(`/api/docs/${doc.id}`).expect(200);
    assert.equal(reopened.body.document.title, 'Q3 Plan');
    assert.deepEqual(reopened.body.document.content, sampleDelta);
    assert.equal(reopened.body.document.role, 'owner');
  });

  test('stale saves are rejected with 409 instead of overwriting', async () => {
    const doc = await createDoc(alice);
    await alice.patch(`/api/docs/${doc.id}`).set(...CSRF).send({ content: sampleDelta, version: 1 }).expect(200);
    const stale = await alice.patch(`/api/docs/${doc.id}`).set(...CSRF)
      .send({ content: { ops: [{ insert: 'old\n' }] }, version: 1 }).expect(409);
    assert.equal(stale.body.currentVersion, 2);
  });

  test('unsafe or unsupported content is rejected', async () => {
    const doc = await createDoc(alice);
    const bad = [
      { ops: [{ insert: { image: 'javascript:alert(1)' } }] },
      { ops: [{ insert: 'x', attributes: { link: 'javascript:alert(1)' } }] },
      { ops: [{ insert: 'x\n', attributes: { header: 7 } }] },
      { ops: 'nope' },
    ];
    for (const content of bad) {
      await alice.patch(`/api/docs/${doc.id}`).set(...CSRF).send({ content, version: 1 }).expect(400);
    }
  });

  test('empty and overlong titles are rejected', async () => {
    const doc = await createDoc(alice);
    await alice.patch(`/api/docs/${doc.id}`).set(...CSRF).send({ title: '   ' }).expect(400);
    await alice.patch(`/api/docs/${doc.id}`).set(...CSRF).send({ title: 'x'.repeat(121) }).expect(400);
  });

  test('malformed and unknown ids return 404', async () => {
    await alice.get('/api/docs/not-a-uuid').expect(404);
    await alice.get('/api/docs/00000000-0000-4000-8000-000000000000').expect(404);
  });

  test('markdown export reflects formatting', async () => {
    const doc = await createDoc(alice, 'Export me');
    await alice.patch(`/api/docs/${doc.id}`).set(...CSRF).send({ content: sampleDelta, version: 1 }).expect(200);
    const res = await alice.get(`/api/docs/${doc.id}/export.md`).expect(200);
    assert.match(res.headers['content-disposition'], /attachment; filename="Export-me.md"/);
    assert.equal(res.text, '# Plan\n\n- **Ship it**\n');
  });
});

describe('sharing and access control', () => {
  test('owner shares as viewer: shows under "shared", viewer cannot edit', async () => {
    const doc = await createDoc(alice, 'Roadmap');

    // Before sharing, Bob cannot even see that it exists.
    await bob.get(`/api/docs/${doc.id}`).expect(404);

    await alice.put(`/api/docs/${doc.id}/shares`).set(...CSRF)
      .send({ email: 'BOB@demo.test', role: 'viewer' }).expect(200);

    const list = await bob.get('/api/docs').expect(200);
    const shared = list.body.shared.find((d) => d.id === doc.id);
    assert.ok(shared, 'document appears in Bob\'s shared list');
    assert.equal(shared.role, 'viewer');
    assert.equal(shared.owner_email, 'alice@demo.test');
    assert.ok(!list.body.owned.some((d) => d.id === doc.id), 'not listed as owned by Bob');

    const read = await bob.get(`/api/docs/${doc.id}`).expect(200);
    assert.equal(read.body.document.role, 'viewer');
    await bob.patch(`/api/docs/${doc.id}`).set(...CSRF).send({ content: sampleDelta, version: 1 }).expect(403);
    await bob.patch(`/api/docs/${doc.id}`).set(...CSRF).send({ title: 'hijacked' }).expect(403);
  });

  test('editor can edit but cannot delete, reshare or see share list', async () => {
    const doc = await createDoc(alice, 'Team notes');
    await alice.put(`/api/docs/${doc.id}/shares`).set(...CSRF)
      .send({ email: 'bob@demo.test', role: 'editor' }).expect(200);

    await bob.patch(`/api/docs/${doc.id}`).set(...CSRF).send({ content: sampleDelta, version: 1 }).expect(200);
    await bob.delete(`/api/docs/${doc.id}`).set(...CSRF).expect(403);
    await bob.put(`/api/docs/${doc.id}/shares`).set(...CSRF)
      .send({ email: 'carol@demo.test', role: 'editor' }).expect(403);
    await bob.get(`/api/docs/${doc.id}/shares`).expect(403);

    // Alice sees Bob's edit.
    const seen = await alice.get(`/api/docs/${doc.id}`).expect(200);
    assert.deepEqual(seen.body.document.content, sampleDelta);
  });

  test('users without access get 404 for every operation', async () => {
    const doc = await createDoc(alice, 'Secret');
    await carol.get(`/api/docs/${doc.id}`).expect(404);
    await carol.patch(`/api/docs/${doc.id}`).set(...CSRF).send({ title: 'x' }).expect(404);
    await carol.delete(`/api/docs/${doc.id}`).set(...CSRF).expect(404);
    await carol.get(`/api/docs/${doc.id}/export.md`).expect(404);
    await carol.get(`/api/docs/${doc.id}/shares`).expect(404);
  });

  test('revoking access removes it immediately', async () => {
    const doc = await createDoc(alice, 'Temp');
    const shared = await alice.put(`/api/docs/${doc.id}/shares`).set(...CSRF)
      .send({ email: 'carol@demo.test', role: 'editor' }).expect(200);
    const carolId = shared.body.shares.find((s) => s.email === 'carol@demo.test').user_id;
    await carol.get(`/api/docs/${doc.id}`).expect(200);
    await alice.delete(`/api/docs/${doc.id}/shares/${carolId}`).set(...CSRF).expect(200);
    await carol.get(`/api/docs/${doc.id}`).expect(404);
  });

  test('sharing validates target user and role', async () => {
    const doc = await createDoc(alice);
    await alice.put(`/api/docs/${doc.id}/shares`).set(...CSRF)
      .send({ email: 'nobody@demo.test', role: 'viewer' }).expect(404);
    await alice.put(`/api/docs/${doc.id}/shares`).set(...CSRF)
      .send({ email: 'alice@demo.test', role: 'viewer' }).expect(400);
    await alice.put(`/api/docs/${doc.id}/shares`).set(...CSRF)
      .send({ email: 'bob@demo.test', role: 'admin' }).expect(400);
  });

  test('seed: welcome doc gives Bob edit and Carol view access; Bob shares Sprint Notes with Alice', async () => {
    const bobList = (await bob.get('/api/docs').expect(200)).body;
    assert.equal(bobList.shared.find((d) => d.title === 'Welcome to DocFlow').role, 'editor');
    const carolList = (await carol.get('/api/docs').expect(200)).body;
    assert.equal(carolList.shared.find((d) => d.title === 'Welcome to DocFlow').role, 'viewer');
    const aliceList = (await alice.get('/api/docs').expect(200)).body;
    const sprint = aliceList.shared.find((d) => d.title === 'Sprint Notes');
    assert.equal(sprint.role, 'viewer');
    assert.equal(sprint.owner_email, 'bob@demo.test');
  });

  test('"anyone with the link" grants the chosen role to any signed-in user', async () => {
    const doc = await createDoc(alice, 'Link doc');
    const url = `/api/docs/${doc.id}`;
    await carol.get(url).expect(404); // restricted by default

    await alice.put(`${url}/link-access`).set(...CSRF).send({ access: 'viewer' }).expect(200);
    const asViewer = await carol.get(url).expect(200);
    assert.equal(asViewer.body.document.role, 'viewer');
    assert.equal(asViewer.body.document.access_via, 'link');
    assert.equal(asViewer.body.document.link_access, undefined, 'non-owners do not see the setting');
    await carol.patch(url).set(...CSRF).send({ content: sampleDelta, version: 1 }).expect(403);

    await alice.put(`${url}/link-access`).set(...CSRF).send({ access: 'editor' }).expect(200);
    await carol.patch(url).set(...CSRF).send({ content: sampleDelta, version: 1 }).expect(200);
    await carol.delete(url).set(...CSRF).expect(403); // link editors still can't delete
    await carol.put(`${url}/link-access`).set(...CSRF).send({ access: null }).expect(403); // or change access

    // Link access does not list the doc under "Shared with me" (only direct shares do).
    const list = (await carol.get('/api/docs').expect(200)).body;
    assert.ok(!list.shared.some((d) => d.id === doc.id));

    // Owner sees the setting; turning it off removes access immediately.
    const shares = (await alice.get(`${url}/shares`).expect(200)).body;
    assert.equal(shares.link_access, 'editor');
    await alice.put(`${url}/link-access`).set(...CSRF).send({ access: null }).expect(200);
    await carol.get(url).expect(404);
    await request(app).get(url).expect(401); // never anonymous
  });

  test('a direct viewer share is upgraded when the link grants edit', async () => {
    const doc = await createDoc(alice, 'Mixed');
    await alice.put(`/api/docs/${doc.id}/shares`).set(...CSRF).send({ email: 'bob@demo.test', role: 'viewer' }).expect(200);
    await alice.put(`/api/docs/${doc.id}/link-access`).set(...CSRF).send({ access: 'editor' }).expect(200);
    const res = await bob.get(`/api/docs/${doc.id}`).expect(200);
    assert.equal(res.body.document.role, 'editor');
    assert.equal(res.body.document.access_via, 'link');
  });

  test('link access rejects invalid values', async () => {
    const doc = await createDoc(alice);
    await alice.put(`/api/docs/${doc.id}/link-access`).set(...CSRF).send({ access: 'owner' }).expect(400);
    await alice.put(`/api/docs/${doc.id}/link-access`).set(...CSRF).send({}).expect(400);
  });
});

describe('file import', () => {
  test('.md upload becomes a formatted document owned by the uploader', async () => {
    const md = '# Meeting notes\n\nWe agreed on **two** things:\n\n1. Ship\n2. *Celebrate*\n\n<script>alert(1)</script>\n';
    const res = await alice.post('/api/docs/import').set(...CSRF)
      .attach('file', Buffer.from(md), 'meeting_notes.md').expect(201);
    const { document } = (await alice.get(`/api/docs/${res.body.document.id}`).expect(200)).body;
    assert.equal(document.title, 'meeting notes');
    assert.equal(document.source, 'md');
    assert.deepEqual(document.content.ops, [
      { insert: 'Meeting notes' },
      { insert: '\n', attributes: { header: 1 } },
      { insert: 'We agreed on ' },
      { insert: 'two', attributes: { bold: true } },
      { insert: ' things:' },
      { insert: '\n' },
      { insert: 'Ship' },
      { insert: '\n', attributes: { list: 'ordered' } },
      { insert: 'Celebrate', attributes: { italic: true } },
      { insert: '\n', attributes: { list: 'ordered' } },
    ]);
  });

  test('.docx upload keeps headings, bold, underline and lists', async () => {
    const docx = await Packer.toBuffer(new Document({
      sections: [{
        children: [
          new Paragraph({ text: 'Quarterly Report', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun('Revenue is '), new TextRun({ text: 'up', bold: true }), new TextRun(' and '), new TextRun({ text: 'stable', underline: {} })] }),
          new Paragraph({ text: 'Hire', bullet: { level: 0 } }),
        ],
      }],
    }));
    const res = await alice.post('/api/docs/import').set(...CSRF)
      .attach('file', docx, 'report.docx').expect(201);
    const { document } = (await alice.get(`/api/docs/${res.body.document.id}`).expect(200)).body;
    assert.equal(document.title, 'report');
    assert.deepEqual(document.content.ops, [
      { insert: 'Quarterly Report' },
      { insert: '\n', attributes: { header: 1 } },
      { insert: 'Revenue is ' },
      { insert: 'up', attributes: { bold: true } },
      { insert: ' and ' },
      { insert: 'stable', attributes: { underline: true } },
      { insert: '\n' },
      { insert: 'Hire' },
      { insert: '\n', attributes: { list: 'bullet' } },
    ]);
  });

  test('.txt upload keeps lines', async () => {
    const res = await alice.post('/api/docs/import').set(...CSRF)
      .attach('file', Buffer.from('line one\r\nline two'), 'notes.txt').expect(201);
    const { document } = (await alice.get(`/api/docs/${res.body.document.id}`).expect(200)).body;
    assert.deepEqual(document.content, { ops: [{ insert: 'line one\nline two\n' }] });
  });

  test('unsupported, fake, empty and oversized files are rejected', async () => {
    await alice.post('/api/docs/import').set(...CSRF)
      .attach('file', Buffer.from('%PDF-1.4'), 'file.pdf').expect(400);
    await alice.post('/api/docs/import').set(...CSRF)
      .attach('file', Buffer.from('not really a zip'), 'fake.docx').expect(400);
    await alice.post('/api/docs/import').set(...CSRF)
      .attach('file', Buffer.from('a\u0000b'), 'binary.txt').expect(400);
    await alice.post('/api/docs/import').set(...CSRF).expect(400);
    await alice.post('/api/docs/import').set(...CSRF)
      .attach('file', Buffer.alloc(2 * 1024 * 1024 + 1, 'a'), 'big.txt').expect(413);
  });
});
