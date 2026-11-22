// 领域与协议共享类型定义：与 docs/api-contract.md 契约保持一致。

export type TaobaoErrorCode =
  | 'INVALID_ARGUMENT'
  | 'AUTH_REQUIRED'
  | 'RISK_CONTROL'
  | 'NETWORK_ERROR'
  | 'MTOP_ERROR'
  | 'NO_RESULTS'
  | 'ITEM_UNAVAILABLE'
  | 'SKU_NOT_FOUND'
  | 'SKU_UNAVAILABLE'
  | 'SPEC_AMBIGUOUS'
  | 'SPEC_UNAVAILABLE'
  | 'SKU_PRICE_UNCONFIRMED'
  | 'DEFAULT_PRICE_UNCONFIRMED'
  | 'CART_ADD_ERROR'
  | 'SHOP_SEARCH_ERROR'
  | 'CANCELLED'
  | 'INTERNAL_ERROR';

export interface CliErrorPayload {
  code: TaobaoErrorCode | string;
  message: string;
  details: unknown;
}

export interface DetailCoverage {
  stock: boolean;
  shipping: boolean;
  attributes: boolean;
  description: boolean;
  store: boolean;
}

export type WidSource = 'page' | 'cache' | 'cache-degraded' | null;

export interface OperationMeta {
  provider?: string;
  observedAt?: string;
  priceEvidence?: 'sku-id-map' | 'default-sku';
  coverage?: DetailCoverage;
  rateProvider?: string;
  verification?: string;
  note?: string;
  widSource?: WidSource;
  priceDecoded?: boolean;
}

export interface SdkResult<TData, TMeta = OperationMeta> {
  data: TData;
  meta: TMeta;
}

export type CliEnvelope<TData = unknown, TMeta = OperationMeta | Record<string, never> | null> =
  | { ok: true; operation: string; data: TData; error: null; meta: TMeta }
  | { ok: false; operation: string; data: TData | null; error: CliErrorPayload | null; meta: TMeta; partial?: boolean };

// ── Cookie 罐 ──

export interface CookieEntry {
  value: string;
  domain: string;
  expires: number;
}

export interface CookieStore {
  syncedAt: string | null;
  sync: string | null;
  cookies: Record<string, CookieEntry>;
}

export interface CookieSummary {
  syncedAt: string | null;
  sync: string | null;
  total: number;
  hasSignToken: boolean;
  hasLoginState: boolean;
  hasCna: boolean;
  warning?: string;
}

// ── HTTP / MTOP 客户端 ──

