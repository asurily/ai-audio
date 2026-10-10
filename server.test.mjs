import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAppServer, createMemoryTaskStore } from './server.mjs';

function createTestApp(options) {
  return createAppServer({ ...options, taskStore: createMemoryTaskStore() });
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('创建任务、查询状态并代理下载视频', async () => {
  const calls = [];
  const upstream = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-key');
    calls.push(`${req.method} ${req.url}`);
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), {
        model: 'Doubao-Seedance-2.5',
        content: [{ type: 'text', text: '日出时的海面\n\n字幕要求：在画面下方生成清晰、易读的中文字幕，准确显示以下文字，不要改写：你好，世界' }],
        ratio: '16:9', duration: 30, generate_audio: false, watermark: false,
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'task_123', status: 'queued' }));
    } else if (req.url.endsWith('/content')) {
      res.setHeader('Content-Type', 'video/mp4');
      if (req.headers.range) {
        assert.equal(req.headers.range, 'bytes=0-3');
        res.writeHead(206, { 'Content-Range': 'bytes 0-3/10', 'Accept-Ranges': 'bytes' });
        res.end(Buffer.from('mock'));
      } else {
        res.end(Buffer.from('mock-video'));
      }
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'task_123', status: 'succeeded' }));
    }
  });
  const upstreamUrl = await listen(upstream);
  const app = createTestApp({ apiKey: 'test-key', baseUrl: upstreamUrl });
  const appUrl = await listen(app);
  try {
    const created = await fetch(`${appUrl}/api/videos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '  日出时的海面  ', model: 'Doubao-Seedance-2.5', ratio: '16:9', duration: 30, generateAudio: false, subtitleEnabled: true, subtitleText: '你好，世界' }),
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).id, 'task_123');
    const status = await fetch(`${appUrl}/api/videos/task_123`);
    assert.equal((await status.json()).status, 'succeeded');
    const admin = await fetch(`${appUrl}/api/admin/videos`);
    const adminData = await admin.json();
    assert.equal(adminData.total, 1);
    assert.equal(adminData.items[0].id, 'task_123');
    assert.equal(adminData.items[0].model, 'Doubao-Seedance-2.5');
    assert.equal(adminData.items[0].duration, 30);
    assert.equal(adminData.items[0].status, 'succeeded');
    assert.equal(typeof adminData.items[0].elapsedMs, 'number');
    assert.equal(adminData.items[0].downloadUrl, '/api/videos/task_123/content?download=1');
    const video = await fetch(`${appUrl}/api/videos/task_123/content?download=1`);
    assert.equal(video.headers.get('content-type'), 'video/mp4');
    assert.match(video.headers.get('content-disposition'), /attachment/);
    assert.equal(await video.text(), 'mock-video');
    const range = await fetch(`${appUrl}/api/videos/task_123/content`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 0-3/10');
    assert.equal(await range.text(), 'mock');
    assert.deepEqual(calls, ['POST /v1/videos', 'GET /v1/videos/task_123', 'GET /v1/videos/task_123/content', 'GET /v1/videos/task_123/content']);
  } finally {
    await close(app);
    await close(upstream);
  }
});

test('未配置密钥时返回清晰提示', async () => {
  const app = createTestApp({ apiKey: '' });
  const url = await listen(app);
  try {
    const config = await fetch(`${url}/api/config`);
    assert.deepEqual(await config.json(), { configured: false });
    const response = await fetch(`${url}/api/videos`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /VIDEO_API_KEY/);
  } finally {
    await close(app);
  }
});

test('拒绝超过 30 秒的视频', async () => {
  let called = false;
  const app = createTestApp({ apiKey: 'test-key', fetchImpl: async () => { called = true; } });
  const url = await listen(app);
  try {
    const response = await fetch(`${url}/api/videos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '测试', model: 'Doubao-Seedance-2.5', ratio: '16:9', duration: 31 }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /1–30/);
    assert.equal(called, false);
  } finally {
    await close(app);
  }
});

test('非 2.5 模型拒绝超过 15 秒的视频', async () => {
  let called = false;
  const app = createTestApp({ apiKey: 'test-key', fetchImpl: async () => { called = true; } });
  const url = await listen(app);
  try {
    const response = await fetch(`${url}/api/videos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '测试', model: 'Doubao-Seedance-2.0-fast', ratio: '16:9', duration: 20 }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /1–15/);
    assert.equal(called, false);
  } finally {
    await close(app);
  }
});
