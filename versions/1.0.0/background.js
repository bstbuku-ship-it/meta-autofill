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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'get-bundled-config') return;
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: '非法消息来源' });
    return;
  }

  fetch(chrome.runtime.getURL('meta-autofill-config.json'), { cache: 'no-store' })
    .then(async res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('配置文件格式无效');
      }
      sendResponse({ ok: true, data });
    })
    .catch(() => {
      // 配置文件缺失或损坏时使用空配置，保证插件仍可打开。
      sendResponse({ ok: true, data: EMPTY_CONFIG });
    });

  return true;
});
