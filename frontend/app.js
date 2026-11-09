'use strict';

/* ===================== 平台配置数据 ===================== */

const SOCIAL_PLATFORMS = [
  { id: 'x', name: 'X', color: '#000000' },
  { id: 'tiktok', name: 'TikTok', color: '#fe2c55' },
  { id: 'instagram', name: 'Instagram', color: '#e1306c' },
  { id: 'facebook', name: 'Facebook', color: '#1877f2' },
  { id: 'vk', name: 'VK', color: '#0077ff' },
  { id: 'youtube', name: 'YouTube', color: '#ff0000', disabled: true, tip: '暂未开放' },
];

const ECOMMERCE_PLATFORMS = [
  { id: 'amazon', name: 'Amazon', color: '#ff9900' },
  { id: 'lazada', name: 'Lazada', color: '#0f146d' },
  { id: 'shopee', name: 'Shopee', color: '#ee4d2d' },
  { id: 'tiktok-shop', name: 'TikTok', color: '#111111' },
  { id: 'blibli', name: 'Blibli', color: '#1b9ad2' },
  { id: 'tokopedia', name: 'Tokopedia', color: '#03ac0e' },
  { id: 'yandex', name: 'Yandex', color: '#fc3f1d' },
  { id: 'mercado', name: 'Mercado', color: '#e6a800' },
  { id: 'yahoo', name: 'Yahoo', color: '#6001d2' },
];

const ALL_PLATFORMS = {};
[...SOCIAL_PLATFORMS, ...ECOMMERCE_PLATFORMS].forEach((p) => { ALL_PLATFORMS[p.id] = p; });

const COLLECTION_OBJECTS = [
  { id: 'product_detail', title: '商品详情', desc: '采集商品规格、详情介绍等信息' },
  { id: 'product_review', title: '商品评价', desc: '采集商品评价与评分内容' },
  { id: 'product_qa', title: '商品问答', desc: '采集商品问答/问大家内容' },
];

const STEPS = ['选择平台', '选择采集对象', '配置采集范围'];

// 解析服务（scraper/api.py）；未启动时解析功能不可用并提示
const API_BASE = 'http://127.0.0.1:8765';

// 操作者浏览器 Cookie（通过评价页登录墙），仅保存在本机 localStorage、仅发给本地解析服务
function getAmazonCookies() {
  try { return localStorage.getItem('amazonCookies') || ''; } catch (e) { return ''; }
}

async function apiPost(path, body) {
  let resp;
  try {
    resp = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('解析服务未启动，请先运行 python scraper/api.py');
  }
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message);
  return json.data;
}

function makeInitialForm() {
  return {
    dataSourceName: '',
    platform: 'amazon',
    collectionObjects: ['product_review'],
    products: [],
    startAt: '',
    endMode: 'fixed_end',
    endAt: '',
    refreshMinutes: 5,
  };
}

// Step 3 店铺/商品记录持久化：下次打开向导恢复上次内容（存储不可用时保持为空）
const SCOPE_STORAGE_KEY = 'ds-scope-v1';

function loadPersistedScope() {
  try {
    const data = JSON.parse(localStorage.getItem(SCOPE_STORAGE_KEY) || 'null');
    if (data && Array.isArray(data.storeOptions) && Array.isArray(data.products)) return data;
    // 旧版本数据：stores 标签列表 → 转为可勾选店铺（默认全选）
    if (data && Array.isArray(data.stores) && Array.isArray(data.products)) {
      return {
        ...data,
        storeOptions: data.stores.map((s) => ({ id: s.id, displayName: s.name, selected: true })),
      };
    }
  } catch (e) { /* localStorage 不可用或数据损坏 */ }
  return null;
}

function persistScope() {
  try {
    localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify({
      platform: state.form.platform,
      collectionObjects: state.form.collectionObjects,
      startAt: state.form.startAt,
      endMode: state.form.endMode,
      endAt: state.form.endAt,
      refreshMinutes: state.form.refreshMinutes,
      storeOptions: state.storeOptions,
      products: state.form.products,
      storeCatalog: state.storeCatalog,
    }));
  } catch (e) { /* localStorage 不可用 */ }
}

/* ===================== 状态模型（仅前端内存） ===================== */

const state = {
  wizard: {
    open: false, step: 1, dirty: false, submitting: false, errors: {},
  },
  form: makeInitialForm(),
  storeCatalog: [], // 已解析店铺发现的全部商品（添加商品弹窗的可选列表来源）
  storeOptions: [], // 已解析出的全部店铺，勾选 = 加入本次采集
  productModal: {
    open: false, items: [], page: 1, pageSize: 10, query: '',
  },
  storeLink: { value: '', resolving: false, error: '' },
  dataView: { open: false, items: [], loading: false, startAt: '', endAt: '',
    objects: ['product_detail', 'product_review'], refreshTimer: null },
};

/* ===================== 工具函数 ===================== */

const $ = (id) => document.getElementById(id);

function randomDelay(min, max) {
  return min + Math.floor(Math.random() * (max - min));
}

function showToast(type, msg) {
  const region = $('toast-region');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  region.appendChild(t);
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 200);
  }, 3000);
}

/* ---------- 遮罩层栈与焦点管理 ---------- */

const focusStack = [];

function openOverlay(id, opts = {}) {
  const el = $(id);
  el.hidden = false;
  focusStack.push({ el, prev: opts.returnFocus || document.activeElement });
  const target = opts.focus
    ? el.querySelector(opts.focus)
    : el.querySelector('button:not([disabled]), input, select');
  if (target) target.focus();
}

function closeOverlay(id) {
  const el = $(id);
  el.hidden = true;
  const idx = focusStack.findIndex((f) => f.el === el);
  if (idx >= 0) {
    const [f] = focusStack.splice(idx, 1);
    if (f.prev && typeof f.prev.focus === 'function') f.prev.focus();
  }
}

function topOverlay() {
  return focusStack.length ? focusStack[focusStack.length - 1].el : null;
}

function focusablesIn(el) {
  return [...el.querySelectorAll(
    'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), '
    + 'select:not([disabled]):not([hidden]), [tabindex="0"]',
  )].filter((n) => n.offsetParent !== null);
}

function trapTab(container, e) {
  const items = focusablesIn(container);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    last.focus();
    e.preventDefault();
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus();
    e.preventDefault();
  }
}

document.addEventListener('keydown', (e) => {
  const top = topOverlay();
  if (!top) return;
  if (e.key === 'Escape') {
    handleEscape(top);
    e.preventDefault();
  } else if (e.key === 'Tab') {
    trapTab(top, e);
  }
});

function handleEscape(el) {
  switch (el.id) {
    case 'wizard-overlay': attemptCloseWizard(); break;
    case 'product-overlay': cancelProductModal(); break;
    case 'confirm-overlay': keepFilling(); break; // Esc 等同于「继续填写」
    default: break;
  }
}

/* ===================== 添加数据源向导 ===================== */

function platformName(id) {
  return ALL_PLATFORMS[id] ? ALL_PLATFORMS[id].name : '';
}

function markDirty() {
  if (state.wizard.open) state.wizard.dirty = true;
}

// 数据源名称跟随所选平台自动填充；用户手动输入后不再覆盖
function autoFillName() {
  const f = state.form;
  if (f.platform && (state.wizard.nameAutoFilled || !f.dataSourceName.trim())) {
    f.dataSourceName = platformName(f.platform);
    state.wizard.nameAutoFilled = true;
  }
}

