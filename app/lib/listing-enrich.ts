import type { Listing } from './storage';

export type DetailExtractPayload = {
  text: string;
  facilities: string[];
  imageUrls: string[];
  listedDaysHint?: string;
};

export const ENRICH_MIN_SCORE = 6;
export const ENRICH_MAX_PER_PAGE = 5;

/** 初筛：分数达标或 Top N，取交集上限 max 套 */
export function pickListingsForEnrichment(
  listings: Listing[],
  options?: { minScore?: number; max?: number },
): Listing[] {
  const minScore = options?.minScore ?? ENRICH_MIN_SCORE;
  const max = options?.max ?? ENRICH_MAX_PER_PAGE;
  const withUrl = listings.filter(l => l.url && l.url.length > 10);
  const byScore = withUrl.filter(l => (l.aiScore || 0) >= minScore);
  const topN = [...withUrl].sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0)).slice(0, max);
  const picked = new Map<string, Listing>();
  for (const l of [...byScore, ...topN]) {
    if (picked.size >= max) break;
    if (!picked.has(l.id)) picked.set(l.id, l);
  }
  return Array.from(picked.values()).slice(0, max);
}

export function detailExtractToPatch(payload: DetailExtractPayload) {
  return {
    detailDescription: payload.text.slice(0, 2000),
    detailImages: payload.imageUrls.slice(0, 8),
    facilities: payload.facilities,
    listedDaysHint: payload.listedDaysHint || undefined,
    detailFetchedAt: new Date().toISOString(),
  };
}

export function needsDetailEnrichment(listing: Listing): boolean {
  if (!listing.url || listing.url.length < 10) return false;
  if (listing.detailFetchedAt) return false;
  return true;
}

export function mergeListingWithExtract(
  listing: Listing,
  payload: DetailExtractPayload,
): Listing {
  return { ...listing, ...detailExtractToPatch(payload) };
}

/** 若缺详情且提供了 enrichFn（WebView 增强），则先增强再返回 */
export async function ensureListingEnriched(
  listing: Listing,
  enrichFn?: (l: Listing) => Promise<Listing>,
): Promise<Listing> {
  if (!needsDetailEnrichment(listing)) return listing;
  if (enrichFn) return enrichFn(listing);
  return listing;
}

/** 解析 WebView postMessage（兼容 pageExtract / detail_extract） */
export function parseDetailExtractMessage(raw: string): DetailExtractPayload | null {
  try {
    const msg = JSON.parse(raw);
    const type = msg.type;
    if (type !== 'pageExtract' && type !== 'detail_extract') return null;
    const text = String(msg.text || '').trim();
    const facilities = Array.isArray(msg.facilities)
      ? msg.facilities.filter((x: unknown) => typeof x === 'string')
      : [];
    const imageUrls = Array.isArray(msg.imageUrls)
      ? msg.imageUrls.filter((x: unknown) => typeof x === 'string')
      : [];
    const listedDaysHint = typeof msg.listedDaysHint === 'string' ? msg.listedDaysHint : '';
    if (text.length < 10 && facilities.length === 0 && imageUrls.length === 0) return null;
    return { text, facilities, imageUrls, listedDaysHint };
  } catch {
    return null;
  }
}
