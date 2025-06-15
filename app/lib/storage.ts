import AsyncStorage from '@react-native-async-storage/async-storage';
import { emitAgentEvent } from './agent-events';

// ── 类型定义 ──────────────────────────────────────────────────
export type Listing = {
  id: string;
  title: string;
  community: string;
  district: string;
  roomType: string;
  area: string;
  floor: string;
  price: number;
  tags: string[];
  hasSubway: boolean;
  hasPets: boolean;
  isWhole: boolean;
  isShortTerm?: boolean;   // 是否短租
  isApartment?: boolean;    // 是否公寓
  rentDuration?: string;    // 租期（短租专用）
  aiScore: number;
  aiComment: string;
  url?: string;
  imageUrl?: string;
  platform?: string;
  scrapedAt?: string;
  cityCode?: string;
  // ── 详情页增强字段 ──────────────────────────────────────────
  detailDescription?: string;   // 详情页正文摘要（最多 2000 字）
  detailImages?: string[];      // 详情页图片 URL（最多 8 张）
  facilities?: string[];        // 设施词（空调、洗衣机等）
  listedDaysHint?: string;      // 页面可见的挂牌天数文案
  detailFetchedAt?: string;     // 详情抓取时间
};

export type UserPrefs = {
  city: string;
  cityLabel: string;
  budgetMin: string;
  budgetMax: string;
  district: string;
  commuteAddr: string;
  workAddress?: string;
  /** 地图选点保存的经度（十进制字符串，与高德一致） */
  workLng?: string;
  /** 地图选点保存的纬度 */
  workLat?: string;
  needSubway: boolean;
  needPets: boolean;
  otherReqs: string;
  rentMode: string;
  subFilter: string;
};

export type AppStats = {
  analyzed: number;
  favorited: number;
  deepAnalyzed: number;
};

export type DeepAnalysisRecord = {
  listingId: string;
  title: string;
  score: number;
  summary: string;
  raw: string;
  createdAt: string;
};

export type ChatSession = {
  id: string;
  topic: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  updatedAt: string;
};

// ── 小红书房源评价记录 ────────────────────────────────────────
export type XHSReviewRecord = {
  listingId: string;
  community: string;
  validPosts: Array<{
    title: string;
    content: string;
    author: string;
    images: string[];
    url: string;
    scrapedAt: string;
  }>;
  invalidPosts: Array<{
    title: string;
    reason: string;
  }>;
  summary: string;
  stats: {
    totalScraped: number;
    validCount: number;
    invalidCount: number;
  };
  createdAt: string;
};

// ── 多收藏夹类型 ────────────────────────────────────────────────
export type FavoriteFolder = {
  id: string;
  name: string;
  createdAt: string;
};

export type FavoriteListing = {
  listingId: string;
  folderId: string;
  addedAt: string;
};

// ── 默认值 ────────────────────────────────────────────────────
export const DEFAULT_PREFS: UserPrefs = {
  city: 'bj',
  cityLabel: '北京',
  budgetMin: '',
  budgetMax: '',
  district: '',
  commuteAddr: '',
  needSubway: false,
  needPets: false,
  otherReqs: '',
  rentMode: '整租',
  subFilter: '不限',
  workAddress: '',
};

// ── 存储 Key ──────────────────────────────────────────────────
const KEYS = {
  FAVORITES: 'rentsmart_favorites',
  FAVORITE_FOLDERS: 'rentsmart_favorite_folders',
  FAVORITE_LISTINGS: 'rentsmart_favorite_listings',
  HISTORY: 'rentsmart_history',
  COMPARE: 'rentsmart_compare',
  DEEP_ANALYSIS: 'rentsmart_deep_analysis',
  XHS_REVIEWS: 'rentsmart_xhs_reviews',
  CHAT_SESSIONS: 'rentsmart_chat_sessions',
  PREFS: 'rentsmart_prefs',
  STATS: 'rentsmart_stats',
  API_CONFIG: 'rentsmart_api',
  BEIKE_COOKIE: 'rentsmart_beike_cookie',
  LIANJIA_COOKIE: 'rentsmart_lianjia_cookie',
  XIAOHONGSHU_COOKIE: 'rentsmart_xiaohongshu_cookie',
  FOLDER_TIP_SHOWN: 'folder_tip_shown',
};

// ── 收藏夹 ────────────────────────────────────────────────────
/**
 * 获取所有收藏的房源（兼容旧版，实际从多收藏夹系统读取）
 * @deprecated 建议使用 getFolderListings 或 getAllFavoriteListings
 */