function openWizard() {
  state.wizard = { open: true, step: 1, dirty: false, submitting: false, errors: {}, nameAutoFilled: false };
  state.form = makeInitialForm();
  state.storeLink = { value: '', resolving: false, error: '' };
  const saved = loadPersistedScope();
  if (saved) {
    state.storeOptions = saved.storeOptions;
    state.form.products = saved.products;
    state.storeCatalog = saved.storeCatalog || [];
    // 恢复上次填写的采集对象与采集范围，避免反复填写
    if (Array.isArray(saved.collectionObjects) && saved.collectionObjects.length) {
      state.form.collectionObjects = saved.collectionObjects;
    }
    if (saved.startAt) state.form.startAt = saved.startAt;
    if (saved.endMode) state.form.endMode = saved.endMode;
    if (saved.endAt) state.form.endAt = saved.endAt;
    if (saved.refreshMinutes) state.form.refreshMinutes = saved.refreshMinutes;
  }
  autoFillName(); // 已默认勾选平台时，名称填上该平台
  openOverlay('wizard-overlay', { returnFocus: $('btn-open-wizard') });
  renderWizard();
}

function closeWizard() {
  closeOverlay('wizard-overlay');
  state.wizard.open = false;
  state.form = makeInitialForm(); // 不保存到后端，恢复初始状态
}

function attemptCloseWizard() {
  if (state.wizard.dirty && !state.wizard.submitting) {
    openOverlay('confirm-overlay', { focus: '#confirm-cancel' });
  } else {
    closeWizard();
  }
}

function keepFilling() {
  closeOverlay('confirm-overlay');
}

function discardAndClose() {
  closeOverlay('confirm-overlay');
  closeWizard();
}

/* ---------- 渲染 ---------- */

function renderWizard() {
  const w = state.wizard;
  document.querySelectorAll('[data-step-pane]').forEach((sec) => {
    sec.hidden = Number(sec.dataset.stepPane) !== w.step;
  });

  // Stepper
  const stepper = $('wizard-stepper');
  stepper.innerHTML = '';
  STEPS.forEach((label, i) => {
    const num = i + 1;
    const cls = num < w.step ? 'done' : num === w.step ? 'current' : 'todo';
    const li = document.createElement('li');
    li.className = `step ${cls}`;
    li.innerHTML = `<span class="step-dot" aria-hidden="true">${num < w.step ? '✓' : num}</span>`
      + `<span class="step-label">${label}</span>`;
    stepper.appendChild(li);
    if (num < STEPS.length) {
      const conn = document.createElement('li');
      conn.className = 'step-connector';
      conn.setAttribute('aria-hidden', 'true');
      stepper.appendChild(conn);
    }
  });

  // 底部按钮
  $('wf-prev').hidden = w.step === 1;
  $('wf-cancel').disabled = w.submitting;
  $('wf-prev').disabled = w.submitting;
  const nextBtn = $('wf-next');
  nextBtn.disabled = w.submitting;
  nextBtn.querySelector('.btn-label').textContent = w.step === 3 ? '确认' : '下一步';
  nextBtn.querySelector('.spinner').hidden = !w.submitting;

  renderStep1();
  renderStep2();
  renderStep3();
}

function setFieldError(fieldId, errorId, inputId, msg) {
  const field = $(fieldId);
  const errEl = $(errorId);
  const input = inputId ? $(inputId) : null;
  field.classList.toggle('has-error', !!msg);
  errEl.hidden = !msg;
  errEl.textContent = msg || '';
  if (input) {
    if (msg) input.setAttribute('aria-describedby', errorId);
    else input.removeAttribute('aria-describedby');
  }
}

function renderStep1() {
  const { form, wizard } = state;
  $('ds-name').value = form.dataSourceName;
  setFieldError('field-name', 'ds-name-error', 'ds-name', wizard.errors.name || '');

  renderPlatformGrid('grid-social', SOCIAL_PLATFORMS);
  renderPlatformGrid('grid-ecommerce', ECOMMERCE_PLATFORMS);
  setFieldError('field-social', 'platform-error', null, wizard.errors.platform || '');
}

function renderPlatformGrid(gridId, platforms) {
  const grid = $(gridId);
  grid.innerHTML = '';
  platforms.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick-card';
    const selected = state.form.platform === p.id;
    if (selected) btn.classList.add('selected');
    btn.disabled = !!p.disabled;
    btn.setAttribute('aria-pressed', String(selected));
    if (p.disabled) {
      btn.setAttribute('aria-disabled', 'true');
      btn.dataset.tip = p.tip;
    }
    btn.innerHTML = `<span class="pick-check" aria-hidden="true">✓</span>`
      + `<span class="platform-icon" style="--pc:${p.color}" aria-hidden="true">${p.name[0]}</span>`
      + `<span class="pick-name">${p.name}</span>`
      + (p.disabled ? `<span class="pick-badge">暂未开放</span>` : '');
    btn.addEventListener('click', () => selectPlatform(p.id));
    grid.appendChild(btn);
  });
}

function selectPlatform(id) {
  if (state.form.platform === id) return;
  state.form.platform = id; // 单选：只保留最后一次选择
  state.wizard.errors.platform = '';
  autoFillName();
  markDirty();
  renderStep1();
}

function renderStep2() {
  const grid = $('grid-object');
  grid.innerHTML = '';
  COLLECTION_OBJECTS.forEach((obj) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'object-card';
    const selected = state.form.collectionObjects.includes(obj.id);
    if (selected) btn.classList.add('selected');
    btn.setAttribute('aria-pressed', String(selected));
    btn.innerHTML = `<span class="pick-check" aria-hidden="true">✓</span>`
      + `<span class="object-title">${obj.title}</span>`
      + `<span class="object-desc">${obj.desc}</span>`;
    btn.addEventListener('click', () => {
      // 多选：切换选中状态，至少保留一个由校验兜底
      const list = state.form.collectionObjects;
      const idx = list.indexOf(obj.id);
      if (idx >= 0) list.splice(idx, 1);
      else list.push(obj.id);
      state.wizard.errors.collectionObject = '';
      markDirty();
      persistScope(); // 记住勾选，下次打开向导恢复
      renderStep2();
    });
    grid.appendChild(btn);
  });
  setFieldError('field-object', 'object-error', null, state.wizard.errors.collectionObject || '');
}

