import { getCompareList, getFavorites, getHistory, getPrefs, type Listing, type UserPrefs } from './storage';

export type AgentContext = {
  prefs: UserPrefs;
  favorites: Listing[];
  history: Listing[];
  compareList: Listing[];
  metadata: {
    favoritesCount: number;
    historyCount: number;
    compareCount: number;
    generatedAt: string;
  };
};

export async function getAgentContext(): Promise<AgentContext> {
  const [prefs, favorites, history, compareList] = await Promise.all([
    getPrefs(),
    getFavorites(),
    getHistory(),
    getCompareList(),
  ]);

  return {
    prefs,
    favorites,
    history,
    compareList,
    metadata: {
      favoritesCount: favorites.length,
      historyCount: history.length,
      compareCount: compareList.length,
      generatedAt: new Date().toISOString(),
    },
  };
}