export async function getFavorites(): Promise<Listing[]> {
  // ★ 从新的多收藏夹系统读取，确保数据一致性
  return await getAllFavoriteListings();
}

/**
 * 获取所有收藏的房源（从多收藏夹系统）
 */
export async function getAllFavoriteListings(): Promise<Listing[]> {
  const associations = await getFavoriteListings();
  const uniqueListingIds = [...new Set(associations.map(a => a.listingId))];
  
  // 从 history 中获取完整房源数据
  const history = await getHistory();
  return history.filter(l => uniqueListingIds.includes(l.id));
}

/**
 * 获取收藏数量（统一接口）
 * ★ 只统计真实存在于 history 中的房源，避免"幽灵收藏"
 */
export async function getFavoritesCount(): Promise<number> {
  const associations = await getFavoriteListings();
  const uniqueListingIds = new Set(associations.map(a => a.listingId));
  
  // 验证这些房源是否真实存在于 history 中
  const history = await getHistory();
  const historyIds = new Set(history.map(h => h.id));
  
  // 只统计真实存在的房源
  const validListingIds = Array.from(uniqueListingIds).filter(id => historyIds.has(id));
  return validListingIds.length;
}

export async function addFavorite(listing: Listing): Promise<Listing[]> {
  const favs = await getFavorites();
  if (favs.some(f => f.id === listing.id)) return favs;
  const updated = [listing, ...favs];
  await AsyncStorage.setItem(KEYS.FAVORITES, JSON.stringify(updated));
  await updateStats({ favorited: updated.length });

  // 事件驱动：收藏达到阈值时主动触发 Agent 提示
  if (updated.length === 3 || (updated.length >= 5 && updated.length % 2 === 1)) {
    emitAgentEvent('FAVORITES_THRESHOLD', { count: updated.length });
  }

  return updated;
}

export async function removeFavorite(id: string): Promise<Listing[]> {
  const favs = await getFavorites();
  const updated = favs.filter(f => f.id !== id);
  await AsyncStorage.setItem(KEYS.FAVORITES, JSON.stringify(updated));
  await updateStats({ favorited: updated.length });
  return updated;
}

export async function isFavorited(id: string): Promise<boolean> {
  const favs = await getFavorites();
  return favs.some(f => f.id === id);
}

export async function clearFavorites(): Promise<void> {
  await AsyncStorage.setItem(KEYS.FAVORITES, JSON.stringify([]));
  await updateStats({ favorited: 0 });
}

// ── 历史记录（去重）────────────────────────────────────────────
export async function getHistory(): Promise<Listing[]> {
  try {
    const data = await AsyncStorage.getItem(KEYS.HISTORY);
    const listings = data ? JSON.parse(data) : [];
    // 按 scrapedAt 降序排列，确保最新房源在前
    return listings.sort((a: Listing, b: Listing) => {
      const aTs = new Date(a.scrapedAt || 0).getTime();
      const bTs = new Date(b.scrapedAt || 0).getTime();
      return bTs - aTs; // 降序：新的在前
    });
  } catch { return []; }
}