function renderStep3() {
  const { form, wizard } = state;
  const platform = ALL_PLATFORMS[form.platform];

  const tag = $('s3-platform-tag');
  tag.innerHTML = platform
    ? `<span class="platform-icon" style="--pc:${platform.color}" aria-hidden="true">${platform.name[0]}</span>${platform.name}`
    : '未选择平台';

  // 店铺链接解析
  const sl = state.storeLink;
  $('s3-store-link').value = sl.value;
  $('s3-resolve-store').disabled = sl.resolving;
  $('s3-resolve-store').querySelector('.spinner').hidden = !sl.resolving;
  setFieldError('field-store-link', 's3-store-error', 's3-store-link', sl.error || '');

  // 店铺勾选列表（解析出的店铺，勾选 = 加入本次采集）
  const storesEl = $('s3-stores');
  storesEl.innerHTML = '';
  if (!state.storeOptions.length) {
    storesEl.innerHTML = '<span class="empty-inline">暂无店铺，请先解析店铺链接</span>';
  } else {
    state.storeOptions.forEach((s, i) => {
      const label = document.createElement('label');
      label.className = 'store-option';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.selected;
      cb.dataset.idx = String(i);
      const name = document.createElement('span');
      name.className = 'store-option-name';
      name.textContent = s.displayName;
      label.append(cb, name);
      storesEl.appendChild(label);
    });
  }

  // 商品标签
  const productsEl = $('s3-products');
  productsEl.innerHTML = '';
  $('s3-product-count').textContent = `已选 ${form.products.length}`;
  if (!form.products.length) {
    productsEl.innerHTML = '<span class="empty-inline">暂未添加商品</span>';
  } else {
    form.products.forEach((p) => {
      const el = document.createElement('span');
      el.className = 'tag';
      el.innerHTML = `<span class="tag-name">${p.name}</span><span class="tag-id">${p.id}</span>`;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'tag-x';
      x.textContent = '×';
      x.setAttribute('aria-label', `删除商品 ${p.name}`);
      x.addEventListener('click', () => {
        state.form.products = state.form.products.filter((it) => it.id !== p.id);
        markDirty();
        renderStep3();
      });
      el.appendChild(x);
      productsEl.appendChild(el);
    });
  }

  // 时间与结束方式
  $('s3-start').value = form.startAt;
  $('s3-refresh').value = String(form.refreshMinutes);
  document.querySelectorAll('input[name="endMode"]').forEach((r) => {
    r.checked = r.value === form.endMode;
  });
  // 持续采集：显示刷新时间，隐藏结束时间；指定结束时间：显示并可编辑结束时间
  $('field-refresh').hidden = form.endMode !== 'keep';
  $('field-end').hidden = form.endMode === 'keep';
  $('s3-end').value = form.endAt;
  setFieldError('field-start', 's3-start-error', 's3-start', wizard.errors.startAt || '');
  setFieldError('field-end', 's3-end-error', 's3-end', wizard.errors.endAt || '');
}

/* ---------- 店铺链接解析 ---------- */

// 常见品牌中文名映射；未命中的店铺只显示英文原名
const BRAND_ZH = {
  samsung: '三星', apple: '苹果', huawei: '华为', xiaomi: '小米', oppo: 'OPPO',
  vivo: 'vivo', honor: '荣耀', lenovo: '联想', sony: '索尼', lg: 'LG',
  asus: '华硕', acer: '宏碁', dell: '戴尔', hp: '惠普', msi: '微星',
  nintendo: '任天堂', philips: '飞利浦', panasonic: '松下', canon: '佳能',
  bosch: '博世', dyson: '戴森', anker: '安克', nike: '耐克', adidas: '阿迪达斯',
  puma: '彪马', uniqlo: '优衣库', sephora: '丝芙兰',
};

function storeDisplayName(name) {
  const zh = BRAND_ZH[name.trim().toLowerCase()];
  return zh ? `${zh} ${name.trim()}` : name.trim();
}

async function resolveStoreLink() {
  const sl = state.storeLink;
  const val = sl.value.trim();
  if (sl.resolving) return;
  if (!val) {
    sl.error = '请输入店铺链接';
    renderStep3();
    return;
  }
  if (!/^https?:\/\//i.test(val)) {
    sl.error = '请输入以 http(s):// 开头的有效店铺链接';
    renderStep3();
    return;
  }
  sl.resolving = true;
  sl.error = '';
  renderStep3();
  try {
    const data = await apiPost('/api/v1/stores/resolve', {
      platform: state.form.platform,
      url: val,
      maxProducts: 60,
    });
    if (!data.products.length) {
      sl.error = '未能从该店铺解析出商品，请确认链接是否正确';
      return;
    }
    // 解析新店铺链接后只保留最新结果：旧店铺、旧商品目录、已选商品一并清掉
    const name = data.store.name || data.store.externalId || val;
    const displayName = storeDisplayName(name);
    state.storeOptions = [{ id: `store-${Date.now()}`, displayName, selected: true }];
    state.storeCatalog = data.products.map((p) => ({
      id: p.externalId, name: p.name || p.externalId, url: p.url || '',
    }));
    state.form.products = [];
    showToast('success', `已解析店铺「${displayName}」，发现 ${state.storeCatalog.length} 个商品；原店铺与商品已清除`);
    markDirty();
    persistScope();
  } catch (e) {
    sl.error = e.message;
    showToast('error', e.message);
  } finally {
    sl.resolving = false;
    renderStep3();
  }
}

/* ---------- 校验与导航 ---------- */

function validateStep1() {
  const errs = {};
  if (!state.form.dataSourceName.trim()) errs.name = '请输入数据源名称';
  if (!state.form.platform) errs.platform = '请选择平台';
  state.wizard.errors = errs;
  return !Object.keys(errs).length;
}

function validateStep2() {
  const errs = {};
  if (!state.form.collectionObjects.length) errs.collectionObject = '请至少选择一个采集对象';
  state.wizard.errors = errs;
  return !Object.keys(errs).length;
}

function validateStep3() {
  const { form } = state;
  const errs = {};
  if (!form.startAt) errs.startAt = '请选择开始抓取时间';
  if (form.endMode === 'fixed_end') {
    if (!form.endAt) {
      errs.endAt = '请选择结束抓取时间';
    } else if (form.startAt && new Date(form.endAt).getTime() <= new Date(form.startAt).getTime()) {
      errs.endAt = '结束时间必须晚于开始时间';
    }
  }
  state.wizard.errors = errs;
  return !Object.keys(errs).length;
}

function goNextStep() {
  const w = state.wizard;
  if (w.submitting) return;
  if (w.step === 1) {
    if (!validateStep1()) { renderWizard(); return; }
    w.step = 2;
  } else if (w.step === 2) {
    if (!validateStep2()) { renderWizard(); return; }
    w.step = 3;
  } else {
    confirmWizard();
    return;
  }
  renderWizard();
}

function goPrevStep() {
  if (state.wizard.step > 1) {
    state.wizard.step -= 1;
    state.wizard.errors = {};
    renderWizard();
  }
}

function confirmWizard() {
  if (!validateStep3()) { renderWizard(); return; }
  state.wizard.submitting = true; // 主按钮加载并禁用，防止重复点击
  renderWizard();
  setTimeout(() => {
    persistScope(); // 保存本次店铺/商品记录，下次打开向导恢复
    closeWizard();
    showToast('success', '数据源创建成功');
  }, randomDelay(800, 1200));
}

/* ---------- 向导事件 ---------- */

$('btn-open-wizard').addEventListener('click', openWizard);
$('wizard-close').addEventListener('click', attemptCloseWizard);
$('wf-cancel').addEventListener('click', attemptCloseWizard);
$('wf-prev').addEventListener('click', goPrevStep);
$('wf-next').addEventListener('click', goNextStep);

$('ds-name').addEventListener('input', (e) => {
  state.form.dataSourceName = e.target.value;
  state.wizard.nameAutoFilled = false; // 手动填写后，平台切换不再覆盖名称
  state.wizard.errors.name = '';
  markDirty();
  setFieldError('field-name', 'ds-name-error', 'ds-name', '');
});

document.querySelectorAll('input[name="endMode"]').forEach((r) => {
  r.addEventListener('change', (e) => {
    state.form.endMode = e.target.value; // 持续采集：结束时间锁定为当前时间并显示刷新频率
    state.wizard.errors.endAt = '';
    markDirty();
    persistScope();
    renderStep3();
  });
});

$('s3-refresh').addEventListener('change', (e) => {
  state.form.refreshMinutes = Number(e.target.value);
  markDirty();
  persistScope();
});

// 点击输入框任意位置即打开时间选择器，不必点右侧日历图标
['s3-start', 's3-end'].forEach((id) => {
  $(id).addEventListener('click', function () {
    if (typeof this.showPicker === 'function') {
      try { this.showPicker(); } catch (err) { /* 部分浏览器要求用户手势，忽略 */ }
    }
  });
});

