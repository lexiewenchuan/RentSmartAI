/** 供 Agent 单次 run 使用：在「继续搜索」时排除已展示过的房源 id */

let pendingExcludeListingIds: string[] | null = null;

/** 在调用 runAgent 之前设置；传 null 表示不排除（新搜索或非继续意图） */
export function prepareAgentListingExcludeIds(ids: string[] | null): void {
  pendingExcludeListingIds = ids && ids.length > 0 ? [...new Set(ids)] : null;
}

/** 在 search_listings 执行时读取并清空，避免影响后续请求 */
export function consumeAgentListingExcludeIds(): string[] {
  const out = pendingExcludeListingIds ?? [];
  pendingExcludeListingIds = null;
  return out;
}