export interface HeadersLike {
  getSetCookie(): string[];
  get?(name: string): string | null;
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  headers: HeadersLike;
  text?(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<ResponseLike>;

export interface MtopClientOptions {
  runtimeDir?: string | null;
  timeoutMs?: number;
  minIntervalMs?: number;
  jitterMs?: number;
  fetch?: FetchLike;
}

export interface ResolvedMtopClientOptions {
  runtimeDir: string | null;
  timeoutMs: number;
  minIntervalMs: number;
  jitterMs: number;
  fetch?: FetchLike;
}

export interface MtopRequestOptions {
  retry?: number;
  signal?: AbortSignal;
  extraParams?: Record<string, string> | null;
  referer?: string | null;
  probe?: boolean;
  method?: 'GET' | 'POST';
}

export interface MtopClientLike {
  options?: Partial<ResolvedMtopClientOptions>;
  fetch?: FetchLike;
  request(
    api: string,
    version: string,
    data: Record<string, unknown>,
    options?: MtopRequestOptions,
  ): Promise<Record<string, unknown>>;
}

// ── 价格 ──

export type PriceBasis = 'displayed' | 'conditional' | 'api-displayed';

export interface ParsedPrice {
  amount: string;
  currency: 'CNY';
  basis: PriceBasis;
  display: string;
}

export interface SkuPriceResult extends ParsedPrice {
  stock: number | string | null;
}

// ── 规格与目录 ──

export interface SpecSelection {
  groupId: string;
  valueId: string;
}

export type SpecInput =
  | string
  | { specId: string; skuId?: undefined; selections?: undefined; labels?: undefined; kind?: undefined }
  | { skuId: string; specId?: undefined; selections?: undefined; labels?: undefined; kind?: undefined }
  | { selections: SpecSelection[]; specId?: undefined; skuId?: undefined; labels?: undefined; kind?: undefined }
  | { labels: string[]; specId?: undefined; skuId?: undefined; selections?: undefined; kind?: undefined }
  | { kind: 'default'; specId?: undefined; skuId?: undefined; selections?: undefined; labels?: undefined };

export interface SpecValue {
  valueId: string;
  label: string;
  available: boolean;
}

export interface InternalSpecValue extends SpecValue {
  index: number;
}

export interface SpecGroup {
  groupId: string;
  name: string;
  values: SpecValue[];
}

export interface InternalSpecGroup {
  groupId: string;
  name: string;
  index: number;
  values: InternalSpecValue[];
}

export interface SpecVariant {
  specId: string;
  skuId: string;
  selections: SpecSelection[];
  label: string;
}

export type SpecMode = 'variants' | 'select-by-groups' | 'single-variant' | 'unknown';

export interface PublicSpecs {
  itemId: string;
  groups: SpecGroup[];
  variants: SpecVariant[];
  mode: SpecMode;
}

export interface InternalSpecs {
  itemId: string;
  groups: InternalSpecGroup[];
  variants: SpecVariant[];
  mode: SpecMode;
}

export interface ResolvedSpecExpected {
  groupIndex: number;
  valueIndex: number;
  label: string;
}

export interface ResolvedSpec {
  specId: string;
  skuId: string | null;
  selections: SpecSelection[];
  expected: ResolvedSpecExpected[];
  label: string;
}

export interface RawSkuPropValue {
  vid?: string | number;
  name?: string;
}

export interface RawSkuProp {
  pid?: string | number;
  name?: string;
  values?: RawSkuPropValue[];
}

export interface RawSkuEntry {
  skuId?: string | number;
  propPath?: string;
}

export interface RawSkuBase {
  props?: RawSkuProp[];
  skus?: RawSkuEntry[];
}

export interface RawSkuInfoEntry {
  price?: {
    priceText?: string;
    priceTitle?: string;
  };
  quantity?: number | string | null;
}

export interface RawSkuCore {
  sku2info?: Record<string, RawSkuInfoEntry>;
}

export interface ExtractedCatalog {
  skuBase: RawSkuBase | null;
  skuCore: RawSkuCore | null;
  itemId: string | null;
}

// ── 店铺信誉 ──

export interface StoreDsrEntry {
  type: string | null;
  title: string;
  score: string;
  levelText: string | null;
}

export interface StoreScoreEntry {
  title: string;
  score: string;
}

export interface StoreRecord {
  sellerType: string | null;
  isTmall: boolean;
  dsr: StoreDsrEntry[] | null;
  scores: StoreScoreEntry[] | null;
  overallScore: string | null;
  creditLevel: string | number | null;
  labels: string[] | null;
  fansNum?: number | string;
  ifHideFansNum?: boolean;
  goldenSeller?: boolean;
}

export interface CatalogShopInfo {
  sellerId?: string;
  shopId?: string;
  shopUrl?: string;
}

export interface CatalogItemInfo {
  title: string | null;
  images: unknown[] | null;
  shopName: string | null;
}

export interface FetchedCatalog extends ExtractedCatalog {
  sourceApi?: string;
  shop: CatalogShopInfo | null;
  item: CatalogItemInfo;
  store: StoreRecord | null;
}

// ── 搜索 / 详情 / 评价 ──

export type SearchSort = 'default' | 'price-asc' | 'price-desc' | 'sales';

export interface SearchOptions {
  page?: number;
  limit?: number;
  sort?: SearchSort;
}

export interface SearchPriceSummary {
  amount: string | null;
  currency?: 'CNY';
  basis?: PriceBasis;
  display: string | null;
  scope: 'item-summary';
}

export interface SearchItem {
  itemId: string;
  title: string;
  priceText: string | null;
  shopName: string | null;
  salesText: string | null;
  url: string;
  imageUrl: string | null;
  priceSummary: SearchPriceSummary;
}

export interface SearchData {
  keyword: string;
  page: number;
  sort: SearchSort;
  items: SearchItem[];
  total: null;
}

export interface DetailPrice {
  amount: string;
  currency: 'CNY';
  basis: PriceBasis;
  display: string;
  scope: 'selected-spec' | 'item-default';
  observedAt: string;
}

export interface DetailAttribute {
  name: string;
  values: string[];
}

export interface ReviewSummaryData {
  itemId: string;
  total: number | null;
  totalFuzzy: string | null;
  foldedDefault: number | null;
  foldedRatio: string | null;
  note: string;
}

export interface DetailData {
  itemId: string;
  specId: string;
  skuId: string | null;
  specLabel: string;
  selections: SpecSelection[];
  title: string | null;
  url: string;
  shopName: string | null;
  shop: CatalogShopInfo | null;
  store: StoreRecord | null;
  price: DetailPrice;
  stock: number | string | null;
  shipping: null;
  attributes: DetailAttribute[];
  description: null;
  imageUrls: string[];
  selectedLabels: string[];
  reviewSummary?: ReviewSummaryData;
}

// ── 订单 ──

export interface OrderItem {
  title: string | null;
  skuText: string | null;
  quantity: number | null;
  price: string | null;
  auctionId: string | null;
  pic: string | null;
}

export interface OrderRecord {
  orderId: string | null;
  shopName: string | null;
  status: string | null;
  paid: string | null;
  total: string | null;
  discount: string | null;
  items: OrderItem[];
}

export interface OrdersPagination {
  currentPage: number | null;
  totalPage: number | null;
  pageSize: number | null;
  totalNumber: number | null;
}

export interface OrdersOptions {
  page?: number;
  pages?: number;
  tab?: string;
}

export interface OrdersData {
  page: number;
  tab: string;
  orders: OrderRecord[];
  pagination: OrdersPagination;
}

// ── 购物车 ──

export interface CartSku {
  skuId: string;
  title: string | null;
}

export interface CartItem {
  cartId: string | null;
  itemId: string;
  title: string | null;
  sku: CartSku | null;
  quantity: number | null;
  priceText: string | null;
  priceCents: number | null;
  pic: string | null;
  url: string;
  shopName: string | null;
  shopId: string | null;
  toBuy: string | null;
  isChecked: boolean;
  canCheck: boolean;
  checkedOut: boolean;
}

export interface CartShop {
  title: string | null;
  shopId: string | null;
}

export interface CartSummary {
  itemCount: number;
  checkedCount: number | null;
  totalPriceText: string | null;
  totalDiscountText: string | null;
  submitTitle: string | null;
}

export interface CartListData {
  items: CartItem[];
  shops: CartShop[];
  summary: CartSummary;
  pageTitle: string | null;
}

export interface CartAddOptions {
  skuId?: string | null;
  quantity?: number;
}

export interface CartAddData {
  itemId: string;
  skuId: string | null;
  quantity: number;
  added: true;
  cartQuantity: number | null;
  entryFound: boolean;
  entry: CartItem | null;
}

export interface CartRemoveData {
  cartId: string;
  itemId: string | null;
  title: string | null;
  removed: true;
  entryGone: boolean;
  remainingCount: number;
}

// ── 批量 ──

export type BatchSearchEntry = string | { keyword: string; options?: SearchOptions };

export interface BatchProductEntry {
  itemId: string;
  specs?: (SpecInput | null)[];
}

export interface BatchInput {
  searches?: BatchSearchEntry[];
  products?: BatchProductEntry[];
}

export interface BatchErrorSummary {
  code: string;
  message: string;
}

export type BatchResultItem =
  | { kind: 'search'; keyword: string; result: SdkResult<SearchData> }
  | { kind: 'search'; keyword: string; error: BatchErrorSummary }
  | { kind: 'specs'; itemId: string; result: SdkResult<PublicSpecs> }
  | { kind: 'specs'; itemId: string; error: BatchErrorSummary }
  | { kind: 'detail'; itemId: string; result: SdkResult<DetailData> }
  | { kind: 'detail'; itemId: string; error: BatchErrorSummary };

export interface BatchProgress {
  results: BatchResultItem[];
  total: number;
  succeeded: number;
  failed: number;
  aborted?: BatchErrorSummary;
}

export interface BatchData extends BatchProgress {
  note?: string;
}

export interface BatchCallbacks {
  onProgress?: (progress: BatchProgress) => void | Promise<void>;
}

// ── 店铺内搜索 ──

export type ShopRefInput = string | { shopUrl?: string | null; url?: string | null; shopId?: string | number | null };

export interface ParsedShopRef {
  shopId: string | null;
  host: string;
}

export interface ShopSearchOptions {
  page?: number;
  pages?: number;
}

export interface ShopSearchItem {
  itemId: string;
  title: string | null;
  priceText: string | null;
  strikethroughText: string | null;
  priceUnknown: boolean;
  salesText: string | null;
  url: string;
  imageUrl: string | null;
}

export interface ParsedShopSearchPage {
  items: ShopSearchItem[];
  total: number | null;
  page: number | null;
  pages: number | null;
}

export interface ShopSearchData {
  keyword: string;
  shop: {
    host: string;
    shopId: string | null;
    wid: string;
  };
  page: number;
  pages: number | null;
  total: number | null;
  items: ShopSearchItem[];
}