$('s3-start').addEventListener('change', (e) => {
  state.form.startAt = e.target.value;
  state.wizard.errors.startAt = '';
  markDirty();
  persistScope();
  renderStep3();
});

$('s3-end').addEventListener('change', (e) => {
  state.form.endAt = e.target.value;
  state.wizard.errors.endAt = '';
  markDirty();
  persistScope();
  renderStep3();
});

$('s3-add-product').addEventListener('click', openProductModal);

/* ---------- 店铺链接解析事件 ---------- */

$('s3-store-link').addEventListener('input', (e) => {
  state.storeLink.value = e.target.value;
  state.storeLink.error = '';
  markDirty();
  setFieldError('field-store-link', 's3-store-error', 's3-store-link', '');
});

$('s3-store-link').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') resolveStoreLink();
});

$('s3-resolve-store').addEventListener('click', resolveStoreLink);

$('s3-stores').addEventListener('change', (e) => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  state.storeOptions[Number(e.target.dataset.idx)].selected = e.target.checked;
  markDirty();
});

/* ===================== 添加商品弹窗 ===================== */

function openProductModal() {
  const m = state.productModal;
  m.open = true;
  // 可选列表 = 已解析店铺发现的全部商品；已在 Step 3 的默认勾选。取消不回填
  m.items = state.storeCatalog.map((p) => ({
    ...p,
    selected: state.form.products.some((it) => it.id === p.id),
  }));
  m.page = 1;
  m.pageSize = 10;
  m.query = '';
  $('page-size').value = '10';
  $('product-search').value = '';
  openOverlay('product-overlay');
  renderProductModal();
}

function closeProductModal() {
  closeOverlay('product-overlay');
  state.productModal.open = false;
}

function cancelProductModal() {
  closeProductModal(); // 丢弃本次勾选
}

function confirmProductModal() {
  const m = state.productModal;
  state.form.products = m.items.filter((p) => p.selected)
    .map((p) => ({ id: p.id, name: p.name, url: p.url || '' })); // 确认后回填 Step 3
  state.wizard.dirty = true;
  closeProductModal();
  renderStep3();
}

function pageNumbers(total, current) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total, current - 1, current, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

function renderProductModal() {
  const m = state.productModal;
  const selectedCount = m.items.filter((p) => p.selected).length;

  // 搜索过滤（名称/ID 不区分大小写）；勾选状态始终保留在全量列表上
  const q = (m.query || '').trim().toLowerCase();
  const filtered = q
    ? m.items.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.id || '').toLowerCase().includes(q))
    : m.items;

  const hasProducts = filtered.length > 0;
  $('product-table-wrap').hidden = !hasProducts;
  $('product-empty').hidden = hasProducts;
  $('product-empty').textContent = q
    ? `没有匹配「${m.query.trim()}」的商品`
    : '暂无可选商品，请先解析店铺';
  $('product-sum').textContent = `已选 ${selectedCount} / 共 ${m.items.length} 个商品`;

  // 分页（无匹配时隐藏）
  const pagination = $('product-pagination');
  pagination.hidden = !hasProducts;
  if (!hasProducts) {
    $('product-confirm').textContent = `确认（${selectedCount}）`;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / m.pageSize));
  m.page = Math.min(Math.max(1, m.page), totalPages);
  $('page-total').textContent = `共 ${filtered.length} 条`;

  const start = (m.page - 1) * m.pageSize;
  const rows = filtered.slice(start, start + m.pageSize);
  const tbody = $('product-tbody');
  tbody.innerHTML = '';
  rows.forEach((p) => {
    const tr = document.createElement('tr');
    const tdCheck = document.createElement('td');
    tdCheck.className = 'td-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.selected;
    cb.setAttribute('aria-label', `选择商品 ${p.name}`);
    cb.addEventListener('change', () => {
      p.selected = cb.checked;
      $('product-confirm').textContent = `确认（${m.items.filter((it) => it.selected).length}）`;
      $('product-sum').textContent = `已选 ${m.items.filter((it) => it.selected).length} / 共 ${m.items.length} 个商品`;
    });
    tdCheck.appendChild(cb);
    const tdName = document.createElement('td');
    tdName.className = 'td-name';
    tdName.title = p.name; // 长名称省略并提示
    tdName.textContent = p.name;
    const tdId = document.createElement('td');
    tdId.className = 'td-id';
    tdId.textContent = p.id;
    tr.append(tdCheck, tdName, tdId);
    tbody.appendChild(tr);
  });

  // 页码
  const btns = $('page-btns');
  btns.innerHTML = '';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'page-btn';
  prev.textContent = '<';
  prev.disabled = m.page === 1;
  prev.setAttribute('aria-label', '上一页');
  prev.addEventListener('click', () => { m.page -= 1; renderProductModal(); });
  btns.appendChild(prev);
  pageNumbers(totalPages, m.page).forEach((p) => {
    if (p === '…') {
      const ell = document.createElement('span');
      ell.className = 'page-ellipsis';
      ell.textContent = '…';
      btns.appendChild(ell);
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `page-btn${p === m.page ? ' current' : ''}`;
    b.textContent = p;
    b.setAttribute('aria-label', `第 ${p} 页`);
    b.setAttribute('aria-current', p === m.page ? 'page' : 'false');
    b.addEventListener('click', () => { m.page = p; renderProductModal(); });
    btns.appendChild(b);
  });
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'page-btn';
  next.textContent = '>';
  next.disabled = m.page === totalPages;
  next.setAttribute('aria-label', '下一页');
  next.addEventListener('click', () => { m.page += 1; renderProductModal(); });
  btns.appendChild(next);

  $('page-jump-input').value = '';
  $('page-jump-input').max = totalPages;

  $('product-confirm').textContent = `确认（${selectedCount}）`;
}

/* ---------- 商品弹窗事件 ---------- */

$('product-close').addEventListener('click', cancelProductModal);
$('product-cancel').addEventListener('click', cancelProductModal);
$('product-confirm').addEventListener('click', confirmProductModal);

$('page-size').addEventListener('change', (e) => {
  const m = state.productModal;
  m.pageSize = Number(e.target.value);
  m.page = 1;
  renderProductModal();
});

// 商品搜索：输入/按钮/回车过滤，清除恢复全量
function applyProductSearch(value) {
  const m = state.productModal;
  m.query = value;
  m.page = 1;
  renderProductModal();
}
$('product-search-btn').addEventListener('click', () => applyProductSearch($('product-search').value));
$('product-search').addEventListener('input', (e) => applyProductSearch(e.target.value));
$('product-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyProductSearch(e.target.value);
});
$('product-search-clear').addEventListener('click', () => {
  $('product-search').value = '';
  applyProductSearch('');
});

$('page-jump-btn').addEventListener('click', jumpToPage);
$('page-jump-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') jumpToPage();
});

function jumpToPage() {
  const m = state.productModal;
  // 跳页按当前搜索过滤后的条数计算
  const q = (m.query || '').trim().toLowerCase();
  const count = q
    ? m.items.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.id || '').toLowerCase().includes(q)).length
    : m.items.length;
  const totalPages = Math.max(1, Math.ceil(count / m.pageSize));
  const val = Math.floor(Number($('page-jump-input').value));
  if (Number.isInteger(val) && val >= 1 && val <= totalPages) {
    m.page = val; // 跳页输入必须为 1 到总页数之间的整数
  }
  renderProductModal();
}

/* ===================== 二次确认 ===================== */

