const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');
const path = require('node:path');
const root = path.join(__dirname, '..');
const profile = { introduction: '测试候选人简介', experiences: [
  { id: 'project', type: 'project', title: '测试项目', role: '项目负责人', contributions: ['负责测试系统设计'] },
  { id: 'intern', type: 'internship', title: '测试实习', role: '实习生', contributions: ['完成测试需求分析'] }
] };
async function setup({ accepted = true, history = [], configured = true } = {}) {
  const dom = new JSDOM(readFileSync(path.join(root, 'index.html'), 'utf8'), { url: 'https://example.test/chat', runScripts: 'outside-only' });
  const w = dom.window;
  w.setTimeout = () => 0;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.CANDIDATE_PROFILE = configured ? profile : {};
  const posts = [];
  let fail = false;
  w.fetch = async (url, options) => {
    if (options.method === 'POST') {
      if (fail) return { ok: false, status: 503, json: async () => ({ error: '发送失败' }) };
      const body = JSON.parse(options.body);
      posts.push(body);
      history.push({ id: String(history.length + 1), role: 'visitor', text: body.text, createdAt: new Date().toISOString() });
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => url.includes('/messages') ? { messages: history, cursor: '' } : { session: { candidateName: '测试候选人', consentStatus: accepted ? 'accepted' : 'pending', resumeAvailable: true } } };
  };
  w.eval(readFileSync(path.join(root, 'app.js'), 'utf8'));
  await new Promise(setImmediate);
  return { w, doc: w.document, posts, fail: () => { fail = true; }, close: () => w.close() };
}
async function send(app, text) {
  app.doc.querySelector('#messageInput').value = text;
  await app.w.eval('sendMessage({ preventDefault() {} })');
}
test('intro → company → cards → role and work → contextual question', async () => {
  const app = await setup();
  try {
    assert.match(app.doc.querySelector('.conversation-guide').textContent, /测试候选人简介.*请问您来自哪家公司/s);
    assert.equal(app.doc.querySelector('.guide-resume').getAttribute('href'), '/api/public/session/resume');
    assert.equal(app.doc.querySelectorAll('.experience-card').length, 0);
    await send(app, '测试公司');
    assert.equal(app.posts[0].text, '我来自的公司：测试公司');
    assert.equal(app.doc.querySelectorAll('.experience-card').length, 2);
    app.doc.querySelector('.experience-card').click();
    assert.match(app.doc.querySelector('.experience-detail').textContent, /项目负责人.*负责测试系统设计.*现在请开始提问/s);
    await send(app, '最大的难点是什么？');
    assert.match(app.posts[1].text, /测试项目.*项目负责人.*最大的难点是什么/s);
  } finally { app.close(); }
});
test('failed company send retains input and does not unlock cards', async () => {
  const app = await setup();
  try {
    app.fail(); await send(app, '测试公司');
    assert.equal(app.doc.querySelector('#messageInput').value, '测试公司');
    assert.equal(app.doc.querySelectorAll('.experience-card').length, 0);
    assert.equal(app.doc.querySelector('#sendButton').disabled, false);
  } finally { app.close(); }
});
test('company restores from history and unchanged polls retain card focus', async () => {
  const app = await setup({ history: [{ id: '1', role: 'visitor', text: '我来自的公司：测试公司', createdAt: '2026-09-11T12:00:00Z' }] });
  try {
    const card = app.doc.querySelector('.experience-card');
    assert.ok(card); card.focus();
    await app.w.eval('pollMessages()');
    assert.equal(app.doc.activeElement, card);
  } finally { app.close(); }
});
test('consent blocks onboarding and messages', async () => {
  const app = await setup({ accepted: false });
  try {
    assert.equal(app.doc.querySelector('#consentPanel').hidden, false);
    assert.equal(app.doc.querySelector('.conversation-guide'), null);
    await send(app, '测试公司'); assert.equal(app.posts.length, 0);
  } finally { app.close(); }
});
test('missing profile never invents experience; assistant reply remains visible', async () => {
  const app = await setup({ configured: false, history: [
    { id: '1', role: 'visitor', text: '我来自的公司：测试公司', createdAt: '2026-09-11T12:00:00Z' },
    { id: '2', role: 'assistant', text: '这是正常回复', createdAt: '2026-09-11T12:00:01Z' }
  ] });
  try {
    assert.match(app.doc.querySelector('.conversation-guide').textContent, /详细经历尚未配置/);
    assert.equal(app.doc.querySelector('.message-assistant .message-bubble').textContent, '这是正常回复');
    assert.equal(app.doc.querySelectorAll('.experience-card').length, 0);
  } finally { app.close(); }
});
test('company names render as text, never executable HTML', async () => {
  const app = await setup();
  try {
    await send(app, '<img src=x onerror=alert(1)>');
    assert.equal(app.doc.querySelector('.conversation-guide img'), null);
    assert.match(app.doc.querySelector('.conversation-guide').textContent, /<img/);
  } finally { app.close(); }
});