function normalizeHistoryUrl(rawUrl?: string): string {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    return `${url.hostname}${url.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function listingFingerprint(item: Listing): string {
  const normalizedUrl = normalizeHistoryUrl(item.url);
  if (normalizedUrl) {
    return `url:${normalizedUrl}`;
  }
  return [
    'fallback',
    item.platform || 'unknown',
    item.cityCode || '',
    (item.community || '').trim().toLowerCase(),
    (item.district || '').trim().toLowerCase(),
    (item.roomType || '').trim().toLowerCase(),
    String(item.price || 0),
  ].join('|');
}

// 质量检查（第二道防线）
function isListingValid(listing: Listing): boolean {
  if (!listing.url || listing.url.length < 10) return false;
  if (!listing.price || listing.price < 300 || listing.price > 50000) return false;
  const title = (listing.title || '').trim();
  if (title.length < 4) return false;
  if (/^[\d\s元月]+$/.test(title)) return false;
  if (/^(未知|unknown)/i.test(title)) return false;
  const hasCommunity = listing.community && listing.community.length >= 2 && listing.community !== '未知小区';
  const hasDistrict = listing.district && listing.district.length >= 2 && listing.district !== '未知';
  if (!hasCommunity && !hasDistrict) return false;
  return true;
}

export async function addToHistory(listings: Listing[]): Promise<{ added: number; skipped: number }> {
  const history = await getHistory();
  const existingIds = new Set(history.map(h => h.id));
  const existingFingerprints = new Set(history.map(listingFingerprint));
  const incomingFingerprints = new Set<string>();
  const newOnes = listings.filter((l) => {
    // 质量检查（第二道防线）
    if (!isListingValid(l)) return false;
    if (existingIds.has(l.id)) return false;
    const fp = listingFingerprint(l);
    if (existingFingerprints.has(fp)) return false;
    if (incomingFingerprints.has(fp)) return false;
    incomingFingerprints.add(fp);
    return true;
  });
  // ★ 按 scrapedAt 降序排列，确保新房源在上
  const updated = [...newOnes, ...history]
    .sort((a, b) => {
      const aTs = new Date(a.scrapedAt || 0).getTime();
      const bTs = new Date(b.scrapedAt || 0).getTime();
      return bTs - aTs; // 降序：新的在前
    })
    .slice(0, 500);
  await AsyncStorage.setItem(KEYS.HISTORY, JSON.stringify(updated));
  await updateStats({ analyzed: updated.length });
  return { added: newOnes.length, skipped: listings.length - newOnes.length };
}

export async function clearHistory(): Promise<void> {
  await AsyncStorage.setItem(KEYS.HISTORY, JSON.stringify([]));
  await updateStats({ analyzed: 0 });
}

export async function clearHistoryByCity(cityCode: string): Promise<number> {
  const history = await getHistory();
  const updated = history.filter(item => item.cityCode !== cityCode);
  await AsyncStorage.setItem(KEYS.HISTORY, JSON.stringify(updated));
  await updateStats({ analyzed: updated.length });
  return history.length - updated.length;
}

/** 更新单条 history 房源的详情字段（不影响其他字段） */
export async function patchListingDetail(
  id: string,
  detail: Pick<Listing, 'detailDescription' | 'detailImages' | 'facilities' | 'listedDaysHint' | 'detailFetchedAt'>,
): Promise<void> {
  const history = await getHistory();
  const updated = history.map(item => item.id === id ? { ...item, ...detail } : item);
  await AsyncStorage.setItem(KEYS.HISTORY, JSON.stringify(updated));
}

export async function upsertHistoryListings(listings: Listing[]): Promise<void> {
  const history = await getHistory();
  const byId = new Map(history.map(item => [item.id, item]));
  for (const listing of listings) {
    byId.set(listing.id, { ...(byId.get(listing.id) || {}), ...listing });
  }

  const updated = Array.from(byId.values())
    .sort((a, b) => {
      const aTs = new Date(a.scrapedAt || 0).getTime();
      const bTs = new Date(b.scrapedAt || 0).getTime();
      return bTs - aTs;
    })
    .slice(0, 500);

  await AsyncStorage.setItem(KEYS.HISTORY, JSON.stringify(updated));
}

// ── 对比列表 ────────────────────────────────────────────────────
const MAX_COMPARE_ITEMS = 5;

export async function getCompareList(): Promise<Listing[]> {
  try {
    const data = await AsyncStorage.getItem(KEYS.COMPARE);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export async function addToCompare(listing: Listing): Promise<Listing[]> {
  const current = await getCompareList();
  if (current.some(item => item.id === listing.id)) return current;

  // 限制最多 5 套，保留最近加入项
  const updated = [listing, ...current].slice(0, MAX_COMPARE_ITEMS);
  await AsyncStorage.setItem(KEYS.COMPARE, JSON.stringify(updated));
  return updated;
}

export async function removeFromCompare(id: string): Promise<Listing[]> {
  const current = await getCompareList();
  const updated = current.filter(item => item.id !== id);
  await AsyncStorage.setItem(KEYS.COMPARE, JSON.stringify(updated));
  return updated;
}

export async function clearCompare(): Promise<void> {
  await AsyncStorage.setItem(KEYS.COMPARE, JSON.stringify([]));
}

// ── 精筛记录 ────────────────────────────────────────────────────
export async function getDeepAnalysisRecords(): Promise<DeepAnalysisRecord[]> {
  try {
    const data = await AsyncStorage.getItem(KEYS.DEEP_ANALYSIS);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export async function getDeepAnalysisRecordByListingId(listingId: string): Promise<DeepAnalysisRecord | null> {
  const records = await getDeepAnalysisRecords();
  return records.find(r => r.listingId === listingId) || null;
}

export async function saveDeepAnalysisRecord(record: DeepAnalysisRecord): Promise<void> {
  const current = await getDeepAnalysisRecords();
  const filtered = current.filter(item => item.listingId !== record.listingId);
  const updated = [record, ...filtered].slice(0, 300);
  await AsyncStorage.setItem(KEYS.DEEP_ANALYSIS, JSON.stringify(updated));
  await updateStats({ deepAnalyzed: updated.length });
}

export async function clearDeepAnalysisRecords(): Promise<void> {
  await AsyncStorage.setItem(KEYS.DEEP_ANALYSIS, JSON.stringify([]));
  await updateStats({ deepAnalyzed: 0 });
}

// ── 聊天会话记录 ────────────────────────────────────────────────
export async function getChatSessions(): Promise<ChatSession[]> {
  try {
    const data = await AsyncStorage.getItem(KEYS.CHAT_SESSIONS);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export async function upsertChatSession(session: ChatSession): Promise<void> {
  const sessions = await getChatSessions();
  const rest = sessions.filter(item => item.id !== session.id);
  const updated = [session, ...rest]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 100);
  await AsyncStorage.setItem(KEYS.CHAT_SESSIONS, JSON.stringify(updated));
}

export async function clearChatSessions(): Promise<void> {
  await AsyncStorage.setItem(KEYS.CHAT_SESSIONS, JSON.stringify([]));
}

// ── 用户偏好 ──────────────────────────────────────────────────
export async function getPrefs(): Promise<UserPrefs> {
  try {
    const data = await AsyncStorage.getItem(KEYS.PREFS);
    return data ? { ...DEFAULT_PREFS, ...JSON.parse(data) } : DEFAULT_PREFS;
  } catch { return DEFAULT_PREFS; }
}

export async function savePrefs(prefs: Partial<UserPrefs>): Promise<UserPrefs> {
  const current = await getPrefs();
  const updated = { ...current, ...prefs };
  await AsyncStorage.setItem(KEYS.PREFS, JSON.stringify(updated));
  return updated;
}

// ── 统计数据 ──────────────────────────────────────────────────
export async function getStats(): Promise<AppStats> {
  try {
    const data = await AsyncStorage.getItem(KEYS.STATS);
    return data ? JSON.parse(data) : { analyzed: 0, favorited: 0, deepAnalyzed: 0 };
  } catch { return { analyzed: 0, favorited: 0, deepAnalyzed: 0 }; }
}

async function updateStats(partial: Partial<AppStats>): Promise<void> {
  const stats = await getStats();
  await AsyncStorage.setItem(KEYS.STATS, JSON.stringify({ ...stats, ...partial }));
}

// ── API 配置 ──────────────────────────────────────────────────
/** 通勤路径规划方式（与高德 Web 服务路径规划一致，可在「我的」中修改） */
export type CommuteRouteMode = 'transit' | 'driving' | 'walking' | 'bicycling';

export type ApiConfig = {
  textModel: string;
  visionModel: string;
  apiKey: string;        // 兼容旧版字段
  deepseekApiKey?: string;
  glmApiKey?: string;
  apiBase: string;       // 自定义 OpenAI 兼容 Base URL
  amapKey: string;       // 高德地图 Web 服务 Key（REST 接口，用于地理编码/路径规划）
  amapJsKey?: string;    // 高德地图 Web JS API Key（用于地图 WebView 渲染）
  /** 默认公交地铁；可改为驾车/步行/骑行 */
  commuteRouteMode?: CommuteRouteMode;
};

const DEFAULT_API_CONFIG: ApiConfig = {
  textModel: 'deepseek',
  visionModel: 'glm4v',
  apiKey: '',
  deepseekApiKey: '',
  glmApiKey: '',
  apiBase: '',
  amapKey: '',
  amapJsKey: '',
  commuteRouteMode: 'transit',
};

export async function getApiConfig(): Promise<ApiConfig> {
  try {
    const data = await AsyncStorage.getItem(KEYS.API_CONFIG);
    return data
      ? { ...DEFAULT_API_CONFIG, ...JSON.parse(data) }
      : DEFAULT_API_CONFIG;
  } catch {
    return DEFAULT_API_CONFIG;
  }
}

export async function saveApiConfig(config: Partial<ApiConfig>): Promise<void> {
  const current = await getApiConfig();
  await AsyncStorage.setItem(KEYS.API_CONFIG, JSON.stringify({ ...current, ...config }));
}

// ── 平台登录状态 ────────────────────────────────────────────────
export type PlatformLoginStatus = {
  beike?: boolean;
  anjuke?: boolean;
  lianjia?: boolean;
  xiaohongshu?: boolean;
};

export async function getPlatformLoginStatus(): Promise<PlatformLoginStatus> {
  try {
    // ★ 贝壳平台：检查 Cookie 是否存在，而不是只看标记
    const beikeCookie = await getBeikeCookie();
    const hasBeikeCookie = !!beikeCookie && beikeCookie.length > 0;
    
    // 其他平台仍然使用标记
    const data = await AsyncStorage.getItem('rentsmart_platform_login');
    const status: PlatformLoginStatus = data ? JSON.parse(data) : {};
    
    // 覆盖贝壳的状态为实际 Cookie 状态
    status.beike = hasBeikeCookie;
    
    return status;
  } catch { return {}; }
}

export async function setPlatformLoggedIn(platform: keyof PlatformLoginStatus, value: boolean): Promise<void> {
  const current = await getPlatformLoginStatus();
  await AsyncStorage.setItem('rentsmart_platform_login', JSON.stringify({ ...current, [platform]: value }));
}

// ── 自动看房已爬页记录 ──────────────────────────────────────────
export type ScrapedPagesRecord = { pages: number[]; lastActivePage: number };

function scrapedPagesKey(cityCode: string, platform: string): string {
  return `rentsmart_scraped_pages_${cityCode}_${platform}`;
}

export async function getScrapedPages(cityCode: string, platform: string): Promise<ScrapedPagesRecord> {
  try {
    const data = await AsyncStorage.getItem(scrapedPagesKey(cityCode, platform));
    return data ? JSON.parse(data) : { pages: [], lastActivePage: 0 };
  } catch { return { pages: [], lastActivePage: 0 }; }
}

export async function markPageScraped(cityCode: string, platform: string, page: number): Promise<void> {
  const record = await getScrapedPages(cityCode, platform);
  if (!record.pages.includes(page)) record.pages.push(page);
  record.lastActivePage = page;
  await AsyncStorage.setItem(scrapedPagesKey(cityCode, platform), JSON.stringify(record));
}

export async function clearScrapedPages(cityCode: string, platform: string): Promise<void> {
  await AsyncStorage.removeItem(scrapedPagesKey(cityCode, platform));
}

// ── 在线看房浏览记录（用户手动翻页）─────────────────────────────
export type BrowseRecord = {
  platform: string;
  page: number;
  url: string;
  recordedAt: string;
  listingCount?: number;
  processed?: boolean;
};

function browseRecordsKey(cityCode: string, platform: string): string {
  return `rentsmart_browse_records_${cityCode}_${platform}`;
}

export async function getBrowseRecords(cityCode: string, platform: string): Promise<BrowseRecord[]> {
  try {
    const data = await AsyncStorage.getItem(browseRecordsKey(cityCode, platform));
    return data ? JSON.parse(data) : [];
  } catch { return []; }
}

export async function addBrowseRecord(
  cityCode: string,
  platform: string,
  record: Omit<BrowseRecord, 'recordedAt'> & { recordedAt?: string },
): Promise<BrowseRecord[]> {
  const list = await getBrowseRecords(cityCode, platform);
  const key = `${record.platform}-${record.page}`;
  const filtered = list.filter(r => `${r.platform}-${r.page}` !== key);
  const entry: BrowseRecord = {
    ...record,
    recordedAt: record.recordedAt || new Date().toISOString(),
  };
  const updated = [entry, ...filtered].slice(0, 50);
  await AsyncStorage.setItem(browseRecordsKey(cityCode, platform), JSON.stringify(updated));
  return updated;
}

export async function markBrowseRecordProcessed(
  cityCode: string,
  platform: string,
  page: number,
  listingCount?: number,
): Promise<void> {
  const list = await getBrowseRecords(cityCode, platform);
  const updated = list.map(r =>
    r.platform === platform && r.page === page
      ? { ...r, processed: true, listingCount: listingCount ?? r.listingCount }
      : r,
  );
  await AsyncStorage.setItem(browseRecordsKey(cityCode, platform), JSON.stringify(updated));
}

export async function clearBrowseRecords(cityCode: string, platform?: string): Promise<void> {
  if (platform) {
    await AsyncStorage.removeItem(browseRecordsKey(cityCode, platform));
    return;
  }
  for (const p of ['anjuke', 'beike']) {
    await AsyncStorage.removeItem(browseRecordsKey(cityCode, p));
  }
}

// ── 贝壳 Cookie 管理 ──────────────────────────────────────────
/**
 * 保存贝壳 Cookie（从登录 WebView 中提取）
 * Cookie 格式：key1=value1; key2=value2; ...
 */
export async function saveBeikeCookie(cookieString: string): Promise<void> {
  await AsyncStorage.setItem(KEYS.BEIKE_COOKIE, cookieString);
  // 同时更新登录状态
  await setPlatformLoggedIn('beike', true);
}

/**
 * 获取保存的贝壳 Cookie
 * @returns Cookie 字符串，如果没有则返回 null
 */
export async function getBeikeCookie(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEYS.BEIKE_COOKIE);
  } catch {
    return null;
  }
}

/**
 * 清除贝壳 Cookie（登出或 Cookie 失效时调用）
 */
export async function clearBeikeCookie(): Promise<void> {
  await AsyncStorage.removeItem(KEYS.BEIKE_COOKIE);
  await setPlatformLoggedIn('beike', false);
}

/**
 * 检查贝壳 Cookie 是否存在且有效
 * 注意：这只检查 Cookie 是否存在，不验证是否过期
 */
export async function hasValidBeikeCookie(): Promise<boolean> {
  const cookie = await getBeikeCookie();
  return !!cookie && cookie.length > 0;
}

// ── 链家 Cookie 管理 ──────────────────────────────────────────
export async function saveLianjiaCookie(cookieString: string): Promise<void> {
  await AsyncStorage.setItem(KEYS.LIANJIA_COOKIE, cookieString);
  await setPlatformLoggedIn('lianjia', true);
}

export async function getLianjiaCookie(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEYS.LIANJIA_COOKIE);
  } catch {
    return null;
  }
}

export async function clearLianjiaCookie(): Promise<void> {
  await AsyncStorage.removeItem(KEYS.LIANJIA_COOKIE);
  await setPlatformLoggedIn('lianjia', false);
}

// ── 小红书 Cookie 管理 ──────────────────────────────────────────
export async function saveXiaohongshuCookie(cookieString: string): Promise<void> {
  await AsyncStorage.setItem(KEYS.XIAOHONGSHU_COOKIE, cookieString);
  await setPlatformLoggedIn('xiaohongshu', true);
}

export async function getXiaohongshuCookie(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEYS.XIAOHONGSHU_COOKIE);
  } catch {
    return null;
  }
}

export async function clearXiaohongshuCookie(): Promise<void> {
  await AsyncStorage.removeItem(KEYS.XIAOHONGSHU_COOKIE);
  await setPlatformLoggedIn('xiaohongshu', false);
}

// ── 多收藏夹管理 ────────────────────────────────────────────────

/** 获取所有收藏夹 */
export async function getFavoriteFolders(): Promise<FavoriteFolder[]> {
  try {
    const data = await AsyncStorage.getItem(KEYS.FAVORITE_FOLDERS);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

/** 创建新收藏夹 */
export async function createFavoriteFolder(name: string): Promise<FavoriteFolder> {
  const folders = await getFavoriteFolders();
  const newFolder: FavoriteFolder = {
    id: `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name,
    createdAt: new Date().toISOString(),
  };
  const updated = [...folders, newFolder];
  await AsyncStorage.setItem(KEYS.FAVORITE_FOLDERS, JSON.stringify(updated));
  return newFolder;
}