$('confirm-cancel').addEventListener('click', keepFilling);
$('confirm-ok').addEventListener('click', discardAndClose);

/* ===================== 数据详情（获取数据） ===================== */

function openDataView() {
  const saved = loadPersistedScope();
  const products = saved ? saved.products : [];
  state.dataView.platform = (saved && saved.platform) || 'amazon';
  // 采集对象勾选决定数据组成：商品评价不勾则不抓评价，商品详情不勾则只展示基础字段
  // 注意：确认创建后向导表单会被重置，因此优先读已持久化的配置，表单仅作兜底
  const objects = ((saved && Array.isArray(saved.collectionObjects) && saved.collectionObjects.length)
    ? saved.collectionObjects
    : (state.form.collectionObjects.length ? state.form.collectionObjects : null))
    || ['product_detail', 'product_review'];
  state.dataView.objects = objects;
  if (objects.includes('product_qa')) {
    showToast('info', '商品问答采集暂未接入解析服务，本次数据不含问答内容');
  }
  // 采集期间（向导设置）：传给解析服务按评价时间过滤；持续采集无结束上限
  state.dataView.startAt = (saved && saved.startAt) || state.form.startAt || '';
  const endMode = (saved && saved.endMode) || state.form.endMode || 'keep';
  state.dataView.endAt = endMode === 'end'
    ? ((saved && saved.endAt) || state.form.endAt || '')
    : '';
  state.dataView.items = products.map((p) => ({
    id: p.id, name: p.name, url: p.url || '', selected: true, status: 'pending',
    detail: null, error: '', showAttrs: false, showReviews: false,
  }));
  state.dataView.open = true;
  $('home-view').hidden = true;
  $('data-view').hidden = false;
  renderDataView();
  if (state.dataView.items.length) fetchDetails(); // 进入页面自动获取
  // 持续采集：按设置的刷新时间定时重抓
  const refreshMinutes = (saved && saved.refreshMinutes) || state.form.refreshMinutes || 0;
  if (endMode === 'keep' && refreshMinutes > 0) {
    state.dataView.refreshTimer = setInterval(() => {
      if (state.dataView.open && !state.dataView.loading) fetchDetails();
    }, refreshMinutes * 60000);
  }
}

function closeDataView() {
  state.dataView.open = false;
  if (state.dataView.refreshTimer) {
    clearInterval(state.dataView.refreshTimer);
    state.dataView.refreshTimer = null;
  }
  $('data-view').hidden = true;
  $('home-view').hidden = false;
}

// 登录墙自动处理：弹出登录窗口 → 轮询状态 → 登录成功自动重试获取
const loginFlow = { active: false };

async function autoLoginAndRetry(it, hint, btn) {
  if (loginFlow.active) return;
  loginFlow.active = true;
  if (btn) btn.hidden = true;
  const dv = state.dataView;
  const lazada = dv.platform === 'lazada';
  const verifyPath = lazada ? '/api/v1/lazada/verify' : '/api/v1/login';
  const statusPath = lazada ? '/api/v1/lazada/verify/status' : '/api/v1/login/status';
  try {
    const r = await apiPost(verifyPath, {});
    hint.textContent = lazada
      ? (r.message || '验证窗口已打开，请在窗口中完成 Lazada 滑块验证')
      : (r.message || '登录窗口已打开，请在窗口中登录 Amazon');
    const timer = setInterval(async () => {
      let st;
      try { st = await apiPost(statusPath, {}); } catch (e) { return; }
      if (st.message) hint.textContent = st.message;
      if (st.status === 'ok') {
        clearInterval(timer);
        loginFlow.active = false;
        // 等正在进行的批量获取结束后，自动重试全部商品
        const retry = () => {
          if (state.dataView.loading) { setTimeout(retry, 1000); return; }
          fetchDetails();
        };
        retry();
      } else if (st.status === 'cancelled' || st.status === 'error') {
        clearInterval(timer);
        loginFlow.active = false;
        if (btn) btn.hidden = false; // 未完成登录时可手动再开
      }
    }, 2000);
  } catch (e) {
    loginFlow.active = false;
    hint.textContent = e.message;
    if (btn) btn.hidden = false;
  }
}

// 单个商品拉取完整详情（含 Cookie 重试）
async function fetchOneDetail(it) {
  const dv = state.dataView;
  it.status = 'loading'; it.error = '';
  renderDataView();
  try {
    const data = await apiPost('/api/v1/products/resolve', {
      platform: dv.platform,
      identifier: dv.platform === 'lazada' ? (it.url || it.id) : it.id,
      detail: true,
      objects: dv.objects, // 采集对象勾选：决定是否抓取评价
      cookies: getAmazonCookies(),
      startAt: dv.startAt, endAt: dv.endAt, // 采集期间，按评价时间过滤
    });
    it.detail = data;
    it.name = data.title || it.name;
    it.status = 'done';
    it.loginPrompted = false; // 下次再遇登录墙可重新自动弹窗（如 Cookie 过期）
  } catch (e) {
    it.status = 'error';
    it.error = e.message;
  }
  renderDataView();
}

// 逐个商品拉取完整详情（§10.2）；串行 + 间隔，避免触发限流
async function fetchDetails() {
  const dv = state.dataView;
  if (dv.loading) return;
  dv.loading = true;
  dv.items.forEach((it) => { it.status = 'loading'; it.error = ''; });
  renderDataView();
  for (let i = 0; i < dv.items.length; i++) {
    const it = dv.items[i];
    try {
      const data = await apiPost('/api/v1/products/resolve', {
        platform: dv.platform,
        identifier: dv.platform === 'lazada' ? (it.url || it.id) : it.id,
        detail: true,
        objects: dv.objects, // 采集对象勾选：决定是否抓取评价
        cookies: getAmazonCookies(),
        startAt: dv.startAt, endAt: dv.endAt, // 采集期间，按评价时间过滤
      });
      it.detail = data;
      it.name = data.title || it.name;
      it.status = 'done';
    } catch (e) {
      it.status = 'error';
      it.error = e.message;
    }
    if (i < dv.items.length - 1) await new Promise((r) => setTimeout(r, 800));
    if (dv.open) renderDataView();
  }
  dv.loading = false;
  if (dv.open) renderDataView();
}

// 详情对象 → 表格行（字段名, 展示值）；属性/评价单独渲染为可展开区，导出仍用完整 detail JSON
function detailRows(d) {
  return [
    ['商品名称', d.title],
    ['商品 ID', d.externalId],
    ['价格', d.price ? `${d.price.amount} ${d.price.currency}` : null],
    ['评分', d.rating && d.rating.value != null
      ? `${d.rating.value} / ${d.rating.scale}${d.rating.count != null ? `（${d.rating.count} 人评分）` : ''}` : null],
    ['品牌', d.brand],
    ['型号', d.model],
    ['图片数', Array.isArray(d.referenceImages) ? String(d.referenceImages.length) : null],
    ['变体数', Array.isArray(d.variants) ? String(d.variants.length) : null],
    ['商品链接', d.url],
    ['采集时间', d.collectedAt],
  ];
}

