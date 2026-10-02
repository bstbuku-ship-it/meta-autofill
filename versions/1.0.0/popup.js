const msgEl = document.getElementById('msg');
const warn = t => { msgEl.textContent = t; msgEl.style.display = 'block'; };

const INBOX_URL = 'https://business.facebook.com/latest/inbox/automated_responses';

document.getElementById('openInbox').onclick = async () => {
  try {
    await chrome.tabs.create({ url: INBOX_URL });
    window.close();
  } catch (e) {
    warn('无法打开 Meta 后台页面，请稍后重试');
  }
};
