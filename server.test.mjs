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
    assert.match((await response.json()).error, /4–30/);
    assert.equal(called, false);
  } finally {
    await close(app);
  }
});

test('Seedance 2.5 接受 20 秒并保留上游失败原因', async () => {
  let submitted;
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      submitted = JSON.parse(body);
      return res.end(JSON.stringify({ id: 'task_20s', status: 'queued' }));
    }
    res.end(JSON.stringify({ id: 'task_20s', status: 'failed', error: { code: 'UPSTREAM_FAILED', message: '生成服务处理失败' } }));
  });
  const upstreamUrl = await listen(upstream);
  const app = createTestApp({ apiKey: 'test-key', baseUrl: upstreamUrl });
  const url = await listen(app);
  try {
    const response = await fetch(`${url}/api/videos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '测试 20 秒视频', model: 'Doubao-Seedance-2.5', ratio: '16:9', duration: 20 }),
    });
    assert.equal(response.status, 200);
    assert.equal(submitted.duration, 20);
    assert.equal(submitted.model, 'Doubao-Seedance-2.5');
    assert.equal(submitted.ratio, '16:9');
    assert.equal(submitted.generate_audio, true);
    assert.equal(submitted.watermark, false);
    const status = await fetch(`${url}/api/videos/task_20s`);
    assert.equal((await status.json()).status, 'failed');
    const admin = await fetch(`${url}/api/admin/videos`);
    assert.equal((await admin.json()).items[0].error, '生成服务处理失败');
  } finally {
    await close(app);
    await close(upstream);
  }
});

test('Seedance 2.5 拒绝不足 4 秒的请求', async () => {
  let called = false;
  const app = createTestApp({ apiKey: 'test-key', fetchImpl: async () => { called = true; } });
  const url = await listen(app);
  try {
    const response = await fetch(`${url}/api/videos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '测试', model: 'Doubao-Seedance-2.5', ratio: '16:9', duration: 3 }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /4–30/);
    assert.equal(called, false);
  } finally {
    await close(app);
  }
});