function renderProductCard(it, idx) {
  const card = document.createElement('section');
  card.className = 'data-card';

  const head = document.createElement('div');
  head.className = 'data-card-head';
  const label = document.createElement('label');
  label.className = 'data-card-select';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = it.selected;
  cb.dataset.idx = String(idx);
  const name = document.createElement('span');
  name.className = 'data-card-name';
  name.textContent = it.name || it.id;
  label.append(cb, name);
  const meta = document.createElement('span');
  meta.className = 'data-card-meta';
  meta.textContent = it.id;
  // 参考图（§10.2）：不属于任何采集对象，始终展示在商品 ID 右侧，点击看原图
  const refs = Array.isArray(it.detail?.referenceImages) ? it.detail.referenceImages : [];
  const right = document.createElement('span');
  right.className = 'data-card-right';
  right.appendChild(meta);
  if (refs.length) {
    const box = document.createElement('span');
    box.className = 'data-card-refimgs';
    refs.slice(0, 5).forEach((img) => {
      const a = document.createElement('a');
      a.href = img.url; a.target = '_blank'; a.rel = 'noopener';
      const im = document.createElement('img');
      im.src = img.url; im.loading = 'lazy'; im.alt = '参考图';
      im.title = img.type === 'main' ? '主图' : '附图';
      a.appendChild(im);
      box.appendChild(a);
    });
    if (refs.length > 5) {
      box.appendChild(Object.assign(document.createElement('span'), {
        className: 'data-card-refmore', textContent: `+${refs.length - 5}`,
      }));
    }
    right.appendChild(box);
  }
  head.append(label, right);
  card.appendChild(head);

  if (it.status === 'loading') {
    const tip = document.createElement('p');
    tip.className = 'data-card-tip';
    tip.textContent = '正在获取数据…';
    card.appendChild(tip);
  } else if (it.status === 'error') {
    const tip = document.createElement('p');
    tip.className = 'data-card-tip data-card-error';
    tip.textContent = `获取失败：${it.error}`;
    card.appendChild(tip);
  } else if (it.detail) {
    const wantDetail = state.dataView.objects.includes('product_detail');
    const wantReview = state.dataView.objects.includes('product_review');
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const table = document.createElement('table');
    table.className = 'table';
    const tbody = document.createElement('tbody');
    // 未勾选「商品详情」时只展示基础字段，数据组成跟随采集对象勾选
    const rows = wantDetail ? detailRows(it.detail)
      : [['商品名称', it.detail.title], ['商品 ID', it.detail.externalId], ['采集时间', it.detail.collectedAt]];
    rows.forEach(([k, v]) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = k;
      const td = document.createElement('td');
      if (k === '商品链接' && v) {
        const a = document.createElement('a');
        a.href = v; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = v;
        td.appendChild(a);
      } else {
        td.textContent = v == null || v === '' ? '—' : String(v);
      }
      tr.append(th, td);
      tbody.appendChild(tr);
    });
    // 属性：收成一行，点击展开全部（仅勾选「商品详情」时展示）
    const attrEntries = wantDetail ? Object.entries(it.detail.attributes || {}) : [];
    if (attrEntries.length) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = '属性';
      const td = document.createElement('td');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'data-expand-btn';
      toggle.textContent = `${attrEntries.length} 项 ${it.showAttrs ? '▲' : '▼'}`;
      const list = document.createElement('div');
      list.className = 'data-attr-list';
      list.hidden = !it.showAttrs;
      attrEntries.forEach(([k, v]) => {
        const line = document.createElement('div');
        line.textContent = `${k}：${v == null || v === '' ? '—' : v}`;
        list.appendChild(line);
      });
      toggle.addEventListener('click', () => {
        it.showAttrs = !it.showAttrs;
        list.hidden = !it.showAttrs;
        toggle.textContent = `${attrEntries.length} 项 ${it.showAttrs ? '▲' : '▼'}`;
      });
      td.appendChild(toggle);
      td.appendChild(list);
      tr.append(th, td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    if (wantReview) card.appendChild(renderReviewsSection(it));
  } else {
    const tip = document.createElement('p');
    tip.className = 'data-card-tip';
    tip.textContent = '待获取';
    card.appendChild(tip);
  }
  return card;
}

// 评价区（§10.3）：默认收起，点击展开查看获取期间的全部评价
function renderReviewsSection(it) {
  const reviews = Array.isArray(it.detail.reviews) ? it.detail.reviews : [];
  const section = document.createElement('div');
  section.className = 'data-reviews';
  const headRow = document.createElement('div');
  headRow.className = 'data-reviews-head';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'data-expand-btn data-reviews-toggle';
  toggle.textContent = `评价（${reviews.length}）${it.showReviews ? '▲' : '▼'}`;

  // 评价全选：勾选该商品全部评价用于导出
  let selAll = null;
  if (reviews.length) {
    selAll = document.createElement('input');
    selAll.type = 'checkbox';
    selAll.className = 'data-review-check data-review-all';
    selAll.checked = reviews.every((r) => r._sel);
    selAll.title = '全选/取消该商品的全部评价';
    selAll.dataset.all = '1';
    selAll.dataset.idx = String(state.dataView.items.indexOf(it));
  }

  const list = document.createElement('div');
  list.className = 'data-review-list';
  list.hidden = !it.showReviews;
  const rerr = it.detail.reviewsError;
  if (rerr) {
    const tip = document.createElement('p');
    tip.className = 'data-card-tip';
    tip.textContent = rerr.message || '评价获取失败';
    list.appendChild(tip);
    if (rerr.code === 'SOURCE_LOGIN_REQUIRED') {
      // 登录墙：自动弹出登录窗口，登录成功后自动重试（无需手动操作）
      const hint = document.createElement('p');
      hint.className = 'data-card-tip';
      hint.textContent = '需要登录 Amazon：正在弹出登录窗口…';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary';
      btn.textContent = '重新打开登录窗口';
      btn.hidden = true; // 仅在自动流程取消/失败后显示
      btn.addEventListener('click', () => autoLoginAndRetry(it, hint, btn));
      list.append(hint, btn);
      if (!it.loginPrompted) {
        it.loginPrompted = true;
        autoLoginAndRetry(it, hint, btn);
      }
    }
  } else if (!reviews.length) {
    const empty = document.createElement('p');
    empty.className = 'data-card-tip';
    const latest = it.detail.latestReviewAt;
    empty.textContent = latest
      ? `获取期间未抓取到评价，该商品最新评价时间：${latest}`
      : '获取期间未抓取到评价';
    list.appendChild(empty);
  }
  // 每条评价按 §10.3 字段分行展示：勾选框/昵称/星级/地区/时间/购买型号/收货状态/点赞量/内容/图片/视频
  reviews.forEach((r, ridx) => {
    const item = document.createElement('div');
    item.className = 'data-review';

    const head = document.createElement('div');
    head.className = 'data-review-head';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'data-review-check';
    check.dataset.idx = String(state.dataView.items.indexOf(it));
    check.dataset.ridx = String(ridx);
    check.checked = !!r._sel;
    check.title = '勾选导出该条评价';
    const nick = document.createElement('b');
    nick.textContent = r.nickname || '匿名用户';
    const stars = document.createElement('span');
    stars.className = 'data-review-stars';
    stars.textContent = r.rating ? `★ ${r.rating} / 5` : '';
    const badge = document.createElement('span');
    badge.className = `data-review-badge${r.verifiedPurchase ? ' ok' : ''}`;
    badge.textContent = r.verifiedPurchase ? '已确认收货' : '未确认';
    head.append(check, nick, stars, badge);

    // 字段行（§10.3：地区/时间/购买商品型号/收货状态/点赞量）
    const fields = [
      ['地区', r.region],
      ['时间', r.reviewedAt || r.reviewedAtText],
      ['购买型号', r.variant],
      ['点赞量', r.helpfulCount ? String(r.helpfulCount) : '0'],
    ];
    const dl = document.createElement('div');
    dl.className = 'data-review-fields';
    fields.forEach(([k, v]) => {
      if (!v) return;
      const row = document.createElement('div');
      row.className = 'data-review-field';
      const kt = document.createElement('span');
      kt.className = 'data-review-fkey';
      kt.textContent = k;
      const vt = document.createElement('span');
      vt.textContent = v;
      row.append(kt, vt);
      dl.appendChild(row);
    });

    // 内容：100 字内直接展示，超出收缩，可展开/收起查看全部
    const content = document.createElement('p');
    content.className = 'data-review-content';
    const full = [r.title, r.content].filter(Boolean).join('：') || '—';
    if (full.length > 100 && !r._expanded) {
      content.textContent = `${full.slice(0, 100)}…`;
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'data-expand-btn data-review-more';
      more.textContent = '展开全部';
      more.addEventListener('click', () => {
        r._expanded = true;
        renderDataView();
      });
      content.appendChild(document.createElement('br'));
      content.appendChild(more);
    } else {
      content.textContent = full;
      if (r._expanded && full.length > 100) {
        const less = document.createElement('button');
        less.type = 'button';
        less.className = 'data-expand-btn data-review-more';
        less.textContent = '收起';
        less.addEventListener('click', () => {
          r._expanded = false;
          renderDataView();
        });
        content.appendChild(document.createElement('br'));
        content.appendChild(less);
      }
    }

    item.append(head, dl, content);
    if (r.images && r.images.length) {
      const imgs = document.createElement('div');
      imgs.className = 'data-review-imgs';
      imgs.appendChild(Object.assign(document.createElement('span'), {
        className: 'data-review-fkey', textContent: '图片',
      }));
      r.images.forEach((src) => {
        const a = document.createElement('a');
        // 缩略 URL 去掉 ._SY88 等缩放段得到原图，点击新标签打开
        a.href = src.replace(/\._[A-Z0-9,]+_\./, '.');
        a.target = '_blank'; a.rel = 'noopener';
        const img = document.createElement('img');
        img.src = src; img.loading = 'lazy'; img.alt = '评价图片';
        a.appendChild(img);
        imgs.appendChild(a);
      });
      item.appendChild(imgs);
    }
    if (r.videos && r.videos.length) {
      const vids = document.createElement('div');
      vids.className = 'data-review-imgs';
      vids.appendChild(Object.assign(document.createElement('span'), {
        className: 'data-review-fkey', textContent: '视频',
      }));
      r.videos.forEach((src) => {
        const v = document.createElement('video');
        v.src = src; v.controls = true; v.preload = 'metadata';
        vids.appendChild(v);
      });
      item.appendChild(vids);
    }
    list.appendChild(item);
  });

  toggle.addEventListener('click', () => {
    it.showReviews = !it.showReviews;
    list.hidden = !it.showReviews;
    toggle.textContent = `评价（${reviews.length}）${it.showReviews ? '▲' : '▼'}`;
  });
  section.append(headRow, list);
  if (selAll) headRow.appendChild(selAll);
  headRow.appendChild(toggle);
  return section;
}

