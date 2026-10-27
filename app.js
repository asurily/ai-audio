const $ = (id) => document.getElementById(id);
const form = $('createForm');
const promptInput = $('prompt');
const modelSelect = $('model');
const customModel = $('customModel');
const resolutionSelect = $('resolution');
const resolutionField = $('resolutionField');
const indicator = $('previewIndicator');
const meta = $('resultMeta');
const message = $('message');
const player = $('videoPlayer');
let currentTaskId = null;
let currentDuration = 10;
let currentGenerateAudio = true;
let pollTimer = null;
let polling = false;
let editingTemplateName = null;
let templates = loadTemplates();

const examples = [
  '一支高质感城市生活方式广告片：清晨阳光穿过落地窗，年轻人端起咖啡走向阳台，远处城市天际线逐渐亮起。镜头缓慢推进，电影感光线，温暖而安静。',
  '雨后的东京街头，霓虹灯在湿润的路面上倒映。一个撑透明雨伞的人从画面前方走过，镜头平稳跟拍，蓝紫色电影氛围。',
  '一只橘猫坐在洒满阳光的窗台上，微风轻轻吹动白色窗帘。镜头从远处缓慢推近，柔和暖色调，细腻真实的毛发质感。',
];
let exampleIndex = 0;

function loadTemplates() {
  try {
    const value = JSON.parse(localStorage.getItem('subjectTemplates') || '[]');
    return Array.isArray(value) ? value.filter((item) => item && typeof item.name === 'string' && typeof item.description === 'string') : [];
  } catch { return []; }
}

function persistTemplates() {
  localStorage.setItem('subjectTemplates', JSON.stringify(templates));
}

function insertTemplateMention(name, replaceStart = null) {
  const cursor = promptInput.selectionStart;
  const before = promptInput.value.slice(0, replaceStart ?? cursor);
  const after = promptInput.value.slice(cursor);
  const spacer = before && !/\s$/.test(before) ? ' ' : '';
  promptInput.value = `${before}${spacer}@${name} ${after}`;
  const nextCursor = before.length + spacer.length + name.length + 2;
  promptInput.setSelectionRange(nextCursor, nextCursor);
  promptInput.dispatchEvent(new Event('input'));
  promptInput.focus();
  $('mentionMenu').classList.add('hidden');
}

function renderTemplates() {
  const list = $('templateList');
  list.replaceChildren();
  if (!templates.length) {
    const empty = document.createElement('span');
    empty.className = 'template-empty';
    empty.textContent = '还没有保存模板';
    list.append(empty);
    return;
  }
  templates.forEach((template) => {
    const entry = document.createElement('span');
    entry.className = 'template-entry';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'template-chip';
    chip.title = `引用 @${template.name}`;
    chip.innerHTML = '<b></b><i></i><span>引用</span>';
    chip.querySelector('b').textContent = `@${template.name}`;
    chip.addEventListener('click', () => insertTemplateMention(template.name));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'template-edit';
    edit.textContent = '⋯';
    edit.title = `编辑 ${template.name}`;
    edit.addEventListener('click', () => openTemplateEditor(template));
    entry.append(chip, edit);
    list.append(entry);
  });
}

function openTemplateEditor(template = null) {
  editingTemplateName = template?.name ?? null;
  $('templateEditorTitle').textContent = template ? '编辑主体模板' : '新建主体模板';
  $('templateName').value = template?.name ?? '';
  $('templateDescription').value = template?.description ?? '';
  $('deleteTemplateButton').classList.toggle('hidden', !template);
  $('templateError').classList.add('hidden');
  $('templateEditor').classList.remove('hidden');
  $('templateName').focus();
}

function closeTemplateEditor() {
  editingTemplateName = null;
  $('templateEditor').classList.add('hidden');
  $('templateError').classList.add('hidden');
}

function showTemplateError(text) {
  $('templateError').textContent = text;
  $('templateError').classList.remove('hidden');
}

function resolveTemplateMentions(text) {
  let resolved = text;
  [...templates].sort((a, b) => b.name.length - a.name.length).forEach((template) => {
    const escaped = template.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`@${escaped}(?![\\p{L}\\p{N}_-])`, 'gu');
    const instruction = `[固定主体模板 @${template.name}：在所有镜头中保持该主体的身份、脸部特征、发型、服装和配色一致。${template.description}]`;
    resolved = resolved.replace(pattern, instruction);
  });
  return resolved;
}

