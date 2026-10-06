export const card = (id = '1001', title = '测试商品') => `<a href="https://item.taobao.com/item.htm?id=${id}" title="${title}"><span class="innerPriceWrapper--test">¥79 .98</span></a>`;

export function product({ native = false, samePrice = false, authOnClick = false, delayMs = 120 } = {}) {
  const catalog = {
    item: { itemId: '1001' },
    skuBase: { props: [{ pid: '100', name: '型号', values: [{ vid: '11', name: 'A(100个)' }, { vid: '12', name: 'B(200个)' }] }], skus: [{ skuId: '101', propPath: '100:11' }, { skuId: '102', propPath: '100:12' }] },
    skuCore: { sku2info: { '0': { price: { priceText: '0.01' } }, '101': { quantity: 100, price: { priceTitle: '优惠前', priceText: '9.00' } }, '102': { quantity: 50, price: { priceTitle: '优惠前', priceText: samePrice ? '9.00' : '4.08' } } } },
  };
  return `<!doctype html><title>测试螺丝-淘宝网</title>
    <div data-product-title>测试螺丝</div><div data-purchase-panel>
    <div class="normalPrice--test" data-current-price>优惠前 ￥9.00</div>
    <div data-sku-group data-pid="100"><span data-group-name>型号</span>
    <div data-sku-value data-vid="11" class="valueItem--test isSelected--test"><span class="valueItemText--test">A(100个)</span></div>
    <div data-sku-value data-vid="12" class="valueItem--test"><span class="valueItemText--test">B(200个)</span></div>
    </div></div>
    <script>${native ? `window.__INIT_DATA=${JSON.stringify(catalog)};` : ''}
    for (const node of document.querySelectorAll('[data-sku-value]')) node.onclick = () => {
      ${authOnClick ? "location.href='https://login.taobao.com/member/login.jhtml'; return;" : ''}
      for (const other of document.querySelectorAll('[data-sku-value]')) other.className='valueItem--test';
      node.className='valueItem--test isSelected--test';
      const value = node.getAttribute('data-vid') === '11' ? '9.00' : '${samePrice ? '9.00' : '4.08'}';
      setTimeout(() => document.querySelector('[data-current-price]').innerText='优惠前 ￥'+value, ${delayMs});
    };
    </script>`;
}