function renderDataView() {
  if (!state.dataView.open) return;
  const items = state.dataView.items;
  $('data-tables').innerHTML = '';
  $('data-empty').hidden = items.length > 0;
  $('data-check-all').checked = items.length > 0 && items.every((it) => it.selected);

  const done = items.filter((it) => it.status === 'done').length;
  $('data-status').textContent = state.dataView.loading
    ? `获取中…（${done}/${items.length}）`
    : `共 ${items.length} 个商品，已获取 ${done}`;
  $('data-fetch').disabled = state.dataView.loading;
  $('data-fetch').querySelector('.spinner').hidden = !state.dataView.loading;

  items.forEach((it, idx) => $('data-tables').appendChild(renderProductCard(it, idx)));
  updateExportReviewsBtn();
}

/* ---------- 导出（Excel/JSON 双格式；ExcelJS 加载失败时回退 JSON） ---------- */

// 导出格式（顶部下拉：Excel / JSON）
function exportFormat() {
  return $('data-export-format') ? $('data-export-format').value : 'xlsx';
}

// 收集导出商品；若存在勾选的评价，则评价只导出勾选的部分
function collectExportProducts(all) {
  const items = state.dataView.items.filter((it) => (all || it.selected) && it.detail);
  const anySel = items.some((it) => Array.isArray(it.detail?.reviews) && it.detail.reviews.some((r) => r._sel));
  return items.map((it) => {
    const d = it.detail;
    return {
      detail: d,
      reviews: Array.isArray(d.reviews)
        ? d.reviews.filter((r) => !anySel || r._sel)
        : [],
    };
  });
}

// 经本地解析服务代理下载图片（跨域限制），返回 {url: {b64, contentType}}
async function fetchMedia(urls) {
  const map = {};
  const uniq = [...new Set(urls)].slice(0, 60);
  for (let i = 0; i < uniq.length; i += 30) {
    try {
      const r = await apiPost('/api/v1/media', { urls: uniq.slice(i, i + 30) });
      Object.assign(map, r.images || {});
    } catch (e) { /* 代理失败时该批图片跳过 */ }
  }
  return map;
}

function imgExt(contentType, url) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('gif')) return 'gif';
  if (/\.png(\?|$)/.test(url)) return 'png';
  if (/\.gif(\?|$)/.test(url)) return 'gif';
  return 'jpeg';
}

// 每条评价一行，图片按 80px 嵌入「图片」列
function addReviewRows(wb, ws, products, media) {
  products.forEach((p) => {
    p.reviews.forEach((r) => {
      const row = ws.addRow({
        p: p.productTitle || p.productExternalId,
        n: r.nickname || '匿名用户',
        s: r.rating ? `${r.rating} / 5` : '',
        r2: r.region || '',
        t: r.reviewedAt || r.reviewedAtText || '',
        v: r.variant || '',
        vp: r.verifiedPurchase ? '已确认收货' : '未确认',
        h: r.helpfulCount || 0,
        c: [r.title, r.content].filter(Boolean).join('：') || '',
        iu: (r.images || []).join('\n'),
        vu: (r.videos || []).join('\n'),
      });
      const imgs = (r.images || []).slice(0, 4);
      if (imgs.length) row.height = 130; // 2×2 嵌图所需行高
      row.alignment = { wrapText: true, vertical: 'top' }; // 内容自动换行，防列过宽
      // 评论图 2×2 排布在最后一列（评论图）内
      const imgCol = ws.columnCount - 1;
      imgs.forEach((u, i) => {
        const m = media[u];
        if (!m) return;
        const ext = imgExt(m.contentType, u);
        if (!['jpeg', 'png', 'gif'].includes(ext)) return;
        const id = wb.addImage({ base64: m.b64, extension: ext });
        ws.addImage(id, {
          tl: { col: imgCol + (i % 2) * 2.2, row: (row.number - 1) + Math.floor(i / 2) * 1.5 },
          ext: { width: 80, height: 80 },
          editAs: 'oneCell',
        });
      });
    });
  });
}

