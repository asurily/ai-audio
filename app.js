const $ = (id) => document.getElementById(id);
const form = $('createForm');
const promptInput = $('prompt');
const modelSelect = $('model');
const customModel = $('customModel');
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
  return (typeof value === 'string' ? value : value?.message) || taskData(data)?.message || '视频生成失败，请修改描述后重试。';
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(delay = 20_000) {
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
  const ratio = form.elements.ratio.value;
  const duration = Number(form.elements.duration.value);
  const generateAudio = form.elements.generateAudio.checked;
  const subtitleEnabled = form.elements.subtitleEnabled.checked;
  const subtitleText = $('subtitleText').value.trim();
  if (!prompt) return showMessage('请先描述你想生成的画面。');
  if (!model) return showMessage('请填写模型 ID。');
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
      body: JSON.stringify({ prompt, model, ratio, duration, generateAudio, subtitleEnabled, subtitleText }),
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
$('subtitleEnabled').addEventListener('change', () => {
  $('subtitleInputWrap').classList.toggle('hidden', !$('subtitleEnabled').checked);
  if ($('subtitleEnabled').checked) $('subtitleText').focus();
});
$('subtitleText').addEventListener('input', () => { $('subtitleCount').textContent = $('subtitleText').value.length; });
modelSelect.addEventListener('change', () => {
  customModel.classList.toggle('hidden', modelSelect.value !== 'custom');
  if (modelSelect.value === 'custom') customModel.focus();
  updateDurationLimit();
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
