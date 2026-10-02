(async () => {
  if (window.top !== window || document.getElementById('af-host')) return;

  /* ---------- 默认预设：来自扩展内的 meta-autofill-config.json ---------- */
  // 配置文件是“源默认值”；用户在面板中修改的内容只保存到当前浏览器的 chrome.storage.local，
  // 不会改写扩展内的 JSON。这样以后同步默认配置时只需要维护一个文件。
  const EMPTY_CONFIG = {
    version: 2,
    metaLanguage: 'zh-CN',
    comment: {
      name: '',
      channels: { Messenger: false, Instagram: false },
      keywords: [],
      message: '',
      commentReply: ''
    },
    keyword: {
      name: '',
      channels: { Messenger: false, Instagram: false },
      keywords: [],
      message: '',
      buttonLabel: '',
      buttonUrl: ''
    }
  };

  async function loadBundledConfig() {
    try {
      const data = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'get-bundled-config' }, response => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          if (!response || response.ok !== true) return reject(new Error(response?.error || '读取配置失败'));
          resolve(response.data);
        });
      });
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('配置文件格式无效');
      return merge(EMPTY_CONFIG, data);
    } catch (_) {
      // 配置文件缺失/损坏时不阻止插件运行，使用空配置。
      return clone(EMPTY_CONFIG);
    }
  }

  const FIELDS = {
    comment: [
      ['name', '名称', 'input'],
      ['keywords', '关键词（每行一个，最多 10 个）', 'area'],
      ['message', '私信正文（{全名} 标记变量位置，不会自动插入，需手动添加）', 'area'],
      ['commentReply', '评论回复（留空 = 清空页面上的默认文字）', 'input']
    ],
    keyword: [
      ['name', '名称', 'input'],
      ['keywords', '关键词（每行一个，最多 5 个）', 'area'],
      ['message', '发消息正文（{全名} 标记变量位置，不会自动插入，需手动添加）', 'area'],
      ['buttonLabel', '按钮标签', 'input'],
      ['buttonUrl', '网址', 'input']
    ]
  };
  const MODULE_NAMES = { comment: '消息回复评论', keyword: '关键词回复' };

  /* ---------- 存储 ---------- */
  const store = {
    get: k => new Promise(r => chrome.storage.local.get(k, v => r(v[k]))),
    set: (k, v) => new Promise(r => chrome.storage.local.set({ [k]: v }, r))
  };
  const clone = o => JSON.parse(JSON.stringify(o));
  const MAX_CONFIG_BYTES = 100 * 1024;
  const LIMITS = {
    comment: { keywords: 10, keywordLength: 100, name: 100, message: 10000, commentReply: 5000, buttonLabel: 200, buttonUrl: 2048 },
    keyword: { keywords: 5, keywordLength: 100, name: 100, message: 10000, commentReply: 5000, buttonLabel: 200, buttonUrl: 2048 }
  };

  function merge(base, extra) {
    const out = clone(base);
    if (extra && ['zh-CN', 'zh-TW', 'en', 'auto'].includes(extra.metaLanguage)) {
      out.metaLanguage = extra.metaLanguage;
    }
    for (const m of ['comment', 'keyword']) {
      const src = extra && extra[m];
      if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
      const limit = LIMITS[m];
      for (const k of Object.keys(out[m])) {
        if (src[k] === undefined) continue;
        if (k === 'channels') {
          if (!src.channels || typeof src.channels !== 'object' || Array.isArray(src.channels)) continue;
          for (const channel of ['Messenger', 'Instagram']) {
            if (typeof src.channels[channel] === 'boolean') out[m].channels[channel] = src.channels[channel];
          }
        } else if (Array.isArray(out[m][k])) {
          if (!Array.isArray(src[k]) || src[k].length > limit.keywords) continue;
          const values = src[k].filter(v => typeof v === 'string' && v.length <= limit.keywordLength);
          if (values.length === src[k].length) out[m][k] = values;
        } else if (typeof out[m][k] === 'string') {
          if (typeof src[k] === 'string' && src[k].length <= (limit[k] || 10000)) out[m][k] = src[k];
        }
      }
    }
    return out;
  }

  function configByteLength(value) {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }

  /* ---------- DOM 工具 ---------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const txt = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  async function waitFor(fn, timeout = 4000, step = 100) {
    const t = Date.now();
    while (Date.now() - t < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  const TEXT_INPUT =
    'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]):not([type=button]):not([type=submit]), textarea';
  const EDITABLE = '[contenteditable="true"], [contenteditable="plaintext-only"], textarea';
  const ANY_FIELD = TEXT_INPUT + ', [contenteditable="true"], [contenteditable="plaintext-only"]';
  const TABBABLE =
    'a[href],button,input:not([type=hidden]),select,textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[role=textbox],[tabindex]';

  /* ---------- Meta 页面语言 ---------- */
  // 默认固定为简体中文；用户可以在设置中改成繁体、英文或“自动识别”。
  // 自动识别优先看 document.lang，再用页面可见文字做轻量评分；识别不到时回退简体中文。
  const LANGUAGE_LABELS = {
    'zh-CN': {
      name: ['名称'],
      applicable: ['适用情况'],
      commentReply: ['评论回复'],
      privateMessage: ['私信', '消息'],
      sendMessage: ['发消息'],
      buttonLabel: ['按钮标签'],
      url: ['网址'],
      button: ['按钮'],
      messenger: ['Messenger'],
      instagram: ['Instagram']
    },
    'zh-TW': {
      name: ['名稱'],
      applicable: ['適用情況'],
      commentReply: ['評論回覆', '留言回覆'],
      privateMessage: ['私訊', '訊息'],
      sendMessage: ['發消息', '發送訊息', '傳送訊息'],
      buttonLabel: ['按鈕標籤'],
      url: ['網址'],
      button: ['按鈕'],
      messenger: ['Messenger'],
      instagram: ['Instagram']
    },
    en: {
      name: ['Name'],
      applicable: ['When it applies', 'When this applies', 'Applies to'],
      commentReply: ['Comment reply', 'Reply to comment', 'Comment reply text'],
      privateMessage: ['Private message', 'Message'],
      sendMessage: ['Send message', 'Send a message'],
      buttonLabel: ['Button label'],
      url: ['URL', 'Website'],
      button: ['Button'],
      messenger: ['Messenger'],
      instagram: ['Instagram']
    }
  };

  function detectMetaLanguage() {
    const lang = (document.documentElement.lang || document.querySelector('html')?.getAttribute('lang') || '').toLowerCase();
    if (/^zh-(tw|hk|mo)/.test(lang)) return 'zh-TW';
    if (/^zh/.test(lang)) return 'zh-CN';
    if (/^(en)(-|$)/.test(lang)) return 'en';

    const sample = (document.body?.innerText || '').slice(0, 120000);
    const scores = { 'zh-CN': 0, 'zh-TW': 0, en: 0 };
    for (const t of LANGUAGE_LABELS['zh-CN'].name.concat(LANGUAGE_LABELS['zh-CN'].applicable, LANGUAGE_LABELS['zh-CN'].sendMessage)) if (sample.includes(t)) scores['zh-CN']++;
    for (const t of LANGUAGE_LABELS['zh-TW'].name.concat(LANGUAGE_LABELS['zh-TW'].applicable, LANGUAGE_LABELS['zh-TW'].sendMessage)) if (sample.includes(t)) scores['zh-TW']++;
    for (const t of LANGUAGE_LABELS.en.name.concat(LANGUAGE_LABELS.en.applicable, LANGUAGE_LABELS.en.sendMessage)) if (sample.includes(t)) scores.en++;
    return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][1] > 0
      ? Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0]
      : 'zh-CN';
  }

  function activeLanguage() {
    return cfg?.metaLanguage === 'auto' ? detectMetaLanguage() : (LANGUAGE_LABELS[cfg?.metaLanguage] ? cfg.metaLanguage : 'zh-CN');
  }

  function labelsFor(key) {
    const lang = activeLanguage();
    return LANGUAGE_LABELS[lang][key] || [];
  }

  function allLanguageLabels(key) {
    const seen = new Set();
    return ['zh-CN', 'zh-TW', 'en'].flatMap(lang => LANGUAGE_LABELS[lang][key] || []).filter(t => !seen.has(t) && seen.add(t));
  }

  function languageLabel(key) {
    // 手动指定语言时只使用该语言；自动模式先检测语言后再使用对应标签。
    // 不把三种语言全部混合搜索，避免同一页面出现相同/相近文本时定位到错误容器。
    return labelsFor(key);
  }

  // 按文字找最内层元素
  function findLabel(t, { prefix = false, root = document.body } = {}) {
    const all = [...root.querySelectorAll('*')].filter(e => {
      if (e.children.length > 3 || !visible(e)) return false;
      const s = txt(e);
      return prefix ? s.startsWith(t) && s.length < t.length + 14 : s === t;
    });
    // 返回最内层的精确文字元素。不要改成判断父元素，否则会选中外层容器，
    // Meta 的动态表单会因此找不到后面的输入框（尤其是私信/评论富文本框）。
    return all.filter(e => !all.some(o => o !== e && e.contains(o)));
  }

  function findLabelAny(keyOrTexts, opts = {}) {
    const texts = Array.isArray(keyOrTexts) ? keyOrTexts : languageLabel(keyOrTexts);
    for (const t of texts) {
      const hits = findLabel(t, opts);
      if (hits.length) return hits;
    }
    return [];
  }

  // 找标签之后（文档顺序）的第一个控件
  function fieldAfter(label, sel) {
    let n = label;
    for (let i = 0; i < 8; i++) {
      n = n.parentElement;
      if (!n || n === document.body) break;
      const f = [...n.querySelectorAll(sel)].filter(
        e => visible(e) && !label.contains(e) && label.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (f.length) return f[0];
    }
    return null;
  }

  // 找标签之前最近的控件（复选框 / 单选框）
  function controlBefore(label, sel) {
    let n = label;
    for (let i = 0; i < 5; i++) {
      n = n.parentElement;
      if (!n || n === document.body) break;
      const f = [...n.querySelectorAll(sel)].filter(
        e => !e.contains(label) && label.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING
      );
      if (f.length) return f[f.length - 1];
    }
    return null;
  }

  function setValue(el, v) {
    if (el.matches('input,textarea')) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, v);
    }
  }

  function caretEnd(ed) {
    ed.focus();
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  /* ---------- 稳健写入（针对 Meta 的富文本框：只改 DOM 页面不认，必须让编辑器自己"收到"输入） ---------- */
  const isNative = el => el.matches('input,textarea');
  const readValue = el => (isNative(el) ? el.value : el.textContent) || '';
  const clean = s => s.replace(/[\u200b\ufeff]/g, '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const COUNTER = /^\d+\s*\/\s*\d+$/;

  // 读取输入框旁边的字数计数（如 0/1000），用来确认页面真的识别到了内容
  function counterOf(ed) {
    let n = ed;
    for (let i = 0; i < 6; i++) {
      n = n.parentElement;
      if (!n || n === document.body) break;
      const hits = [...n.querySelectorAll('*')].filter(
        e => e.children.length <= 2 && visible(e) && COUNTER.test(txt(e))
      );
      if (hits.length) {
        const top = ed.getBoundingClientRect().top;
        hits.sort(
          (a, b) => Math.abs(a.getBoundingClientRect().top - top) - Math.abs(b.getBoundingClientRect().top - top)
        );
        return parseInt(txt(hits[0]), 10);
      }
    }
    return null;
  }

  async function landed(ed, want, timeout = 1200) {
    const w = clean(want);
    const t0 = Date.now();
    do {
      const got = clean(readValue(ed));
      const cnt = counterOf(ed);
      const textOk = w ? got.includes(w.slice(0, 12)) && got.length >= w.length * 0.9 : got === '';
      const cntOk = cnt === null ? true : w ? cnt > 0 && cnt >= want.length * 0.6 : cnt === 0;
      if (textOk && cntOk) return true;
      await sleep(100);
    } while (Date.now() - t0 < timeout);
    return false;
  }

  function selectAllIn(ed) {
    ed.focus();
    const r = document.createRange();
    r.selectNodeContents(ed);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  const bi = (ed, inputType, data) =>
    ed.dispatchEvent(new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true, composed: true }));

  // 依次尝试，每种都先全选再写入（会替换原内容），写完核对计数，不认就换下一种
  const PUT = [
    ['模拟粘贴', (ed, t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }],
    ['模拟输入', (ed, t) => bi(ed, 'insertText', t)],
    ['execCommand', (ed, t) => document.execCommand('insertText', false, t)]
  ];
  const DEL = [
    ['模拟删除', ed => bi(ed, 'deleteContentBackward')],
    ['execCommand', () => document.execCommand('delete')],
    ['模拟退格', ed => {
      for (const type of ['keydown', 'keyup'])
        ed.dispatchEvent(new KeyboardEvent(type, { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true }));
    }]
  ];

  async function writeEditable(ed, text) {
    ed.scrollIntoView({ block: 'center' });
    for (const [name, fn] of text ? PUT : DEL) {
      selectAllIn(ed);
      await sleep(60);
      try { fn(ed, text); } catch (e) { /* 换下一种 */ }
      if (await landed(ed, text)) return name;
    }
    return null;
  }

  // 统一入口：普通 input/textarea 直接赋值；富文本框走上面的多种方式
  async function writeField(el, text) {
    if (isNative(el)) {
      el.focus();
      setValue(el, text);
      await sleep(120);
      if (el.value !== text) throw new Error('输入框没有接受内容');
      return '直接赋值';
    }
    const how = await writeEditable(el, text);
    if (how) return how;
    if (text) {
      try { await navigator.clipboard.writeText(text); } catch (e) { /* 剪贴板不可用就算了 */ }
      throw new Error('页面没有识别到脚本输入，文字已复制到剪贴板，请点进该框按 Ctrl+V 粘贴');
    }
    throw new Error('没能清空，请点进该框按 Ctrl+A 再按 Delete');
  }

  // 模拟"按 Tab 键"：从某个元素往后，按 Tab 顺序数到第一个能输入文字的框
  function byTab(from, maxSteps = 8) {
    const after = [...document.querySelectorAll(TABBABLE)].filter(
      e =>
        visible(e) &&
        !e.disabled &&
        e.getAttribute('tabindex') !== '-1' &&
        !e.contains(from) &&
        !from.contains(e) &&
        from.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    for (let k = 0; k < Math.min(after.length, maxSteps); k++) {
      if (after[k].matches(ANY_FIELD)) return { el: after[k], steps: k + 1 };
    }
    return null;
  }

  /* ---------- 各字段的填写 ---------- */
  async function fillByLabel(labelText, value, opts) {
    const sel = (opts && opts.sel) || TEXT_INPUT;
    const labels = findLabelAny(labelText, opts);
    const el = labels.map(l => fieldAfter(l, sel)).find(Boolean);
    if (!el) throw new Error(`找不到"${labelText}"输入框`);
    el.scrollIntoView({ block: 'center' });
    await writeField(el, value);
    if (isNative(el)) el.blur();
  }

  // 评论回复：先按标签找；找不到就从私信框往后"按 Tab"数过去。留空 = 清空框内文字
  async function fillCommentReply(value) {
    let el = findLabelAny('commentReply', { prefix: true }).map(l => fieldAfter(l, ANY_FIELD)).find(Boolean);
    let via = '按标签定位';
    if (!el) {
      const msg = messageEditor('privateMessage');
      const hit = msg && byTab(msg);
      if (hit) { el = hit.el; via = `从私信框按 Tab ${hit.steps} 次定位`; }
    }
    if (!el) throw new Error('找不到"评论回复"输入框');
    el.scrollIntoView({ block: 'center' });
    const how = await writeField(el, value);
    el.blur();
    return `${value ? '已写入' : '已清空'}（${via}；${how}）`;
  }

  function channelAliases(name) {
    const key = name === 'Messenger' ? 'messenger' : 'instagram';
    return languageLabel(key).concat([name]);
  }

  function findChannelControl(name) {
    const aliases = [...new Set(channelAliases(name))];
    const controls = [...document.querySelectorAll('input[type=checkbox],[role=checkbox],[role=switch],[aria-checked]')].filter(visible);
    for (const control of controls) {
      const candidates = [
        control.getAttribute('aria-label'),
        control.getAttribute('title'),
        control.getAttribute('data-testid'),
        control.parentElement ? txt(control.parentElement) : '',
        control.closest('label') ? txt(control.closest('label')) : ''
      ].filter(Boolean);
      if (candidates.some(text => aliases.some(alias => text === alias || text.includes(alias)))) return control;
    }
    for (const alias of aliases) {
      const labels = findLabel(alias);
      for (const label of labels) {
        const direct = label.querySelector('input[type=checkbox],[role=checkbox],[role=switch],[aria-checked]');
        if (direct) return direct;
        const before = controlBefore(label, 'input[type=checkbox],[role=checkbox],[role=switch],[aria-checked]');
        if (before) return before;
        const after = fieldAfter(label, 'input[type=checkbox],[role=checkbox],[role=switch],[aria-checked]');
        if (after) return after;
      }
    }
    return null;
  }

  async function setChannel(name, want) {
    const cb = findChannelControl(name);
    if (!cb) {
      if (want) throw new Error(`找不到"${name}"复选框（当前语言：${activeLanguage()}）`);
      return;
    }
    const on = cb.checked === true || cb.getAttribute('aria-checked') === 'true';
    if (on !== want) {
      cb.click();
      await sleep(150);
    }
  }

  async function addKeywords(list) {
    const heading = findLabelAny('applicable')[0];
    if (!heading) throw new Error('找不到"适用情况"区域');
    const field = fieldAfter(heading, TEXT_INPUT + ', ' + EDITABLE);
    if (!field) throw new Error('找不到关键词输入框');
    field.scrollIntoView({ block: 'center' });
    for (const kw of list) {
      field.focus();
      setValue(field, kw);
      await sleep(80);
      for (const type of ['keydown', 'keypress', 'keyup']) {
        field.dispatchEvent(
          new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
        );
      }
      await sleep(180);
    }
    if (field.matches('input,textarea') && field.value) {
      throw new Error('关键词没有变成标签（输入框里还有残留文字），请手动按回车确认');
    }
  }

  function messageEditor(headingText) {
    return findLabelAny(headingText).map(h => fieldAfter(h, EDITABLE)).find(Boolean) || null;
  }

  async function fillMessage(headingText, msg) {
    const ed = messageEditor(headingText);
    if (!ed) throw new Error('找不到对应的消息文字框（当前支持简体中文、繁体中文和英文）');
    // 变量不自动插入：去掉 {全名} 等标记，写入其余文字，并把光标停在第一个变量的位置
    const re = /\{(?:全名|名字|姓氏)\}/g;
    const first = msg.search(re);
    const pre = first < 0 ? msg : msg.slice(0, first);
    const post = first < 0 ? '' : msg.slice(first).replace(re, '');
    const how = await writeField(ed, pre + post);
    if (first < 0 || isNative(ed)) return `写入方式：${how}`;
    try {
      caretEnd(ed);
      const n = [...new Intl.Segmenter().segment(post)].length;
      const sel = getSelection();
      for (let i = 0; i < n; i++) sel.modify('move', 'backward', 'character');
      return `光标已停在变量位置，请手动添加变量（写入方式：${how}）`;
    } catch (e) {
      return `文字已写入，请手动在正确位置添加变量（写入方式：${how}）`;
    }
  }

  async function fillButton(label, url) {
    let lab = findLabelAny('buttonLabel')[0];
    if (!lab) {
      const b = [...document.querySelectorAll('button,[role=button]')].filter(visible).find(x => txt(x) === '按钮');
      if (!b) throw new Error('找不到"按钮"添加入口');
      b.scrollIntoView({ block: 'center' });
      b.click();
      lab = await waitFor(() => findLabelAny('buttonLabel')[0], 3000);
      if (!lab) throw new Error('点击"按钮"后没有出现按钮标签输入框');
    }
    await fillByLabel('buttonLabel', label);
    await fillByLabel('url', url);
  }

  /* ---------- 面板 ---------- */
  const bundledConfig = await loadBundledConfig();
  let cfg = merge(bundledConfig, await store.get('af_cfg'));
  const ui = Object.assign({ x: null, y: 120, collapsed: true }, await store.get('af_ui'));
  let tab = 'comment';

  const host = document.createElement('div');
  host.id = 'af-host';
  host.style.cssText = 'position:fixed;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  *{box-sizing:border-box;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
  .dot{width:44px;height:44px;border-radius:50%;background:#12263A;display:grid;place-items:center;cursor:pointer;box-shadow:0 2px 10px #0006;user-select:none;transition:transform .15s}
  .dot:hover{transform:scale(1.08)}
  .dot svg{width:28px;height:28px;display:block}
  .panel{width:320px;background:#fff;color:#1c2b33;border:1px solid #cfd8de;border-radius:10px;box-shadow:0 6px 24px #0003;overflow:hidden;font-size:13px}
  .hd{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#0b57a4;color:#fff;cursor:move;user-select:none;font-weight:600}
  .ic{background:none;border:0;color:#fff;font-size:16px;cursor:pointer;padding:0 6px}
  .bd{padding:10px;display:flex;flex-direction:column;gap:8px;max-height:78vh;overflow:auto}
  button.pri{padding:9px;border:0;border-radius:6px;background:#0b57a4;color:#fff;font-size:14px;cursor:pointer}
  button.pri:disabled{background:#8fa7bd;cursor:wait}
  .log{min-height:38px;max-height:150px;overflow:auto;background:#f3f6f8;border-radius:6px;padding:6px 8px;font-size:12px;line-height:1.55}
  .log .ok{color:#1b7a3d}.log .err{color:#b3261e}
  .set[hidden]{display:none}
  .set{border-top:1px solid #dde4e8;padding-top:8px;display:flex;flex-direction:column;gap:6px}
  .tabs{display:flex;gap:4px}
  .tabs button{flex:1;padding:6px;border:1px solid #cfd8de;background:#fff;border-radius:6px;cursor:pointer}
  .tabs button.on{background:#e6f0fa;border-color:#0b57a4;color:#0b57a4;font-weight:600}
  .set label{font-size:12px;color:#51636d;margin-top:2px}
  .set input:not([type=checkbox]),.set textarea,.set select{width:100%;padding:6px;border:1px solid #cfd8de;border-radius:6px;font-size:12px;background:#fff}
  .ch{display:flex;gap:14px;font-size:12px}
  .row{display:flex;gap:6px;flex-wrap:wrap}
  .row button{flex:1;padding:6px;border:1px solid #cfd8de;background:#fff;border-radius:6px;cursor:pointer;font-size:12px}
</style>
<div class="dot" id="dot" title="Meta-自动化预填助手（点击展开）"><svg viewBox="0 0 155 155"><path d="M29.5 52 L29.5 109 M29.5 52 L64.5 83 L99.5 52 M99.5 52 L99.5 109" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/><path d="M122 53 L122 105" stroke="#FFB020" stroke-width="11" stroke-linecap="round"/></svg></div>
<div class="panel" id="panel">
  <div class="hd" id="hd"><span>Meta-自动化预填助手</span><span><button class="ic" id="gear" title="预设与导入导出">⚙</button><button class="ic" id="min" title="隐藏界面">–</button></span></div>
  <div class="bd">
    <button class="pri" id="run-comment">消息回复评论</button>
    <button class="pri" id="run-keyword">自定义关键词回复</button>
    <div class="log" id="log">选择板块后点击对应按钮。只填内容，不会保存。</div>
    <div class="set" id="set" hidden>
      <div class="tabs"><button data-t="comment" class="on">消息回复评论</button><button data-t="keyword">关键词回复</button></div>
      <div id="form"></div>
      <label>Meta 页面语言</label>
      <select id="metaLanguage">
        <option value="zh-CN">简体中文（默认）</option>
        <option value="zh-TW">繁体中文</option>
        <option value="en">English</option>
        <option value="auto">自动识别</option>
      </select>
      <div class="row"><button id="save">保存预设</button><button id="exp">导出</button><button id="imp">导入</button><button id="rst">恢复默认</button></div>
      <input type="file" id="file" accept=".json,application/json" hidden>
    </div>
  </div>
</div>`;
  document.documentElement.appendChild(host);

  const $ = id => root.getElementById(id);
  const logEl = $('log');
  function log(msg, cls = '') {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = msg;
    logEl.append(d);
    while (logEl.children.length > 40) logEl.firstChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* 位置与折叠 */
  function place() {
    if (ui.collapsed) {
      // 隐藏界面：固定在页面最右侧中间的小球，不可拖动，点击展开
      host.style.left = 'auto';
      host.style.right = '10px';
      host.style.top = '50%';
      host.style.transform = 'translateY(-50%)';
    } else {
      if (ui.x === null) ui.x = Math.max(10, innerWidth - 350);
      ui.x = Math.min(Math.max(0, ui.x), innerWidth - 50);
      ui.y = Math.min(Math.max(0, ui.y), innerHeight - 50);
      host.style.right = 'auto';
      host.style.transform = 'none';
      host.style.left = ui.x + 'px';
      host.style.top = ui.y + 'px';
    }
    $('panel').style.display = ui.collapsed ? 'none' : 'block';
    $('dot').style.display = ui.collapsed ? 'grid' : 'none';
  }
  place();
  $('min').onclick = () => { ui.collapsed = true; place(); store.set('af_ui', ui); };
  $('dot').onclick = () => { ui.collapsed = false; place(); store.set('af_ui', ui); };
  $('hd').onmousedown = e => {
    if (e.target.closest('button')) return;
    const dx = e.clientX - ui.x, dy = e.clientY - ui.y;
    const move = ev => { ui.x = ev.clientX - dx; ui.y = ev.clientY - dy; place(); };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); store.set('af_ui', ui); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  };

  /* 预设编辑 */
  function collect() {
    const c = cfg[tab];
    root.querySelectorAll('#form [data-k]').forEach(e => {
      const k = e.dataset.k;
      c[k] = Array.isArray(c[k])
        ? e.value.split('\n').map(s => s.trim()).filter(Boolean)
        : e.value;
    });
    root.querySelectorAll('#form [data-ch]').forEach(e => { c.channels[e.dataset.ch] = e.checked; });
  }
  function renderForm() {
    const c = cfg[tab];
    $('form').innerHTML =
      FIELDS[tab]
        .map(([k, l, t]) => `<label>${l}</label>` + (t === 'area' ? `<textarea data-k="${k}" rows="${k === 'message' ? 7 : 3}"></textarea>` : `<input data-k="${k}">`))
        .join('') +
      `<label>渠道</label><div class="ch"><label><input type="checkbox" data-ch="Messenger"> Messenger</label><label><input type="checkbox" data-ch="Instagram"> Instagram</label></div>`;
    root.querySelectorAll('#form [data-k]').forEach(e => {
      const v = c[e.dataset.k];
      e.value = Array.isArray(v) ? v.join('\n') : v || '';
    });
    root.querySelectorAll('#form [data-ch]').forEach(e => { e.checked = !!c.channels[e.dataset.ch]; });
    $('metaLanguage').value = ['zh-CN', 'zh-TW', 'en', 'auto'].includes(cfg.metaLanguage) ? cfg.metaLanguage : 'zh-CN';
  }
  renderForm();
  $('gear').onclick = () => { $('set').hidden = !$('set').hidden; };
  root.querySelectorAll('.tabs button').forEach(b => {
    b.onclick = () => {
      collect();
      tab = b.dataset.t;
      root.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
      renderForm();
    };
  });
  $('save').onclick = async () => {
    collect();
    cfg.metaLanguage = $('metaLanguage').value;
    await store.set('af_cfg', cfg);
    log(`预设已保存（Meta 页面语言：${cfg.metaLanguage === 'auto' ? '自动识别' : cfg.metaLanguage}）`, 'ok');
  };
  $('rst').onclick = async () => {
    if (!confirm(`把"${MODULE_NAMES[tab]}"恢复为默认预设？`)) return;
    cfg[tab] = clone(bundledConfig[tab]);
    cfg.metaLanguage = bundledConfig.metaLanguage;
    await store.set('af_cfg', cfg);
    renderForm();
    log('已恢复默认', 'ok');
  };
  $('exp').onclick = () => {
    collect();
    cfg.metaLanguage = $('metaLanguage').value;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }));
    a.download = 'meta-autofill-config.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('imp').onclick = () => $('file').click();
  $('file').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      if (f.size > MAX_CONFIG_BYTES) throw new Error('配置文件过大（最大 100 KB）');
      const raw = await f.text();
      if (new TextEncoder().encode(raw).length > MAX_CONFIG_BYTES) {
        throw new Error('配置文件过大（最大 100 KB）');
      }
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data) || (!data.comment && !data.keyword)) {
        throw new Error('文件里没有有效的 comment / keyword 配置');
      }
      const merged = merge(cfg, data);
      if (configByteLength(merged) > MAX_CONFIG_BYTES) throw new Error('配置内容过大（最大 100 KB）');
      cfg = merged;
      await store.set('af_cfg', cfg);
      renderForm();
      log('配置已导入', 'ok');
    } catch (err) {
      log('导入失败：' + err.message, 'err');
    }
  };

  /* 执行 */
  async function step(name, fn) {
    log('… ' + name);
    try {
      const r = await fn();
      log('✓ ' + name + (typeof r === 'string' ? '：' + r : ''), 'ok');
      return true;
    } catch (e) {
      log(`✗ ${name}：${e.message}`, 'err');
      return false;
    }
  }

  async function run(mod) {
    collect();
    cfg.metaLanguage = $('metaLanguage').value;
    await store.set('af_cfg', cfg);
    const c = cfg[mod];
    logEl.textContent = '';
    ['run-comment', 'run-keyword'].forEach(id => ($(id).disabled = true));
    const steps = [
      ['名称', () => fillByLabel('name', c.name)],
      ['渠道', async () => { for (const [n, w] of Object.entries(c.channels)) await setChannel(n, w); }],
      ['关键词', () => addKeywords(c.keywords)]
    ];
    if (mod === 'comment') {
      steps.push(['私信', () => fillMessage('privateMessage', c.message)]);
      steps.push(['评论回复', () => fillCommentReply(c.commentReply)]);
    } else {
      steps.push(['发消息', () => fillMessage('sendMessage', c.message)]);
      steps.push(['按钮', () => fillButton(c.buttonLabel, c.buttonUrl)]);
    }
    let stopped = null;
    for (const [n, f] of steps) {
      if (!(await step(n, f))) { stopped = n; break; }
    }
    log(
      stopped ? `已在"${stopped}"停止，后面的项目没有填，请从这里开始手动操作` : '全部填完，请检查后自行保存',
      stopped ? 'err' : 'ok'
    );
    ['run-comment', 'run-keyword'].forEach(id => ($(id).disabled = false));
  }
  $('run-comment').onclick = () => run('comment');
  $('run-keyword').onclick = () => run('keyword');

  addEventListener('resize', place);

  /* 工具栏弹窗（打开界面 / 隐藏界面）发来的指令 */
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    // 仅接受本扩展自己的消息；即使未来增加其他消息入口，也避免被非预期发送方触发 UI 操作。
    if (!sender || sender.id !== chrome.runtime.id) return;
    if (!msg || msg.type !== 'af-ui' || !['show', 'hide'].includes(msg.action)) return;
    ui.collapsed = msg.action === 'hide';
    place();
    store.set('af_ui', ui);
    reply({ ok: true, collapsed: ui.collapsed });
  });
})();