async function exportSelectedReviews() {
  const out = [];
  state.dataView.items.forEach((it) => {
    if (!Array.isArray(it.detail?.reviews)) return;
    const sel = it.detail.reviews.filter((r) => r._sel);
    if (sel.length) out.push({ productExternalId: it.detail.externalId, productTitle: it.detail.title, reviews: sel });
  });
  if (!out.length) {
    showToast('info', '请先在评价区勾选要导出的评价');
    return;
  }
  if (exportFormat() === 'json' || !window.ExcelJS) {
    exportPayloadJson({ products: out }, 'reviews');
    return;
  }
  const wb = new ExcelJS.Workbook();
  const hasVideo = out.some((p) => p.reviews.some((r) => r.videos && r.videos.length));
  const ws = addReviewsSheet(wb, hasVideo);
  const urls = [];
  out.forEach((p) => p.reviews.forEach((r) => (r.images || []).forEach((u) => urls.push(u))));
  const media = await fetchMedia(urls);
  addReviewRows(wb, ws, out, media);
  await downloadXlsx(wb, 'reviews', `已导出 ${out.reduce((n, p) => n + p.reviews.length, 0)} 条评价`);
}

// 评价工作表（统一列定义）；图片列固定在最后；无视频时不设视频URL列
function addReviewsSheet(wb, hasVideo) {
  const ws = wb.addWorksheet('评价');
  const cols = [
    { header: '商品', key: 'p' }, { header: '昵称', key: 'n' }, { header: '星级', key: 's' },
    { header: '地区', key: 'r2' }, { header: '时间', key: 't' }, { header: '购买型号', key: 'v' },
    { header: '收货状态', key: 'vp' }, { header: '点赞量', key: 'h' }, { header: '内容', key: 'c' },
    { header: '评论图URL', key: 'iu' },
  ];
  if (hasVideo) cols.push({ header: '视频URL', key: 'vu' });
  cols.push({ header: '评论图', key: 'img' }); // 嵌图列放最后
  ws.columns = cols;
  ws.getColumn(9).width = 60;
  ws.getColumn(ws.columnCount - 1).width = 36; // 评论图列
  ws.getRow(1).font = { bold: true };
  return ws;
}

async function exportDataView(all) {
  const collected = collectExportProducts(all);
  if (!collected.length) {
    showToast('info', all ? '暂无可导出的数据，请先获取' : '请先勾选要导出的商品');
    return;
  }
  const fmt = exportFormat();
  if (fmt === 'json' || !window.ExcelJS) {
    exportPayloadJson({
      products: collected.map(({ detail, reviews }) => ({ ...detail, reviews })),
    }, 'products');
    return;
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('商品');
  ws.columns = [
    { header: '商品名称', key: '商品名称' }, { header: '商品 ID', key: '商品ID' }, { header: '价格', key: '价格' },
    { header: '评分', key: '评分' }, { header: '品牌', key: '品牌' }, { header: '型号', key: '型号' },
    { header: '商品链接', key: '商品链接' }, { header: '采集时间', key: '采集时间' },
    { header: '参考图URL', key: '参考图URL' },
    { header: '参考图', key: '参考图' }, // 嵌图列放最后
  ];
  ws.getColumn(1).width = 40;
  ws.getColumn(7).width = 30;
  ws.getColumn(9).width = 42;
  ws.getColumn(10).width = 30;
  ws.getRow(1).font = { bold: true };
  const urls = [];
  collected.forEach(({ detail }) => (detail.referenceImages || []).forEach((img) => urls.push(img.url)));
  const media = await fetchMedia(urls);
  // 评价表（只含勾选商品的评价；若存在勾选评价则仅导出勾选部分）；有视频才有视频URL列
  const hasVideo = collected.some(({ reviews }) => reviews.some((r) => r.videos && r.videos.length));
  let ws2 = null;
  if (collected.some(({ reviews }) => reviews.length)) ws2 = addReviewsSheet(wb, hasVideo);
  const revUrls = [];
  collected.forEach(({ reviews }) => reviews.forEach((r) => (r.images || []).forEach((u) => revUrls.push(u))));
  const revMedia = await fetchMedia(revUrls);
  addReviewRows(wb, ws2, collected.map(({ detail, reviews }) => ({
    productExternalId: detail.externalId, productTitle: detail.title, reviews,
  })).filter((p) => p.reviews.length), revMedia);
  for (const { detail, reviews } of collected) {
    const d = detail;
    const row = ws.addRow({
      商品名称: d.title || '', 商品ID: d.externalId || '',
      价格: d.price ? `${d.price.amount} ${d.price.currency}` : '',
      评分: d.rating ? `${d.rating.value} / ${d.rating.scale}` : '',
      品牌: d.brand || '', 型号: d.model || '', 商品链接: d.url || '', 采集时间: d.collectedAt || '',
      参考图URL: (d.referenceImages || []).map((i) => i.url).join('\n'),
    });
    row.alignment = { wrapText: true, vertical: 'top' };
    const refImgs = (d.referenceImages || []).slice(0, 4);
    if (refImgs.length) row.height = refImgs.length > 2 ? 130 : 72;
    refImgs.forEach((img, i) => {
      const m = media[img.url];
      if (!m) return;
      const ext = imgExt(m.contentType, img.url);
      if (!['jpeg', 'png', 'gif'].includes(ext)) return;
      const id = wb.addImage({ base64: m.b64, extension: ext });
      // 参考图 2×2 排布在最后一列（参考图）内
      const imgCol = ws.columnCount - 1;
      ws.addImage(id, {
        tl: { col: imgCol + (i % 2) * 2.4, row: (row.number - 1) + Math.floor(i / 2) * 1.5 },
        ext: { width: 90, height: 90 },
        editAs: 'oneCell',
      });
    });
  }
  await downloadXlsx(wb, 'products', `已导出 ${collected.length} 个商品数据`);
}

async function downloadXlsx(wb, tag, msg) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.dataView.platform}-${tag}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('success', msg);
}

// JSON 兜底（ExcelJS 未加载成功时）
function exportPayloadJson(payload, tag) {
  const blob = new Blob([JSON.stringify(payload, (k, v) => (k.startsWith('_') ? undefined : v), 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.dataView.platform}-${tag}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('info', exportFormat() === 'json' ? '已导出 JSON' : 'Excel 组件未加载，已导出 JSON');
}

// 是否有勾选的评价 → 控制「导出所选评价」按钮可用性
function updateExportReviewsBtn() {
  const any = state.dataView.items.some(
    (it) => Array.isArray(it.detail?.reviews) && it.detail.reviews.some((r) => r._sel));
  $('data-export-reviews').disabled = !any;
}

/* ---------- 数据详情事件 ---------- */

$('btn-open-data').addEventListener('click', openDataView);
$('data-back').addEventListener('click', closeDataView);
$('data-fetch').addEventListener('click', fetchDetails);
$('data-export-selected').addEventListener('click', () => exportDataView(false));
$('data-export-all').addEventListener('click', () => exportDataView(true));
$('data-export-reviews').addEventListener('click', exportSelectedReviews);

$('data-check-all').addEventListener('change', (e) => {
  state.dataView.items.forEach((it) => { it.selected = e.target.checked; });
  renderDataView();
});

$('data-tables').addEventListener('change', (e) => {
  if (e.target.matches('.data-review-all')) {
    // 评价全选：勾选/取消该商品全部评价
    const it = state.dataView.items[Number(e.target.dataset.idx)];
    it.detail.reviews.forEach((r) => { r._sel = e.target.checked; });
    renderDataView();
    return;
  }
  if (e.target.matches('.data-review-check')) {
    // 单条评价勾选：记录在该评价对象上（导出时剔除运行态字段）
    const it = state.dataView.items[Number(e.target.dataset.idx)];
    it.detail.reviews[Number(e.target.dataset.ridx)]._sel = e.target.checked;
    updateExportReviewsBtn();
    return;
  }
  if (!e.target.matches('input[type="checkbox"]')) return;
  state.dataView.items[Number(e.target.dataset.idx)].selected = e.target.checked;
  renderDataView();
});
