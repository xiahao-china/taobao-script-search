export function detectAuth() {
  const visible = node => Boolean(node?.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
  const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
  const frame = pattern => [...document.querySelectorAll('iframe')].some(node => visible(node) && pattern.test(node.getAttribute('src') || ''));
  // Baxia/NoCaptcha slider dialogs do not change the URL, the title, or use an
  // iframe, and their copy drifts ("请拖动滑块" became "请推动下方滑块完成验证"),
  // so text matching alone misses the wall and the caller keeps navigating into
  // it — the page visibly jumping between searches. Probe the widgets first.
  const widget = ['#baxia-dialog-content', '.baxia-dialog', '#nc_1_wrapper', '#nc_1_n1z', '.nc-container', '#aliyunCaptcha-window-popup'].some(selector => visible(document.querySelector(selector)));
  if (widget) return 'needs_verification';
  if (/安全验证|人机验证|滑块验证|访问受限/.test(document.title) || /\/punish|\/verify|\/captcha/.test(location.pathname) || frame(/\/punish|\/verify|\/captcha/) || /请完成验证|请拖动滑块|请推动.{0,6}滑块|拖动滑块|推动下方滑块|访问过于频繁|哎哟喂.*被挤爆/.test(body)) return 'needs_verification';
  if (/(^|\.)login\.taobao\.com$/.test(location.hostname) || frame(/login\.taobao\.com/) || /扫码登录|密码登录|短信登录/.test(body)) return 'needs_login';
  return null;
}
