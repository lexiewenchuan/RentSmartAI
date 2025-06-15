/**
 * 调用本机 Python 爬虫服务（DrissionPage + Flask）获取安居客 / 贝壳房源数据。
 * 响应格式与 WebView postMessage 的 scrape_result 保持一致，
 * 可直接传给 convertAndSaveListings。
 *
 * 服务地址通过环境变量 EXPO_PUBLIC_SCRAPER_URL 配置，
 * 默认 http://127.0.0.1:8765（真机调试需改为局域网 IP）。
 */

import type { ScrapedListing } from './scraper';

const DEFAULT_BASE = 'http://127.0.0.1:8765';

function getBaseUrl(): string {
  // Expo 环境变量（需在 .env 中设置 EXPO_PUBLIC_SCRAPER_URL）
  const env = (process.env.EXPO_PUBLIC_SCRAPER_URL ?? '').trim();
  return env || DEFAULT_BASE;
}

export type ScraperBackendResult =
  | { success: true; listings: ScrapedListing[]; count: number; page: number; platform: string }
  | { success: false; reason: string; count: 0 };

/**
 * 请求超时设置。安居客页面加载 + 5s sleep，保守估计 90s。
 */
const REQUEST_TIMEOUT_MS = 90_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function callScraper(
  platform: 'anjuke' | 'beike',
  cityCode: string,
  page: number,
): Promise<ScraperBackendResult> {
  const base = getBaseUrl();
  const url = `${base}/api/scrape/${platform}?city=${encodeURIComponent(cityCode)}&page=${page}`;
  try {
    const resp = await fetchWithTimeout(url);
    const json = await resp.json();
    if (json.success === false) {
      return { success: false, reason: json.reason ?? '服务端返回失败', count: 0 };
    }
    return {
      success: true,
      listings: (json.listings ?? []) as ScrapedListing[],
      count: json.count ?? 0,
      page: json.page ?? page,
      platform: json.platform ?? platform,
    };
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const reason = isAbort
      ? `请求超时（>${REQUEST_TIMEOUT_MS / 1000}s），请检查爬虫服务是否已启动`
      : `无法连接爬虫服务（${base}）：${err instanceof Error ? err.message : String(err)}`;
    return { success: false, reason, count: 0 };
  }
}

/** 从服务端抓取安居客租房列表。city 接受 code / 城市名 / 拼音。 */
export function fetchAnjukeFromServer(cityCode: string, page = 1): Promise<ScraperBackendResult> {
  return callScraper('anjuke', cityCode, page);
}

/** 从服务端抓取贝壳租房列表（需事先完成 Cookie 初始化）。 */
export function fetchBeikeFromServer(cityCode: string, page = 1): Promise<ScraperBackendResult> {
  return callScraper('beike', cityCode, page);
}

export type BeikeCookieStatus =
  | { hasCookie: true; city: string; cookiePath: string }
  | { hasCookie: false; city: string; setupHint: string };

/** 查询贝壳 Cookie 是否已保存（不验证会话有效性，仅确认文件存在）。 */
export async function fetchBeikeCookieStatus(cityCode: string): Promise<BeikeCookieStatus> {
  const base = getBaseUrl();
  const url = `${base}/api/beike/cookie-status?city=${encodeURIComponent(cityCode)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const json = await resp.json();
    if (json.hasCookie) {
      return { hasCookie: true, city: json.city, cookiePath: json.cookiePath };
    }
    return {
      hasCookie: false,
      city: json.city ?? cityCode,
      setupHint: '点击重新登录',
    };
  } catch {
    return { hasCookie: false, city: cityCode, setupHint: '点击重新登录' };
  }
}

/** 按关键词搜索安居客（用于跨平台比价）。 */
export async function searchAnjukeFromServer(
  cityCode: string,
  query: string,
  page = 1,
): Promise<ScraperBackendResult> {
  const base = getBaseUrl();
  const url = `${base}/api/search/anjuke?city=${encodeURIComponent(cityCode)}&q=${encodeURIComponent(query)}&page=${page}`;
  try {
    const resp = await fetchWithTimeout(url);
    const json = await resp.json();
    if (json.success === false) {
      return { success: false, reason: json.reason ?? '搜索失败', count: 0 };
    }
    return {
      success: true,
      listings: (json.listings ?? []) as ScrapedListing[],
      count: json.count ?? 0,
      page: json.page ?? page,
      platform: json.platform ?? 'anjuke',
    };
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      success: false,
      reason: isAbort ? '搜索超时，请检查爬虫服务' : `搜索失败：${err instanceof Error ? err.message : String(err)}`,
      count: 0,
    };
  }
}

/** 按关键词搜索贝壳（需要 Cookie，用于跨平台比价）。 */
export async function searchBeikeFromServer(
  cityCode: string,
  query: string,
  page = 1,
): Promise<ScraperBackendResult> {
  const base = getBaseUrl();
  const url = `${base}/api/search/beike?city=${encodeURIComponent(cityCode)}&q=${encodeURIComponent(query)}&page=${page}`;
  try {
    const resp = await fetchWithTimeout(url);
    const json = await resp.json();
    if (json.success === false) {
      return { success: false, reason: json.reason ?? '搜索失败', count: 0 };
    }
    return {
      success: true,
      listings: (json.listings ?? []) as ScrapedListing[],
      count: json.count ?? 0,
      page: json.page ?? page,
      platform: json.platform ?? 'beike',
    };
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      success: false,
      reason: isAbort ? '搜索超时，请检查爬虫服务' : `搜索失败：${err instanceof Error ? err.message : String(err)}`,
      count: 0,
    };
  }
}

/** 检查爬虫服务是否在线。 */
export async function checkScraperHealth(): Promise<boolean> {
  try {
    const base = getBaseUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const resp = await fetch(`${base}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

/** 获取当前使用的爬虫服务地址（供 UI 展示）。 */
export function getScraperBaseUrl(): string {
  return getBaseUrl();
}

/** 更新贝壳 Cookie（手机端设置）。 */
export async function updateBeikeCookie(cityCode: string, cookieString: string): Promise<{ success: boolean; message: string }> {
  const base = getBaseUrl();
  const url = `${base}/api/beike/update-cookie`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: cityCode, cookie: cookieString }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await resp.json();
    if (json.success) {
      return { success: true, message: json.message || 'Cookie 已更新' };
    }
    return { success: false, message: json.message || 'Cookie 更新失败' };
  } catch (err: unknown) {
    return {
      success: false,
      message: `无法连接爬虫服务：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
