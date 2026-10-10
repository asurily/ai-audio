import { createServer } from 'node:http';
import { readFile, existsSync } from 'node:fs';
import { mkdir, readFile as readFileAsync, rename, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.html', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
]);
const allowedRatios = new Set(['16:9', '9:16', '1:1', '4:3', '3:4']);
const terminalStatuses = new Set(['completed', 'succeeded', 'success', 'done', 'failed', 'error', 'canceled', 'cancelled']);

function taskData(data) {
  return data?.data && typeof data.data === 'object' ? data.data : data;
}

function taskId(data) {
  const value = taskData(data)?.task_id ?? taskData(data)?.id ?? data?.task_id ?? data?.id;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function taskStatus(data) {
  return String(taskData(data)?.status ?? data?.status ?? 'queued').toLowerCase();
}

function isTerminal(status) {
  return terminalStatuses.has(String(status).toLowerCase());
}

export function createMemoryTaskStore() {
  const records = new Map();
  return {
    async list() { return [...records.values()]; },
    async upsert(task) {
      const previous = records.get(task.id) || {};
      const next = { ...previous, ...task, ...(previous.completedAt ? { completedAt: previous.completedAt } : {}) };
      records.set(task.id, next);
      return next;
    },
  };
}

export function createFileTaskStore(filePath) {
  let pending = Promise.resolve();
  async function readRecords() {
    try {
      const data = JSON.parse(await readFileAsync(filePath, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  return {
    async list() {
      await pending;
      return readRecords();
    },
    async upsert(task) {
      pending = pending.then(async () => {
        const records = await readRecords();
        const index = records.findIndex((item) => item.id === task.id);
        const previous = index >= 0 ? records[index] : {};
        const next = { ...previous, ...task, ...(previous.completedAt ? { completedAt: previous.completedAt } : {}) };
        if (index >= 0) records[index] = next;
        else records.push(next);
        await mkdir(dirname(filePath), { recursive: true });
        const temporaryPath = `${filePath}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(records, null, 2), 'utf8');
        await rename(temporaryPath, filePath);
        return next;
      });
      return pending;
    },
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw Object.assign(new Error('请求内容过长'), { status: 413 });
  }
  try { return JSON.parse(body); }
  catch { throw Object.assign(new Error('请求格式不正确'), { status: 400 }); }
}

export function createAppServer({ apiKey = process.env.VIDEO_API_KEY, baseUrl = process.env.VIDEO_API_BASE_URL || 'https://openapi-ait.ke.com', fetchImpl = fetch, taskStore = createFileTaskStore(join(root, '.data', 'video-tasks.json')) } = {}) {
  const upstream = baseUrl.replace(/\/+$/, '');

  async function callApi(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${upstream}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
        signal: options.signal === false ? undefined : options.signal ?? AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw Object.assign(new Error(`连接生成服务失败：${error.message}`), { status: 502 });
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let detail = raw;
      try {
        const json = JSON.parse(raw);
        detail = json.error?.message || json.message || json.error || raw;
      } catch { /* Keep original response text. */ }
      throw Object.assign(new Error(typeof detail === 'string' ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500) || `生成服务返回 ${response.status}`), { status: response.status });
    }
    return response;
  }

  async function recordStatus(id, data, details = {}) {
    const status = taskStatus(data);
    const now = new Date().toISOString();
    return taskStore.upsert({
      id,
      ...details,
      status,
      updatedAt: now,
      ...(isTerminal(status) ? { completedAt: now } : {}),
    });
  }

  async function fetchAndRecordStatus(id) {
    const response = await callApi(`/v1/videos/${id}`);
    const data = await response.json();
    await recordStatus(id, data);
    return data;
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return sendJson(res, 200, { configured: Boolean(apiKey && apiKey !== '替换为你的APIKEY') });
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/videos') {
        let records = await taskStore.list();
        if (url.searchParams.get('refresh') === '1' && apiKey && apiKey !== '替换为你的APIKEY') {
          const active = records.filter((item) => !isTerminal(item.status));
          await Promise.allSettled(active.map((item) => fetchAndRecordStatus(item.id)));
          records = await taskStore.list();
        }
        const items = records
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .map((item) => ({
            ...item,
            elapsedMs: item.completedAt && item.createdAt
              ? Math.max(0, new Date(item.completedAt).getTime() - new Date(item.createdAt).getTime())
              : null,
            downloadUrl: ['completed', 'succeeded', 'success', 'done'].includes(String(item.status).toLowerCase())
              ? `/api/videos/${encodeURIComponent(item.id)}/content?download=1`
              : null,
          }));
        return sendJson(res, 200, { items, total: items.length });
      }

      if (url.pathname.startsWith('/api/videos')) {
        if (!apiKey || apiKey === '替换为你的APIKEY') {
          return sendJson(res, 503, { error: '尚未配置 VIDEO_API_KEY，请在 .env 中填写后重启服务。' });
        }

        if (req.method === 'POST' && url.pathname === '/api/videos') {
          const body = await readJson(req);
          const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
          const model = typeof body.model === 'string' ? body.model.trim() : '';
          if (!prompt || prompt.length > 5000) return sendJson(res, 400, { error: '请输入 1–5000 字的画面描述。' });
          if (!model || model.length > 120) return sendJson(res, 400, { error: '请输入有效的模型 ID。' });
          if (!allowedRatios.has(body.ratio)) return sendJson(res, 400, { error: '不支持所选画面比例。' });
          const duration = Number(body.duration);
          const maxDuration = model === 'Doubao-Seedance-2.5' ? 30 : 15;
          if (!Number.isInteger(duration) || duration < 1 || duration > maxDuration) return sendJson(res, 400, { error: `${model} 的视频时长必须是 1–${maxDuration} 秒的整数。` });
          if (body.generateAudio != null && typeof body.generateAudio !== 'boolean') return sendJson(res, 400, { error: '音频选项格式不正确。' });
          const generateAudio = body.generateAudio !== false;
          if (body.subtitleText != null && typeof body.subtitleText !== 'string') return sendJson(res, 400, { error: '字幕内容格式不正确。' });
          const subtitleText = typeof body.subtitleText === 'string' ? body.subtitleText.trim() : '';
          if (subtitleText.length > 1000) return sendJson(res, 400, { error: '字幕内容不能超过 1000 字。' });
          const subtitleInstruction = body.subtitleEnabled
            ? subtitleText
              ? `\n\n字幕要求：在画面下方生成清晰、易读的中文字幕，准确显示以下文字，不要改写：${subtitleText}`
              : generateAudio
                ? '\n\n字幕要求：根据视频中的旁白自动生成同步的简体中文字幕，字幕位于画面下方，清晰易读。'
                : '\n\n字幕要求：根据画面内容生成简洁的简体中文字幕，字幕位于画面下方，清晰易读。'
            : '';
          const payload = {
            model,
            content: [{ type: 'text', text: `${prompt}${subtitleInstruction}` }],
            ratio: body.ratio,
            duration,
            generate_audio: generateAudio,
            watermark: false,
          };
          const response = await callApi('/v1/videos', { method: 'POST', body: JSON.stringify(payload) });
          const data = await response.json();
          const id = taskId(data);
          if (id) {
            const now = new Date().toISOString();
            await recordStatus(id, data, {
              model,
              duration,
              ratio: body.ratio,
              generateAudio,
              createdAt: now,
            });
          }
          return sendJson(res, 200, data);
        }

        const match = url.pathname.match(/^\/api\/videos\/([A-Za-z0-9_-]+)(\/content)?$/);
        if (match && req.method === 'GET') {
          const [, id, content] = match;
          if (!content) {
            return sendJson(res, 200, await fetchAndRecordStatus(id));
          }
          const response = await callApi(`/v1/videos/${id}/content`, {
            signal: false,
            headers: req.headers.range ? { Range: req.headers.range } : {},
          });
          res.writeHead(response.status, {
            'Content-Type': response.headers.get('content-type') || 'video/mp4',
            'Content-Disposition': url.searchParams.has('download') ? `attachment; filename="video-${id}.mp4"` : 'inline',
            'Cache-Control': 'private, max-age=3600',
            ...(response.headers.get('content-length') ? { 'Content-Length': response.headers.get('content-length') } : {}),
            ...(response.headers.get('content-range') ? { 'Content-Range': response.headers.get('content-range') } : {}),
            ...(response.headers.get('accept-ranges') ? { 'Accept-Ranges': response.headers.get('accept-ranges') } : {}),
          });
          if (response.body) Readable.fromWeb(response.body).pipe(res);
          else res.end();
          return;
        }
        return sendJson(res, 404, { error: '接口不存在。' });
      }

      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [filename, type] = assets.get(url.pathname);
        readFile(join(root, filename), (error, content) => {
          if (error) return sendJson(res, 500, { error: '页面加载失败。' });
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
          res.end(content);
        });
        return;
      }
      sendJson(res, 404, { error: '页面不存在。' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message || '服务暂时不可用。' });
      else res.destroy(error);
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 3000);
  createAppServer().listen(port, () => console.log(`AI 视频工作台已启动：http://localhost:${port}`));
}