function updateMentionMenu() {
  const cursor = promptInput.selectionStart;
  const before = promptInput.value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([\p{L}\p{N}_-]*)$/u);
  const menu = $('mentionMenu');
  if (!match || !templates.length) return menu.classList.add('hidden');
  const query = match[1].toLowerCase();
  const matches = templates.filter((template) => template.name.toLowerCase().includes(query));
  if (!matches.length) return menu.classList.add('hidden');
  const start = cursor - match[1].length - 1;
  menu.replaceChildren();
  matches.forEach((template) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mention-item';
    button.innerHTML = '<b></b><span></span>';
    button.querySelector('b').textContent = `@${template.name}`;
    button.querySelector('span').textContent = template.description;
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      insertTemplateMention(template.name, start);
    });
    menu.append(button);
  });
  menu.classList.remove('hidden');
}

function showMessage(text) {
  message.textContent = text;
  message.classList.toggle('hidden', !text);
}

function setView(state, detail = '') {
  $('previewEmpty').classList.toggle('hidden', state !== 'empty');
  $('previewProgress').classList.toggle('hidden', state !== 'busy');
  player.classList.toggle('hidden', state !== 'done');
  $('downloadButton').classList.toggle('hidden', state !== 'done');
  $('retryButton').classList.toggle('hidden', state !== 'error');
  indicator.className = 'preview-indicator' + (state === 'busy' ? ' busy' : state === 'done' ? ' done' : state === 'error' ? ' failed' : '');
  indicator.textContent = state === 'busy' ? '生成中' : state === 'done' ? '已完成' : state === 'error' ? '生成失败' : '等待生成';
  meta.innerHTML = `<span><span class="meta-dot"></span>${state === 'busy' ? '正在生成你的作品' : state === 'done' ? '视频已准备就绪' : state === 'error' ? '请查看错误信息' : '等待你的第一段作品'}</span><span>${currentDuration}s · ${currentGenerateAudio ? '有声' : '静音'} · HD</span>`;
  if (state === 'busy') {
    $('progressTitle').textContent = detail || '正在准备画面';
    $('progressSubtitle').textContent = '灵感正在变成影像，请稍候…';
  }
  if (state !== 'error') showMessage('');
  if (state === 'error') showMessage(detail || '生成未完成，请稍后重试。');
  $('generateButton').disabled = state === 'busy';
  $('generateLabel').textContent = state === 'busy' ? '正在生成…' : '立即生成视频';
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function taskData(data) {
  return data?.data && typeof data.data === 'object' ? data.data : data;
}

function taskId(data) {
  const value = taskData(data)?.task_id ?? taskData(data)?.id ?? data?.task_id ?? data?.id;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function taskStatus(data) {
  return String(taskData(data)?.status ?? data?.status ?? '').toLowerCase();
}

function errorText(data) {
  const value = taskData(data)?.error ?? data?.error;
  const detail = (typeof value === 'string' ? value : value?.message || value?.code) || taskData(data)?.message;
  const id = taskId(data) || currentTaskId;
  return detail
    ? `视频生成失败：${detail}${id ? `（任务 ID：${id}）` : ''}`
    : `生成服务未提供失败原因${id ? `（任务 ID：${id}）` : ''}。请保留任务 ID，以便查询服务端日志或联系服务提供方。`;
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(delay = 60_000) {
  stopPolling();
  pollTimer = setTimeout(pollTask, delay);
}

async function pollTask() {
  if (!currentTaskId || polling) return;
  polling = true;
  try {
    const data = await api(`/api/videos/${encodeURIComponent(currentTaskId)}`);
    const status = taskStatus(data);
    if (['completed', 'succeeded', 'success', 'done'].includes(status)) {
      stopPolling();
      sessionStorage.removeItem('videoTaskId');
      sessionStorage.removeItem('videoTask');
      const src = `/api/videos/${encodeURIComponent(currentTaskId)}/content`;
      player.src = src;
      $('downloadButton').href = `${src}?download=1`;
      $('downloadButton').download = `video-${currentTaskId}.mp4`;
      setView('done');
    } else if (['failed', 'error', 'canceled', 'cancelled'].includes(status)) {
      stopPolling();
      sessionStorage.removeItem('videoTaskId');
      sessionStorage.removeItem('videoTask');
      setView('error', errorText(data));
    } else {
      const label = status === 'queued' || status === 'pending' ? '任务已排队，等待开始' : 'AI 正在生成画面';
      setView('busy', label);
      schedulePoll();
    }
  } catch (error) {
    stopPolling();
    setView('error', `查询任务状态失败：${error.message}`);
  } finally {
    polling = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = resolveTemplateMentions(promptInput.value.trim());
  const model = modelSelect.value === 'custom' ? customModel.value.trim() : modelSelect.value;
  const ratio = hasFrameAssets() ? 'adaptive' : form.elements.ratio.value;
  const duration = Number(form.elements.duration.value);
  const generateAudio = form.elements.generateAudio.checked;
  const subtitleEnabled = form.elements.subtitleEnabled.checked;
  const subtitleText = $('subtitleText').value.trim();
  const assets = [...assetFiles.entries()].flatMap(([role, list]) => list.map(({ dataUrl }) => ({ role, url: dataUrl })));
  if (!prompt) return showMessage('请先描述你想生成的画面。');
  if (!model) return showMessage('请填写模型 ID。');
  if (assets.some((asset) => asset.role.startsWith('reference_')) && hasFrameAssets()) return showMessage('首尾帧图生视频与多模态参考生视频不能混用，请移除其中一类素材。');
  stopPolling();
  player.removeAttribute('src');
  player.load();
  currentTaskId = null;
  currentDuration = duration;
  currentGenerateAudio = generateAudio;
  setView('busy', '正在提交生成任务');
  try {
    const data = await api('/api/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model, ratio, duration, generateAudio, subtitleEnabled, subtitleText, ...(assets.length ? { assets } : {}), ...(resolutionField.classList.contains('hidden') ? {} : { resolution: resolutionSelect.value }) }),
    });
    const id = taskId(data);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('生成服务未返回有效的任务 ID。');
    currentTaskId = id;
    sessionStorage.setItem('videoTask', JSON.stringify({ id, duration, generateAudio }));
    schedulePoll(1000);
  } catch (error) {
    setView('error', `提交失败：${error.message}`);
  }
});

promptInput.addEventListener('input', () => {
  $('charCount').textContent = promptInput.value.length;
  updateMentionMenu();
});
promptInput.addEventListener('click', updateMentionMenu);
promptInput.addEventListener('blur', () => setTimeout(() => $('mentionMenu').classList.add('hidden'), 120));
$('newTemplateButton').addEventListener('click', () => openTemplateEditor());
$('closeTemplateButton').addEventListener('click', closeTemplateEditor);
$('cancelTemplateButton').addEventListener('click', closeTemplateEditor);
$('saveTemplateButton').addEventListener('click', () => {
  const name = $('templateName').value.trim();
  const description = $('templateDescription').value.trim();
  if (!/^[\p{L}\p{N}_-]{1,20}$/u.test(name)) return showTemplateError('模板名称只能包含中文、字母、数字、下划线或短横线。');
  if (!description) return showTemplateError('请填写固定形象描述。');
  const duplicate = templates.some((item) => item.name === name && item.name !== editingTemplateName);
  if (duplicate) return showTemplateError(`@${name} 已经存在。`);
  const previousName = editingTemplateName;
  if (previousName) {
    templates = templates.map((item) => item.name === previousName ? { name, description } : item);
    if (previousName !== name) promptInput.value = promptInput.value.replaceAll(`@${previousName}`, `@${name}`);
  } else {
    templates.push({ name, description });
  }
  try { persistTemplates(); }
  catch { return showTemplateError('模板保存失败，请检查浏览器存储设置。'); }
  renderTemplates();
  promptInput.dispatchEvent(new Event('input'));
  closeTemplateEditor();
});
$('deleteTemplateButton').addEventListener('click', () => {
  if (!editingTemplateName) return;
  templates = templates.filter((item) => item.name !== editingTemplateName);
  try { persistTemplates(); }
  catch { return showTemplateError('模板删除失败，请检查浏览器存储设置。'); }
  renderTemplates();
  closeTemplateEditor();
});
function updateDuration() {
  const value = Number($('duration').value);
  const min = Number($('duration').min);
  const max = Number($('duration').max);
  $('durationOutput').textContent = `${value} 秒`;
  $('duration').style.setProperty('--range-progress', `${((value - min) / (max - min)) * 100}%`);
  $('durationIncrease').disabled = value >= max;
  $('durationDecrease').disabled = value <= min;
}
function updateDurationLimit() {
  const max = modelSelect.value === 'Doubao-Seedance-2.5' ? 30 : 15;
  $('duration').max = String(max);
  if (Number($('duration').value) > max) $('duration').value = String(max);
  $('maxDurationLabel').textContent = `最长 ${max} 秒`;
  $('durationMarks').replaceChildren(...Array.from({ length: (max - 5) / 5 + 1 }, (_, index) => {
    const mark = document.createElement('span');
    mark.textContent = `${5 + index * 5}s`;
    return mark;
  }));
  updateDuration();
}
$('duration').addEventListener('input', updateDuration);
for (const [id, delta] of [['durationIncrease', 1], ['durationDecrease', -1]]) {
  $(id).addEventListener('click', () => {
    const duration = $('duration');
    duration.value = String(Math.max(Number(duration.min), Math.min(Number(duration.max), Number(duration.value) + delta)));
    duration.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
$('subtitleEnabled').addEventListener('change', () => {
  $('subtitleInputWrap').classList.toggle('hidden', !$('subtitleEnabled').checked);
  if ($('subtitleEnabled').checked) $('subtitleText').focus();
});
$('subtitleText').addEventListener('input', () => { $('subtitleCount').textContent = $('subtitleText').value.length; });
const resolutionPresets = {
  'Doubao-Seedance-2.5': [['720p', '720p'], ['480p', '480p'], ['1080p', '1080p']],
  'MiniMax-H3': [['2K', '2K']],
  'MiniMax-H3-Max': [['768P', '768P（推荐）'], ['480P', '480P']],
};
const assetCapabilities = {
  'MiniMax-H3': { frames: true, references: true },
  'MiniMax-H3-Max': { frames: true, references: false },
  'Doubao-Seedance-2.5': { frames: false, references: true },
};
const referenceLimitPresets = {
  'MiniMax-H3': { reference_image: 5, reference_video: 1, reference_audio: 1 },
  'Doubao-Seedance-2.5': { reference_image: 30, reference_video: 10, reference_audio: 10 },
};
const defaultReferenceLimits = { reference_image: 5, reference_video: 1, reference_audio: 1 };
const assetSlotDefs = [
  { role: 'first_frame', kind: 'image', label: '首帧图片', multiple: false },
  { role: 'last_frame', kind: 'image', label: '尾帧图片', multiple: false },
  { role: 'reference_image', kind: 'image', label: '参考图片', multiple: true },
  { role: 'reference_video', kind: 'video', label: '参考视频', multiple: true },
  { role: 'reference_audio', kind: 'audio', label: '参考音频', multiple: true },
];
const assetFiles = new Map();
let assetCapabilityKey = '';
function updateResolutionField(model) {
  const supportsResolution = model === 'Doubao-Seedance-2.5' || model.startsWith('MiniMax');
  resolutionField.classList.toggle('hidden', !supportsResolution);
  if (!supportsResolution) return;
  const options = resolutionPresets[model] || [['2K', '2K'], ['768P', '768P'], ['480P', '480P']];
  resolutionSelect.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
}
function modelAssetCapability(model) {
  if (assetCapabilities[model]) return assetCapabilities[model];
  if (model.startsWith('MiniMax') && model !== 'MiniMax-H3-Max') return { frames: true, references: true };
  return null;
}
function modelReferenceLimits(model) {
  return referenceLimitPresets[model] || defaultReferenceLimits;
}
function validateAssetFile(def, file) {
  const limits = { image: 30 * 1024 * 1024, video: 100 * 1024 * 1024, audio: 30 * 1024 * 1024 };
  if (file.size > limits[def.kind]) return `${def.label}不能超过 ${def.kind === 'video' ? 100 : 30}MB。`;
  if (def.kind === 'image' && !/^image\/(jpe?g|png|webp|heic|heif)$/i.test(file.type)) return '图片仅支持 JPG、JPEG、PNG、WEBP、HEIC、HEIF 格式。';
  if (def.kind === 'video' && !file.type.startsWith('video/')) return '请选择视频文件。';
  if (def.kind === 'audio' && !file.type.startsWith('audio/')) return '请选择音频文件。';
  return '';
}
function readAssetFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}
function hasFrameAssets() {
  return ((assetFiles.get('first_frame')?.length || 0) + (assetFiles.get('last_frame')?.length || 0)) > 0;
}
function updateRatioLock() {
  const locked = hasFrameAssets();
  $('ratioNote').classList.toggle('hidden', !locked);
  form.querySelectorAll('input[name="ratio"]').forEach((input) => { input.disabled = locked; });
}
function renderAssetFiles(def, slot) {
  const container = slot.querySelector('.asset-files');
  container.replaceChildren();
  (assetFiles.get(def.role) || []).forEach((item, index) => {
    const chip = document.createElement('span');
    chip.className = 'asset-file';
    if (def.kind === 'image') {
      const img = document.createElement('img');
      img.src = item.dataUrl;
      img.alt = item.name;
      chip.append(img, Object.assign(document.createElement('i'), { textContent: item.name }));
    } else {
      chip.append(Object.assign(document.createElement('i'), { textContent: item.name }));
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = '移除';
    remove.setAttribute('aria-label', `移除 ${item.name}`);
    remove.addEventListener('click', () => {
      (assetFiles.get(def.role) || []).splice(index, 1);
      renderAssetFiles(def, slot);
      updateRatioLock();
    });
    chip.append(remove);
    container.append(chip);
  });
}
function createAssetSlot(def, limits = defaultReferenceLimits) {
  const max = def.multiple ? limits[def.role] : 1;
  const slot = document.createElement('div');
  slot.className = 'asset-slot';
  const head = document.createElement('div');
  head.className = 'asset-slot-head';
  const unit = def.kind === 'image' ? '张' : '个';
  head.append(Object.assign(document.createElement('strong'), { textContent: def.multiple ? `${def.label}（最多 ${max} ${unit}）` : def.label }));
  const picker = document.createElement('label');
  picker.className = 'asset-pick';
  picker.textContent = `＋ 选择${def.kind === 'image' ? '图片' : def.kind === 'video' ? '视频' : '音频'}`;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = def.kind === 'image' ? '.jpg,.jpeg,.png,.webp,.heic,.heif,image/*' : `${def.kind}/*`;
  if (def.multiple) input.multiple = true;
  input.hidden = true;
  picker.append(input);
  const files = document.createElement('div');
  files.className = 'asset-files';
  input.addEventListener('change', async () => {
    const picked = [...input.files];
    input.value = '';
    const list = assetFiles.get(def.role) || [];
    for (const file of picked) {
      const error = validateAssetFile(def, file);
      if (error) return showMessage(error);
      if (list.length >= max) return showMessage(`${def.label}最多 ${max} 个文件。`);
      try { list.push({ name: file.name, dataUrl: await readAssetFile(file) }); }
      catch { return showMessage(`读取 ${file.name} 失败。`); }
    }
    assetFiles.set(def.role, list);
    renderAssetFiles(def, slot);
    updateRatioLock();
  });
  slot.append(head, picker, files);
  return slot;
}
function renderAssetArea(model) {
  const capability = modelAssetCapability(model);
  const key = capability ? `${capability.frames}-${capability.references}` : 'none';
  if (key === assetCapabilityKey) return;
  assetCapabilityKey = key;
  assetFiles.clear();
  updateRatioLock();
  const grid = $('assetGrid');
  grid.replaceChildren();
  if (!capability) return $('assetArea').classList.add('hidden');
  $('assetArea').classList.remove('hidden');
  const limits = modelReferenceLimits(model);
  assetSlotDefs
    .filter((def) => def.role.startsWith('reference_') ? capability.references : capability.frames)
    .forEach((def) => grid.append(createAssetSlot(def, limits)));
}
modelSelect.addEventListener('change', () => {
  customModel.classList.toggle('hidden', modelSelect.value !== 'custom');
  if (modelSelect.value === 'custom') customModel.focus();
  updateResolutionField(modelSelect.value);
  renderAssetArea(modelSelect.value);
  updateDurationLimit();
});
customModel.addEventListener('input', () => {
  updateResolutionField(customModel.value.trim());
  renderAssetArea(customModel.value.trim());
});
$('inspireButton').addEventListener('click', () => {
  promptInput.value = examples[exampleIndex++ % examples.length];
  promptInput.dispatchEvent(new Event('input'));
  promptInput.focus();
});
$('retryButton').addEventListener('click', () => {
  if (!currentTaskId) return;
  setView('busy', '重新查询任务状态');
  pollTask();
});

async function initialize() {
  renderTemplates();
  try {
    const { configured } = await api('/api/config');
    $('configDot').className = `status-dot ${configured ? 'ready' : 'error'}`;
    $('configText').textContent = configured ? '生成服务已连接' : '请先配置 API Key';
    if (!configured) showMessage('尚未配置 API Key。请复制 .env.example 为 .env，填写 VIDEO_API_KEY 后重启服务。');
  } catch {
    $('configDot').className = 'status-dot error';
    $('configText').textContent = '服务连接异常';
  }
  updateDuration();
  updateDurationLimit();
  updateResolutionField(modelSelect.value);
  renderAssetArea(modelSelect.value);
  let savedId = sessionStorage.getItem('videoTaskId');
  const savedTask = sessionStorage.getItem('videoTask');
  if (savedTask) {
    try {
      const parsed = JSON.parse(savedTask);
      savedId = parsed.id;
      currentDuration = Number(parsed.duration) || 10;
      currentGenerateAudio = parsed.generateAudio !== false;
    } catch { sessionStorage.removeItem('videoTask'); }
  }
  if (savedId && /^[A-Za-z0-9_-]+$/.test(savedId)) {
    currentTaskId = savedId;
    setView('busy', '继续查询上次的任务');
    schedulePoll(500);
  }
}

initialize();
