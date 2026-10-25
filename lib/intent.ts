// 价格意图正则：引擎（buildPlan 锁定 priceTools）与评分器（evaluateCase 检查价格 Tool）
// 共用同一真源，防止两处漂移。2026-10-20 Round2 P0 修复加入「付多少|总价」；
// 2026-10-24 同步评分器时补齐「不太贵|省钱」。
export const PRICE_INTENT_PATTERN = /价格|多少钱|付多少|总价|优惠|券|满减|预算|便宜|划算|别太贵|不太贵|省钱|实惠|性价比/;

export function isPriceIntent(input: string) {
  return PRICE_INTENT_PATTERN.test(input);
}
