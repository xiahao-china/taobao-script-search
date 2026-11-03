// 商品评价列表：mtop.taobao.rate.detaillist.get v4.0（2026-11-03 实测定案）。
// 翻页参数是 pageNo（currentPage 等写法无效且静默回落第 1 页）。
// 顶层：total（封顶值，实测 3000）/totalFuzzy（"3000+"文案）/totalPage/hasNext/rateList
// 及 feedAllCount、feedGoodCount 等分类计数。rateList 单条关键字段：
// feedback（评价正文）、rateType（透传字符串，实测见到 "1"）、skuValueStr/skuId（购买规格）、
// feedbackDate（"2026年10月7日"）/createTime（"10月7日"）、userNick/reduceUserNick（脱敏昵称）、
// reply（卖家回复，可为 null）、feedPicPathList（协议相对图片路径）。
// 追评（feedAppendCount）只在计数里出现，列表项不含追评内容；pageSize 实测最大 20。
import { TaobaoError } from '../../core/errors.js';

const int = value => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

function mapRate(item) {
  const id = /^\d+$/.test(String(item?.id ?? '')) ? String(item.id) : null;
  const feedback = typeof item?.feedback === 'string' ? item.feedback.trim() : null;
  if (!id || !feedback) return null;
  const pics = Array.isArray(item.feedPicPathList)
    ? item.feedPicPathList.filter(path => typeof path === 'string' && path).map(path => `https:${path}`)
    : [];
  const reply = item.reply == null ? null : (typeof item.reply === 'string' ? item.reply : item.reply.content ?? null);
  return {
    id,
    rateType: item.rateType == null ? null : String(item.rateType),
    content: feedback,
    sku: item.skuValueStr || null,
    skuId: /^\d+$/.test(String(item.skuId ?? '')) ? String(item.skuId) : null,
    date: item.feedbackDate || item.createTime || null,
    userNick: item.reduceUserNick || item.userNick || null,
    creditLevel: int(item.creditLevel),
    elite: item.elite === '1',
    reply,
    pics,
  };
}

export function extractReviews(payload) {
  const data = payload?.data ?? payload;
  const counts = {};
  for (const key of ['feedAllCount', 'feedGoodCount', 'feedNormalCount', 'feedNotGoodCount', 'feedPicCount', 'feedVideoCount', 'feedAppendCount']) {
    const value = int(data?.[key]);
    if (value != null) counts[key.replace(/^feed/, '').replace(/Count$/, '')] = value;
  }
  return {
    total: int(data?.total),
    totalFuzzy: data?.totalFuzzy ?? null,
    hasNext: data?.hasNext === true,
    counts,
    rates: Array.isArray(data?.rateList) ? data.rateList.map(mapRate).filter(Boolean) : [],
  };
}

export function assertReviewsPayload(payload) {
  const result = extractReviews(payload);
  if (!result.rates.length && !result.total) {
    throw new TaobaoError('NO_RESULTS', '评价接口未返回评价数据；可能是商品无评价、页码越界或返回结构变化。');
  }
  return result;
}
