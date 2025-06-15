/** 房源外链在微信/App 内打开时的提示与「检索文本」拼装（贝壳/安居客等） */

export type ListingSourceHint = 'beike' | 'anjuke' | 'generic';

export function detectListingSourceFromUrl(url: string): ListingSourceHint {
  const u = String(url || '').toLowerCase();
  if (u.includes('ke.com') || u.includes('lianjia.com')) return 'beike';
  if (u.includes('anjuke.com')) return 'anjuke';
  return 'generic';
}

/** 外链打开方式的统一免责（反爬 / 登录限制） */
export function getListingExternalOpenDisclaimer(): string {
  return '「复制链接 · 微信打开」与「系统浏览器打开」均可能触发平台反爬、空白页或反复登录，不保证每次成功；若无法打开，请使用官方 App 或通过下方「复制检索文本」在 App 内搜索。';
}

/** 聊天卡片等窄区域用的短免责 */
export function getListingExternalOpenDisclaimerShort(): string {
  return '微信与浏览器打开均可能受反爬或登录限制，不保证可用；建议在官方 App 内用下方标题搜索。';
}

export function getListingWechatHintLines(source: ListingSourceHint): string {
  const tail = '下方按钮仅复制房源标题（与平台列表标题一致），便于在搜索栏粘贴。';
  if (source === 'beike') {
    return `若在微信中提示「认证来源服务不能为空」或需反复登录，属贝壳官方限制。${tail}`;
  }
  if (source === 'anjuke') {
    return `部分安居客链接在微信或浏览器中可能空白。${tail}`;
  }
  return `若链接无法打开，请在对应官方 App 内搜索。${tail}`;
}

/** 仅复制房源标题（与贝壳等平台展示标题一致），便于搜索；无标题时退回小区+户型 */
export function buildListingSearchSnippet(p: {
  title?: string;
  community?: string;
  district?: string;
  roomType?: string;
  price?: number | string;
}): string {
  const title = p.title != null ? String(p.title).trim() : '';
  if (title) {
    return title.length > 120 ? `${title.slice(0, 120)}…` : title;
  }
  const c = p.community != null ? String(p.community).trim() : '';
  const r = p.roomType != null ? String(p.roomType).trim() : '';
  if (c && r) return `${c} ${r}`;
  if (c) return c;
  if (r) return r;
  return '';
}
