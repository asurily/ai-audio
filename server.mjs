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
const allowedResolutions = new Set(['2K', '480P', '768P']);
const modelResolutions = {
  'Doubao-Seedance-2.5': new Set(['480p', '720p', '1080p']),
  'MiniMax-H3': new Set(['2K']),
  'MiniMax-H3-Max': new Set(['480P', '768P']),
};
const modelMinDuration = {
  'Doubao-Seedance-2.5': 4,
  'Doubao-Seedance-2.0': 4,
  'Doubao-Seedance-2.0-fast': 4,
  'Doubao-Seedance-2.0-mini': 4,
  'MiniMax-H3': 4,
  'MiniMax-H3-Max': 5,
};
const assetRoles = new Set(['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio']);
const assetContentTypes = {
  first_frame: 'image_url',
  last_frame: 'image_url',
  reference_image: 'image_url',
  reference_video: 'video_url',
  reference_audio: 'audio_url',
};
const dataUrlPatterns = {
  image_url: /^data:image\/(jpe?g|png|webp|heic|heif);base64,[a-z0-9+/=]+$/i,
  video_url: /^data:video\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i,
  audio_url: /^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i,
};
const maxBodyLength = 160_000_000;
const referenceLimitsByModel = {
  'MiniMax-H3': { reference_image: 5, reference_video: 1, reference_audio: 1 },
  'Doubao-Seedance-2.5': { reference_image: 30, reference_video: 10, reference_audio: 10 },
};
const defaultReferenceLimits = { reference_image: 5, reference_video: 1, reference_audio: 1 };

function supportsReferences(model) {
  if (model === 'MiniMax-H3-Max') return false;
  if (model === 'MiniMax-H3' || model === 'Doubao-Seedance-2.5') return true;
  return model.startsWith('MiniMax');
}

function validAssetUrl(url, contentType) {
  if (typeof url !== 'string' || !url || url.length > maxBodyLength) return false;
  if (url.startsWith('https://')) return true;
  return dataUrlPatterns[contentType].test(url);
}

function normalizeAssets(raw, model) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw Object.assign(new Error('素材列表格式不正确。'), { status: 400 });
  const assets = [];
  for (const item of raw) {
    const role = typeof item?.role === 'string' ? item.role.trim() : '';
    if (!assetRoles.has(role)) throw Object.assign(new Error(`不支持的角色 ${role || '(空)'}，可用值：${[...assetRoles].join('、')}。`), { status: 400 });
    const contentType = assetContentTypes[role];
    if (!validAssetUrl(item?.url, contentType)) throw Object.assign(new Error('素材地址必须是 https 链接或合法的 base64 数据。'), { status: 400 });
    assets.push({ role, url: item.url });
  }
  const counts = assets.reduce((acc, asset) => ({ ...acc, [asset.role]: (acc[asset.role] || 0) + 1 }), {});
  if (counts.first_frame > 1 || counts.last_frame > 1) throw Object.assign(new Error('首帧与尾帧图片各最多上传 1 张。'), { status: 400 });
  const limits = referenceLimitsByModel[model] || defaultReferenceLimits;
  for (const [role, max] of Object.entries(limits)) {
    if (counts[role] > max) {
      const noun = role === 'reference_image' ? '参考图片' : role === 'reference_video' ? '参考视频' : '参考音频';
      const unit = role === 'reference_image' ? '张' : '个';
      throw Object.assign(new Error(`${model} 的${noun}最多上传 ${max} ${unit}。`), { status: 400 });
    }
  }
  return assets;
}
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

function taskError(data) {
  const detail = taskData(data)?.error ?? data?.error;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object') return detail.message || detail.code || '';
  return '';
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
    if (body.length > maxBodyLength) throw Object.assign(new Error('请求内容过大，请减小素材体积。'), { status: 413 });
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
    const error = taskError(data);
    const now = new Date().toISOString();
    return taskStore.upsert({
      id,
      ...details,
      status,
      ...(error ? { error } : {}),
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
          const assets = normalizeAssets(body.assets, model);
          const hasFrames = assets.some((asset) => asset.role === 'first_frame' || asset.role === 'last_frame');
          const references = assets.filter((asset) => asset.role.startsWith('reference_'));
          if (references.length) {
            if (!supportsReferences(model)) return sendJson(res, 400, { error: `${model} 不支持多模态参考素材（参考图片 / 视频 / 音频）。` });
            if (hasFrames) return sendJson(res, 400, { error: '首尾帧图生视频与多模态参考生视频不能混用，请只保留其中一类素材。' });
            if (model.startsWith('MiniMax') && references.every((asset) => asset.role === 'reference_audio')) return sendJson(res, 400, { error: '多模态参考不能只输入音频，至少需要一张参考图片或一个参考视频。' });
          }
          if (hasFrames && model.startsWith('MiniMax')) {
            if (body.ratio !== 'adaptive') return sendJson(res, 400, { error: '上传首帧 / 尾帧图片时，画面比例必须使用 adaptive（跟随图片）。' });
          } else if (!allowedRatios.has(body.ratio)) {
            return sendJson(res, 400, { error: '不支持所选画面比例。' });
          }
          const resolution = typeof body.resolution === 'string' ? body.resolution.trim() : '';
          const acceptedResolutions = modelResolutions[model] || allowedResolutions;
          if (resolution && !acceptedResolutions.has(resolution)) return sendJson(res, 400, { error: `${model} 不支持分辨率 ${resolution}，可用值：${[...acceptedResolutions].join('、')}。` });
          const duration = Number(body.duration);
          const maxDuration = model === 'Doubao-Seedance-2.5' ? 30 : 15;
          const minDuration = modelMinDuration[model] || 1;
          if (!Number.isInteger(duration) || duration < minDuration || duration > maxDuration) return sendJson(res, 400, { error: `${model} 的视频时长必须是 ${minDuration}–${maxDuration} 秒的整数。` });
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
            content: [
              { type: 'text', text: `${prompt}${subtitleInstruction}` },
              ...assets.map((asset) => {
                const contentType = assetContentTypes[asset.role];
                return { type: contentType, [contentType]: { url: asset.url }, role: asset.role };
              }),
            ],
            ratio: body.ratio,
            duration,
            generate_audio: generateAudio,
            ...(resolution ? { resolution } : {}),
            ...(model.startsWith('MiniMax') ? { aigc_watermark: false } : { watermark: false }),
          };
          const response = await callApi('/v1/videos', { method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(180_000) });
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
  const port = Number(process.env.PORT || 3002);
  createAppServer().listen(port, () => console.log(`AI 视频工作台已启动：http://localhost:${port}`));
}