/** 重命名收藏夹 */
export async function renameFavoriteFolder(id: string, name: string): Promise<void> {
  const folders = await getFavoriteFolders();
  const updated = folders.map(f => f.id === id ? { ...f, name } : f);
  await AsyncStorage.setItem(KEYS.FAVORITE_FOLDERS, JSON.stringify(updated));
}

/** 删除收藏夹（同时删除该收藏夹下的所有关联） */
export async function deleteFavoriteFolder(id: string): Promise<void> {
  const folders = await getFavoriteFolders();
  const updated = folders.filter(f => f.id !== id);
  await AsyncStorage.setItem(KEYS.FAVORITE_FOLDERS, JSON.stringify(updated));
  
  // 删除该收藏夹下的所有房源关联
  const listings = await getFavoriteListings();
  const updatedListings = listings.filter(l => l.folderId !== id);
  await AsyncStorage.setItem(KEYS.FAVORITE_LISTINGS, JSON.stringify(updatedListings));
  
  // 更新统计
  await updateFavoriteStats();
}

/** 获取所有收藏夹-房源关联 */
async function getFavoriteListings(): Promise<FavoriteListing[]> {
  try {
    const data = await AsyncStorage.getItem(KEYS.FAVORITE_LISTINGS);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

/** 添加房源到收藏夹 */
export async function addListingToFolder(listing: Listing, folderId: string): Promise<void> {
  const listings = await getFavoriteListings();
  
  // 检查是否已存在
  const exists = listings.some(l => l.listingId === listing.id && l.folderId === folderId);
  if (exists) return;
  
  const newEntry: FavoriteListing = {
    listingId: listing.id,
    folderId,
    addedAt: new Date().toISOString(),
  };
  
  const updated = [...listings, newEntry];
  await AsyncStorage.setItem(KEYS.FAVORITE_LISTINGS, JSON.stringify(updated));
  
  // 同时保存房源数据到 history（确保可以查询到）
  await upsertHistoryListings([listing]);
  
  // 更新统计
  await updateFavoriteStats();
  
  // 检查是否达到阈值（每满5套触发一次）
  const folderListings = updated.filter(l => l.folderId === folderId);
  const count = folderListings.length;
  console.log('[Folder] count:', count, 'folderId:', folderId);
  
  if (count % 5 === 0 && count > 0) {
    const folders = await getFavoriteFolders();
    const folder = folders.find(f => f.id === folderId);
    if (folder) {
      console.log('[Folder] Triggering FOLDER_THRESHOLD_REACHED event for:', folder.name);
      emitAgentEvent('FOLDER_THRESHOLD_REACHED', {
        folderId,
        folderName: folder.name,
        count,
      });
    }
  }
}

/** 从收藏夹移除房源 */
export async function removeListingFromFolder(listingId: string, folderId: string): Promise<void> {
  const listings = await getFavoriteListings();
  const updated = listings.filter(l => !(l.listingId === listingId && l.folderId === folderId));
  await AsyncStorage.setItem(KEYS.FAVORITE_LISTINGS, JSON.stringify(updated));
  await updateFavoriteStats();
}

/** 获取收藏夹中的所有房源 */
export async function getFolderListings(folderId: string): Promise<Listing[]> {
  const associations = await getFavoriteListings();
  const listingIds = associations
    .filter(a => a.folderId === folderId)
    .map(a => a.listingId);
  
  // 从 history 中获取完整房源数据
  const history = await getHistory();
  return history.filter(l => listingIds.includes(l.id));
}

/** 获取房源所在的所有收藏夹ID */
export async function getListingFolders(listingId: string): Promise<string[]> {
  const listings = await getFavoriteListings();
  return listings
    .filter(l => l.listingId === listingId)
    .map(l => l.folderId);
}

/** 更新收藏统计（使用统一的计数函数） */
async function updateFavoriteStats(): Promise<void> {
  const count = await getFavoritesCount();
  await updateStats({ favorited: count });
}

/**
 * 数据一致性检查和修复
 * 确保统计数字与实际数据匹配
 */
export async function checkAndFixFavoriteConsistency(): Promise<{ fixed: boolean; details: string }> {
  try {
    const associations = await getFavoriteListings();
    const history = await getHistory();
    const historyIds = new Set(history.map(h => h.id));
    
    // 找出无效的关联（房源不在 history 中）
    const invalidAssociations = associations.filter(a => !historyIds.has(a.listingId));
    
    if (invalidAssociations.length > 0) {
      // 清理无效关联
      const validAssociations = associations.filter(a => historyIds.has(a.listingId));
      await AsyncStorage.setItem(KEYS.FAVORITE_LISTINGS, JSON.stringify(validAssociations));
      await updateFavoriteStats();
      
      return {
        fixed: true,
        details: `清理了 ${invalidAssociations.length} 个无效收藏关联`
      };
    }
    
    return { fixed: false, details: '数据一致性正常' };
  } catch (error) {
    console.error('[Consistency Check] Error:', error);
    return { fixed: false, details: '检查失败' };
  }
}

/** 数据迁移：将旧收藏夹数据迁移到新的多收藏夹结构 */
export async function migrateOldFavorites(): Promise<void> {
  const folders = await getFavoriteFolders();
  const associations = await getFavoriteListings();
  
  // 情况1：没有收藏夹，创建默认收藏夹
  if (folders.length === 0) {
    // 获取旧的收藏数据
    try {
      const oldData = await AsyncStorage.getItem(KEYS.FAVORITES);
      const oldFavorites: Listing[] = oldData ? JSON.parse(oldData) : [];
      
      if (oldFavorites.length === 0) {
        // 没有旧数据，只创建默认收藏夹
        await createFavoriteFolder('默认收藏夹');
        return;
      }
      
      // 创建默认收藏夹并迁移数据
      const defaultFolder = await createFavoriteFolder('默认收藏夹');
      const newListings: FavoriteListing[] = oldFavorites.map(fav => ({
        listingId: fav.id,
        folderId: defaultFolder.id,
        addedAt: new Date().toISOString(),
      }));
      
      await AsyncStorage.setItem(KEYS.FAVORITE_LISTINGS, JSON.stringify(newListings));
      await upsertHistoryListings(oldFavorites);
      await updateFavoriteStats();
      
      console.log(`[Migration] Migrated ${oldFavorites.length} favorites to default folder`);
    } catch (error) {
      console.error('[Migration] Error migrating old favorites:', error);
      // 即使迁移失败，也创建默认收藏夹
      await createFavoriteFolder('默认收藏夹');
    }
    return;
  }
  
  // 情况2：有收藏夹但关联表为空，尝试从旧数据恢复
  if (associations.length === 0) {
    try {
      const oldData = await AsyncStorage.getItem(KEYS.FAVORITES);
      const oldFavorites: Listing[] = oldData ? JSON.parse(oldData) : [];
      
      if (oldFavorites.length > 0) {
        // 使用第一个收藏夹作为默认目标
        const targetFolder = folders[0];
        const newListings: FavoriteListing[] = oldFavorites.map(fav => ({
          listingId: fav.id,
          folderId: targetFolder.id,
          addedAt: new Date().toISOString(),
        }));
        
        await AsyncStorage.setItem(KEYS.FAVORITE_LISTINGS, JSON.stringify(newListings));
        await upsertHistoryListings(oldFavorites);
        await updateFavoriteStats();
        
        console.log(`[Migration] Recovered ${oldFavorites.length} favorites to folder: ${targetFolder.name}`);
      }
    } catch (error) {
      console.error('[Migration] Error recovering favorites:', error);
    }
  }
  
  // 情况3：清理无效的关联（房源不在 history 中）
  if (associations.length > 0) {
    const history = await getHistory();
    const historyIds = new Set(history.map(h => h.id));
    const validAssociations = associations.filter(a => historyIds.has(a.listingId));
    
    if (validAssociations.length !== associations.length) {
      await AsyncStorage.setItem(KEYS.FAVORITE_LISTINGS, JSON.stringify(validAssociations));
      await updateFavoriteStats();
      console.log(`[Migration] Cleaned ${associations.length - validAssociations.length} invalid associations`);
    }
  }
}

// ── 收藏夹提示管理 ────────────────────────────────────────────

/** 检查是否已显示过收藏夹提示 */
export async function hasFolderTipShown(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(KEYS.FOLDER_TIP_SHOWN);
    return value === 'true';
  } catch {
    return false;
  }
}

/** 标记收藏夹提示已显示 */
export async function markFolderTipShown(): Promise<void> {
  await AsyncStorage.setItem(KEYS.FOLDER_TIP_SHOWN, 'true');
}

// ── 小红书房源评价管理 ────────────────────────────────────────

/** 获取所有小红书评价记录 */
export async function getXHSReviews(): Promise<XHSReviewRecord[]> {
  try {
    const data = await AsyncStorage.getItem(KEYS.XHS_REVIEWS);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

/** 根据房源ID获取小红书评价 */
export async function getXHSReviewByListingId(listingId: string): Promise<XHSReviewRecord | null> {
  const reviews = await getXHSReviews();
  return reviews.find(r => r.listingId === listingId) || null;
}

/** 保存小红书评价记录 */
export async function saveXHSReview(record: XHSReviewRecord): Promise<void> {
  const current = await getXHSReviews();
  // 移除同一房源的旧记录
  const filtered = current.filter(item => item.listingId !== record.listingId);
  // 最多保留100条记录
  const updated = [record, ...filtered].slice(0, 100);
  await AsyncStorage.setItem(KEYS.XHS_REVIEWS, JSON.stringify(updated));
}

/** 删除指定房源的小红书评价 */
export async function deleteXHSReview(listingId: string): Promise<void> {
  const current = await getXHSReviews();
  const updated = current.filter(item => item.listingId !== listingId);
  await AsyncStorage.setItem(KEYS.XHS_REVIEWS, JSON.stringify(updated));
}

/** 清空所有小红书评价记录 */
export async function clearXHSReviews(): Promise<void> {
  await AsyncStorage.setItem(KEYS.XHS_REVIEWS, JSON.stringify([]));
}