test('Seedance 2.5 支持三档分辨率并拒绝其他档位', async () => {
  const submitted = [];
  const app = createTestApp({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      submitted.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ id: `task_resolution_${submitted.length}`, status: 'queued' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const url = await listen(app);
  try {
    for (const resolution of ['480p', '720p', '1080p']) {
      const response = await fetch(`${url}/api/videos`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '测试', model: 'Doubao-Seedance-2.5', ratio: '16:9', duration: 5, resolution }),
      });
      assert.equal(response.status, 200);
      assert.equal(submitted.at(-1).resolution, resolution);
    }
    const invalid = await fetch(`${url}/api/videos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '测试', model: 'Doubao-Seedance-2.5', ratio: '16:9', duration: 5, resolution: '2K' }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /480p、720p、1080p/);
    assert.equal(submitted.length, 3);
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
    assert.match((await response.json()).error, /4–15/);
    assert.equal(called, false);
  } finally {
    await close(app);
  }
});

test('上传首帧时组装多模态 content 并要求 adaptive 比例', async () => {
  let upstreamBody;
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    upstreamBody = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'task_i2v', status: 'queued' }));
  });
  const upstreamUrl = await listen(upstream);
  const app = createTestApp({ apiKey: 'test-key', baseUrl: upstreamUrl });
  const appUrl = await listen(app);
  try {
    const ok = await fetch(`${appUrl}/api/videos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '让画面动起来', model: 'MiniMax-H3', ratio: 'adaptive', duration: 5, resolution: '2K',
        assets: [{ role: 'first_frame', url: 'data:image/png;base64,aGVsbG8=' }],
      }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(upstreamBody.content, [
      { type: 'text', text: '让画面动起来' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' }, role: 'first_frame' },
    ]);
    assert.equal(upstreamBody.ratio, 'adaptive');
    assert.equal(upstreamBody.resolution, '2K');
    assert.equal(upstreamBody.aigc_watermark, false);
    const noAdaptive = await fetch(`${appUrl}/api/videos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '测试', model: 'Doubao-Seedance-2.0', ratio: 'adaptive', duration: 5 }),
    });
    assert.equal(noAdaptive.status, 400);
    assert.match((await noAdaptive.json()).error, /画面比例/);
  } finally {
    await close(app);
    await close(upstream);
  }
});

test('Doubao-Seedance-2.5 参考素材：组装 content、显式比例、数量上限', async () => {
  let upstreamBody;
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    upstreamBody = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'task_sd25', status: 'queued' }));
  });
  const upstreamUrl = await listen(upstream);
  const app = createTestApp({ apiKey: 'test-key', baseUrl: upstreamUrl });
  const appUrl = await listen(app);
  const png = 'data:image/png;base64,aGVsbG8=';
  try {
    const ok = await fetch(`${appUrl}/api/videos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '参考图片生成品牌短片', model: 'Doubao-Seedance-2.5', ratio: '16:9', duration: 15,
        assets: [{ role: 'reference_image', url: png }, { role: 'reference_audio', url: 'data:audio/mpeg;base64,aGVsbG8=' }],
      }),
    });
    assert.equal(ok.status, 200);
    assert.equal(upstreamBody.content.length, 3);
    assert.deepEqual(upstreamBody.content[1], { type: 'image_url', image_url: { url: png }, role: 'reference_image' });
    assert.equal(upstreamBody.ratio, '16:9');
    assert.equal(upstreamBody.watermark, false);
    assert.equal(upstreamBody.aigc_watermark, undefined);
    const tooMany = await fetch(`${appUrl}/api/videos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '测试', model: 'Doubao-Seedance-2.5', ratio: '16:9', duration: 5,
        assets: Array.from({ length: 31 }, () => ({ role: 'reference_image', url: png })),
      }),
    });
    assert.equal(tooMany.status, 400);
    assert.match((await tooMany.json()).error, /最多上传 30 张/);
    const frames = await fetch(`${appUrl}/api/videos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '测试', model: 'Doubao-Seedance-2.5', ratio: '16:9', duration: 5,
        assets: [{ role: 'first_frame', url: png }],
      }),
    });
    assert.equal(frames.status, 200);
    assert.equal(upstreamBody.content[1].role, 'first_frame');
    assert.equal(upstreamBody.ratio, '16:9');
  } finally {
    await close(app);
    await close(upstream);
  }
});

test('素材规则校验：混用、仅音频、H3-Max 参考均拒绝', async () => {
  const app = createTestApp({ apiKey: 'test-key', fetchImpl: async () => { throw new Error('不应调用上游'); } });
  const url = await listen(app);
  const post = (payload) => fetch(`${url}/api/videos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const png = 'data:image/png;base64,aGVsbG8=';
  const mp3 = 'data:audio/mpeg;base64,aGVsbG8=';
  try {
    const mixed = await post({ prompt: 't', model: 'MiniMax-H3', ratio: '16:9', duration: 5, assets: [{ role: 'first_frame', url: png }, { role: 'reference_image', url: png }] });
    assert.equal(mixed.status, 400);
    assert.match((await mixed.json()).error, /混用/);
    const audioOnly = await post({ prompt: 't', model: 'MiniMax-H3', ratio: '16:9', duration: 5, assets: [{ role: 'reference_audio', url: mp3 }] });
    assert.equal(audioOnly.status, 400);
    assert.match((await audioOnly.json()).error, /音频/);
    const maxRef = await post({ prompt: 't', model: 'MiniMax-H3-Max', ratio: '16:9', duration: 5, assets: [{ role: 'reference_image', url: png }] });
    assert.equal(maxRef.status, 400);
    assert.match((await maxRef.json()).error, /多模态参考/);
    const badRole = await post({ prompt: 't', model: 'MiniMax-H3', ratio: '16:9', duration: 5, assets: [{ role: 'middle_frame', url: png }] });
    assert.equal(badRole.status, 400);
    assert.match((await badRole.json()).error, /middle_frame/);
  } finally {
    await close(app);
  }
});
