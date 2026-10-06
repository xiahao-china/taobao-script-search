export function detectAuth() {
  const visible = node => Boolean(node?.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
  const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
  const frame = pattern => [...document.querySelectorAll('iframe')].some(node => visible(node) && pattern.test(node.getAttribute('src') || ''));
  if (/安全验证|人机验证|滑块验证|访问受限/.test(document.title) || /\/punish|\/verify|\/captcha/.test(location.pathname) || frame(/\/punish|\/verify|\/captcha/) || /请完成验证|请拖动滑块|访问过于频繁|哎哟喂.*被挤爆/.test(body)) return 'needs_verification';
  if (/(^|\.)login\.taobao\.com$/.test(location.hostname) || frame(/login\.taobao\.com/) || /扫码登录|密码登录|短信登录/.test(body)) return 'needs_login';
  return null;
}
