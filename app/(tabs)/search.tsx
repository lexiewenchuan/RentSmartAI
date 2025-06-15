import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import FolderSelectorModal from '../components/FolderSelectorModal';
import { batchScoreListings } from '../lib/api';
import { CITIES, HOT_CITIES, searchCities, type City } from '../lib/cities';
import { Colors, Radius, Shadow, Spacing, Typography } from '../lib/design';
import {
  detailExtractToPatch,
  parseDetailExtractMessage,
  pickListingsForEnrichment,
} from '../lib/listing-enrich';
import { WECHAT_UA } from '../lib/platform-search';
import { generateListingId, getDetailExtractScript, getScraperScript, type ScrapedListing } from '../lib/scraper';
import {
  addListingToFolder,
  addToCompare,
  addToHistory,
  clearHistoryByCity,
  clearScrapedPages,
  DEFAULT_PREFS,
  getCompareList,
  getFavoriteFolders,
  getHistory,
  getListingFolders,
  getPlatformLoginStatus,
  getPrefs,
  getScrapedPages,
  markPageScraped,
  patchListingDetail,
  removeFromCompare,
  removeListingFromFolder,
  savePrefs,
  upsertHistoryListings,
  type Listing,
  type UserPrefs
} from '../lib/storage';

// ── 筛选条件类型 ──────────────────────────────────────────────
type RentMode = '整租' | '合租' | '短租' | '公寓';

const SUB_FILTERS: Record<RentMode, string[]> = {
  '整租': ['不限', '一居', '两居', '三居以上'],
  '合租': ['不限', '主卧独卫', '向阳', '独卫', '全女'],
  '短租': ['不限', '7天内', '1个月', '3个月'],
  '公寓': ['不限', '品牌公寓', '酒店式公寓'],
};

function clampSubFilter(mode: RentMode, sub: string): string {
  const opts = SUB_FILTERS[mode];
  return opts.includes(sub) ? sub : '不限';
}

/** 合租 / 关键词等子筛的统一匹配串（标题里的「南卧」等不在 tags 里也能命中） */
function listingHaystack(l: Listing): string {
  const tags = (l.tags || []).join('');
  return `${l.title || ''}${l.roomType || ''}${tags}${l.community || ''}${l.district || ''}${l.floor || ''}${l.area || ''}${l.rentDuration || ''}`;
}

function matchesSunnyShare(hay: string): boolean {
  return /朝南|向阳|南卧|南向|南间|南房|主卧南|次卧南|南面|全明|南北通透|东南卧|西南卧/.test(hay);
}

function matchesMasterWithPrivateBath(hay: string): boolean {
  const hasMaster = /主卧/.test(hay);
  const hasOwnBath = /独卫|独立卫浴|独立卫生间|主卧独卫|套内卫|内独卫/.test(hay);
  return hasMaster && hasOwnBath;
}

function matchesPrivateBath(hay: string): boolean {
  return /独卫|独立卫浴|独立卫生间|内独卫|套内卫/.test(hay);
}

function matchesFemaleOnlyShare(hay: string): boolean {
  return /全女|女生合租|限女生|仅限女|只要女/.test(hay);
}

async function persistRentFilters(mode: RentMode, sub: string) {
  try {
    await savePrefs({ rentMode: mode, subFilter: sub });
  } catch {
    /* 忽略存储失败，避免打断找房操作 */
  }
}

function filterByCityCode(list: Listing[], cityCode: string): Listing[] {
  return list.filter(item => item.cityCode === cityCode);
}

/** 户型子筛选：同时看 roomType 与 title，兼容「一室」「二室」等中文数字写法 */
function matchesRentLayoutFilter(listing: Listing, subFilter: string): boolean {
  const h = `${listing.roomType || ''}${listing.title || ''}`;
  if (subFilter === '一居') {
    return /(1|一|壹)室|一室|一居|1居室|一居室|单间/.test(h);
  }
  if (subFilter === '两居') {
    return /(2|二|两)室|两室|二室|两居|2居室|二居室/.test(h);
  }
  if (subFilter === '三居以上') {
    return /([3-9]室|[三四五六七八九]室|三居|四居|五居|三室|四室|五室|3居|4居|5居)/.test(h);
  }
  return true;
}

// ── 房源站点配置 ────────────────────────────────────────────
type RentalSite = 'beike' | 'anjuke' | 'lianjia';
const CITY_SLUGS: Record<string, { anjuke: string; beike: string; lianjia: string }> = {
  bj: { anjuke: 'bj', beike: 'bj', lianjia: 'bj' },
  sh: { anjuke: 'sh', beike: 'sh', lianjia: 'sh' },
  gz: { anjuke: 'gz', beike: 'gz', lianjia: 'gz' },
  sz: { anjuke: 'sz', beike: 'sz', lianjia: 'sz' },
};

function getCitySlug(cityCode: string, platform: RentalSite): string {
  const hit = CITY_SLUGS[cityCode];
  if (hit) return hit[platform];
  return cityCode;
}

const PLATFORMS: Record<RentalSite, { name: string; urlTemplate: (city: string) => string }> = {
  beike: {
    name: '贝壳租房',
    urlTemplate: (city) => `https://m.ke.com/chuzu/${city}/zufang/`,
  },
  anjuke: {
    name: '安居客',
    urlTemplate: (city) => `https://${city}.zu.anjuke.com/fangyuan/`,
  },
  lianjia: {
    name: '链家',
    urlTemplate: (city) => `https://m.lianjia.com/chuzu/${city}/zufang/`,
  },
};

type ViewMode = 'list' | 'browser';

export default function SearchPage() {
  // ── 状态 ────────────────────────────────────────────────────
  const [prefs, setPrefsState] = useState<UserPrefs>(DEFAULT_PREFS);
  const [rentMode, setRentMode] = useState<RentMode>('整租');
  const [subFilter, setSubFilter] = useState('不限');
  const [platformFilter, setPlatformFilter] = useState<'all' | 'anjuke' | 'beike' | 'lianjia'>('all');
  const [needSubway, setNeedSubway] = useState(false);
  const [needPets, setNeedPets] = useState(false);
  const [budgetMin, setBudgetMin] = useState('');
  const [budgetMax, setBudgetMax] = useState('');
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showCityPicker, setShowCityPicker] = useState(false);
  const [citySearch, setCitySearch] = useState('');
  const [searchText, setSearchText] = useState('');
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [listings, setListings] = useState<Listing[]>([]);
  const [locationInput, setLocationInput] = useState('');
  const [commuteInput, setCommuteInput] = useState('');
  const [otherReqs, setOtherReqs] = useState('');
  
  // ── 浏览器相关状态 ──────────────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedPlatform, setSelectedPlatform] = useState<RentalSite>('anjuke');
  const [webViewUrl, setWebViewUrl] = useState('');
  const [webViewError, setWebViewError] = useState('');
  const webViewRef = useRef<WebView>(null);
  const [aiScoring, setAiScoring] = useState(false);
  const [enrichStatus, setEnrichStatus] = useState('');
  const enrichQueueRef = useRef<Listing[]>([]);
  const enrichIndexRef = useRef(0);
  const enrichWebViewRef = useRef<WebView>(null);
  const [enrichWebViewUrl, setEnrichWebViewUrl] = useState('');

  // ── 自动看房状态 ──────────────────────────────────────────
  const AUTO_VIEW_MAX_PAGES = 20;
  const autoViewRef = useRef<{ active: boolean; platform: RentalSite; page: number } | null>(null);
  const [scrapedPagesAnjuke, setScrapedPagesAnjuke] = useState<Set<number>>(new Set());
  const [scrapedPagesBeike, setScrapedPagesBeike] = useState<Set<number>>(new Set());

  // ── WebView 后台抓取状态 ──────────────────────────────────
  const [scraping, setScraping] = useState(false);
  const [scrapingPlatform, setScrapingPlatform] = useState<RentalSite | null>(null);
  const [scrapingPage, setScrapingPage] = useState(1);
  const [backgroundWebViewUrl, setBackgroundWebViewUrl] = useState('');

  // ── CAPTCHA 手动处理状态 ──────────────────────────────────
  const [showCaptchaModal, setShowCaptchaModal] = useState(false);
  const [captchaUrl, setCaptchaUrl] = useState('');
  const [captchaRetryPlatform, setCaptchaRetryPlatform] = useState<RentalSite | null>(null);
  const captchaWebViewRef = useRef<WebView>(null);

  // ── 收藏夹选择器状态 ──────────────────────────────────────────
  const [showFolderSelector, setShowFolderSelector] = useState(false);
  const [selectedListingForFolder, setSelectedListingForFolder] = useState<Listing | null>(null);

  const router = useRouter();

  function buildFilterSummary(): string {
    const parts: string[] = [];
    parts.push(rentMode);
    if (subFilter && subFilter !== '不限') parts.push(subFilter);

    if (budgetMin && budgetMax) {
      parts.push(`预算${budgetMin}-${budgetMax}元`);
    } else if (budgetMin) {
      parts.push(`预算${budgetMin}元以上`);
    } else if (budgetMax) {
      parts.push(`预算${budgetMax}元以下`);
    } else {
      parts.push('预算不限');
    }

    if (needSubway) parts.push('需近地铁');
    if (needPets) parts.push('可养宠');
    if (locationInput.trim()) parts.push(locationInput.trim());
    if (commuteInput.trim()) parts.push(`通勤到${commuteInput.trim()}`);
    if (otherReqs.trim()) parts.push(`其他要求：${otherReqs.trim()}`);
    return parts.join('·');
  }

  function handoverToAgent() {
    const summary = buildFilterSummary();
    // ★ 纯自然语言表达，不暴露工具名
    const autoMessage = summary 
      ? `我想找房子，我的需求是：${summary}。帮我看看有没有合适的房源。`
      : `我想租房子，请帮我找找合适的房源。`;
    router.push({
      pathname: '/chat',
      params: { autoMessage },
    });
  }

  // 加载存储的偏好和收藏
  useFocusEffect(
    useCallback(() => {
      loadData();
      loadFavoriteState();
    }, [])
  );

  async function loadFavoriteState() {
    // ★ 使用统一的 getAllFavoriteListings 方法，确保数据一致性
    const { getAllFavoriteListings } = require('../lib/storage');
    const favs = await getAllFavoriteListings();
    setFavoriteIds(new Set(favs.map((f: Listing) => f.id)));
  }

  async function loadData() {
    const p = await getPrefs();
    setPrefsState(p);
    setBudgetMin(p.budgetMin);
    setBudgetMax(p.budgetMax);
    setNeedSubway(p.needSubway);
    setNeedPets(p.needPets);
    const rmRaw = (p.rentMode as RentMode) || '整租';
    const rentModeLoaded: RentMode = (['整租', '合租', '短租', '公寓'] as const).includes(rmRaw as RentMode)
      ? (rmRaw as RentMode)
      : '整租';
    setRentMode(rentModeLoaded);
    setSubFilter(clampSubFilter(rentModeLoaded, p.subFilter || '不限'));
    setLocationInput(p.district);
    setCommuteInput(p.commuteAddr);
    setOtherReqs(p.otherReqs);
    const history = await getHistory();
    setListings(filterByCityCode(history, p.city));

    // 收藏状态由 loadFavoriteState 单独处理，避免重复加载
    const compareList = await getCompareList();
    setCompareIds(new Set(compareList.map(c => c.id)));

    const anjukePages = await getScrapedPages(p.city, 'anjuke');
    const beikePages = await getScrapedPages(p.city, 'beike');
    setScrapedPagesAnjuke(new Set(anjukePages.pages));
    setScrapedPagesBeike(new Set(beikePages.pages));
  }

  async function refreshScrapedPages(cityCode: string) {
    const anjukePages = await getScrapedPages(cityCode, 'anjuke');
    const beikePages = await getScrapedPages(cityCode, 'beike');
    setScrapedPagesAnjuke(new Set(anjukePages.pages));
    setScrapedPagesBeike(new Set(beikePages.pages));
  }

  // 切换城市
  async function selectCity(city: City) {
    const updated = await savePrefs({ city: city.code, cityLabel: city.name });
    setPrefsState(updated);
    const history = await getHistory();
    setListings(filterByCityCode(history, city.code));
    if (viewMode === 'browser') {
      const slug = getCitySlug(city.code, selectedPlatform);
      setWebViewUrl(PLATFORMS[selectedPlatform].urlTemplate(slug));
      setWebViewError('');
    }
    setShowCityPicker(false);
    setCitySearch('');

  }

  // 收藏/取消收藏（短按）
  async function toggleFavorite(listing: Listing) {
    const listingFolders = await getListingFolders(listing.id);
    
    // 如果已收藏，取消收藏
    if (listingFolders.length > 0) {
      for (const folderId of listingFolders) {
        await removeListingFromFolder(listing.id, folderId);
      }
      // 立即刷新收藏状态
      await loadFavoriteState();
      Alert.alert('已取消收藏', '已从所有收藏夹中移除');
      return;
    }
    
    // 未收藏，添加到默认收藏夹
    const folders = await getFavoriteFolders();
    if (folders.length === 0) {
      const { createFavoriteFolder } = require('../lib/storage');
      await createFavoriteFolder('默认收藏夹');
      const updatedFolders = await getFavoriteFolders();
      await addListingToFolder(listing, updatedFolders[0].id);
    } else {
      await addListingToFolder(listing, folders[0].id);
    }
    
    // 立即刷新收藏状态
    await loadFavoriteState();
    
    // ★ 不显示提示，只通过爱心变红提供视觉反馈
  }

  // 长按收藏按钮
  async function handleFavoriteLongPress(listing: Listing) {
    const listingFolders = await getListingFolders(listing.id);
    
    if (listingFolders.length > 0) {
      // 已收藏：显示"移动到其他收藏夹"和"取消收藏"
      Alert.alert(
        '收藏管理',
        '选择操作',
        [
          {
            text: '移动到其他收藏夹',
            onPress: () => {
              setSelectedListingForFolder(listing);
              setShowFolderSelector(true);
            },
          },
          {
            text: '取消收藏',
            style: 'destructive',
            onPress: async () => {
              // 从所有收藏夹中移除
              for (const folderId of listingFolders) {
                await removeListingFromFolder(listing.id, folderId);
              }
              setFavoriteIds(prev => {
                const n = new Set(prev);
                n.delete(listing.id);
                return n;
              });
              Alert.alert('已取消收藏', '已从所有收藏夹中移除');
            },
          },
          { text: '取消', style: 'cancel' },
        ]
      );
    } else {
      // 未收藏：显示收藏夹选择器
      setSelectedListingForFolder(listing);
      setShowFolderSelector(true);
    }
  }

  // 选择收藏夹后的处理
  async function handleSelectFolder(folderId: string) {
    if (!selectedListingForFolder) return;
    
    const listingFolders = await getListingFolders(selectedListingForFolder.id);
    
    // 如果已在其他收藏夹，先移除
    for (const oldFolderId of listingFolders) {
      await removeListingFromFolder(selectedListingForFolder.id, oldFolderId);
    }
    
    // 添加到新收藏夹
    await addListingToFolder(selectedListingForFolder, folderId);
    
    // 立即刷新收藏状态，确保UI更新
    await loadFavoriteState();
    
    const folders = await getFavoriteFolders();
    const folder = folders.find(f => f.id === folderId);
    
    if (listingFolders.length > 0) {
      Alert.alert('移动成功', `已移动到「${folder?.name || '收藏夹'}」`);
    } else {
      Alert.alert('收藏成功', `已添加到「${folder?.name || '收藏夹'}」`);
    }
    
    setSelectedListingForFolder(null);
  }

  // 加入/移除对比
  async function toggleCompare(listing: Listing) {
    if (compareIds.has(listing.id)) {
      const updated = await removeFromCompare(listing.id);
      setCompareIds(new Set(updated.map(c => c.id)));
      Alert.alert('提示', '已从对比列表中移除');
    } else {
      const currentList = await getCompareList();
      if (currentList.length >= 5) {
        Alert.alert('提示', '最多只能对比 5 套房源\n请先移除其他房源');
        return;
      }
      const updated = await addToCompare(listing);
      setCompareIds(new Set(updated.map(c => c.id)));
      Alert.alert('已加入对比', `当前对比 ${updated.length}/5 套房源`, [
        { text: '继续挑选', style: 'cancel' },
        { text: '去对比', onPress: () => router.push('/compare') },
      ]);
    }
  }

  // 重置筛选条件
  async function resetFilters() {
    setRentMode('整租');
    setSubFilter('不限');
    setNeedSubway(false);
    setNeedPets(false);
    setBudgetMin('');
    setBudgetMax('');
    setLocationInput('');
    setCommuteInput('');
    setOtherReqs('');
    setPlatformFilter('all');
    setSearchText(''); // ★ 修复：重置搜索关键词
    
    // 立即保存到存储，确保重置生效
    await savePrefs({
      rentMode: '整租',
      subFilter: '不限',
      needSubway: false,
      needPets: false,
      budgetMin: '',
      budgetMax: '',
      district: '',
      commuteAddr: '',
      otherReqs: '',
    });
  }

  // 保存筛选条件
  async function applyFilters() {
    await savePrefs({
      budgetMin, budgetMax, needSubway, needPets,
      rentMode, subFilter, district: locationInput,
      commuteAddr: commuteInput, otherReqs,
    });
    setShowFilterPanel(false);
  }

  async function clearSearchRecordsForCurrentCity() {
    const removed = await clearHistoryByCity(prefs.city);
    await clearScrapedPages(prefs.city, 'anjuke');
    await clearScrapedPages(prefs.city, 'beike');
    setScrapedPagesAnjuke(new Set());
    setScrapedPagesBeike(new Set());
    const history = await getHistory();
    setListings(filterByCityCode(history, prefs.city));
    Alert.alert('已清理', `已清空 ${prefs.cityLabel} 找房记录 ${removed} 条`);
  }

  // ── 自动看房函数 ──────────────────────────────────────────
  function getAutoViewUrl(platform: RentalSite, page: number): string {
    const slug = getCitySlug(prefs.city, platform);
    switch (platform) {
      case 'anjuke':
        return page <= 1
          ? `https://${slug}.zu.anjuke.com/fangyuan/`
          : `https://${slug}.zu.anjuke.com/fangyuan/p${page}/`;
      case 'beike':
        return page <= 1
          ? `https://${slug}.ke.com/zufang/`
          : `https://${slug}.ke.com/zufang/pg${page}/`;
      case 'lianjia':
        return page <= 1
          ? `https://${slug}.lianjia.com/zufang/`
          : `https://${slug}.lianjia.com/zufang/pg${page}/`;
    }
  }

  function fetchAutoViewPage(platform: RentalSite, page: number) {
    if (platform === 'beike') {
      getPlatformLoginStatus().then(ls => {
        if (!ls.beike) {
          Alert.alert('未登录', '贝壳需在设置→平台账号登录后才能自动抓取', [
            { text: '取消', style: 'cancel' },
            { text: '去登录', onPress: () => router.push('/platform-login?platform=beike') },
          ]);
          return;
        }
        startAutoViewPage(platform, page);
      });
      return;
    }
    startAutoViewPage(platform, page);
  }

  function startAutoViewPage(platform: RentalSite, page: number) {
    const url = getAutoViewUrl(platform, page);
    autoViewRef.current = { active: true, platform, page };
    setSelectedPlatform(platform);
    setWebViewUrl(url);
    setWebViewError('');
    setViewMode('browser');
  }

  // ── 浏览器相关函数 ──────────────────────────────────────────
  function openBrowser(platform: RentalSite) {
    const slug = getCitySlug(prefs.city, platform);
    const url = PLATFORMS[platform].urlTemplate(slug);
    setSelectedPlatform(platform);
    setWebViewUrl(url);
    setWebViewError('');
    setViewMode('browser');
  }

  function closeBrowser() {
    autoViewRef.current = null;
    setViewMode('list');
    setWebViewUrl('');
    setWebViewError('');
  }

  function handleWebViewLoad() {
    setWebViewError('');
    const av = autoViewRef.current;
    if (av?.active) {
      // ★ 增加随机延迟（2-5秒），模拟真实用户行为，降低触发验证概率
      const randomDelay = 2000 + Math.random() * 3000;
      setTimeout(() => {
        webViewRef.current?.injectJavaScript(getScraperScript(av.platform));
      }, randomDelay);
    }
  }

  function handleWebViewError() {
    setWebViewError('页面加载失败，请检查网络或稍后重试');
  }

  // ── WebView 后台抓取函数 ──────────────────────────────────
  async function handleAutoScrape(platform: RentalSite) {
    if (scraping) return;

    // 贝壳和链家需要登录
    if (platform === 'beike') {
      const loginStatus = await getPlatformLoginStatus();
      if (!loginStatus.beike) {
        Alert.alert('未登录', '贝壳需要登录后才能抓取', [
          { text: '取消', style: 'cancel' },
          { text: '去登录', onPress: () => router.push('/platform-login?platform=beike') },
        ]);
        return;
      }
    }

    if (platform === 'lianjia') {
      const loginStatus = await getPlatformLoginStatus();
      if (!loginStatus.lianjia) {
        Alert.alert('未登录', '链家需要登录后才能抓取', [
          { text: '取消', style: 'cancel' },
          { text: '去登录', onPress: () => router.push('/platform-login?platform=lianjia') },
        ]);
        return;
      }
    }

    setScraping(true);
    setScrapingPlatform(platform);
    setScrapingPage(1);

    // ★ 构建筛选条件对象，传递给 URL 构建函数
    const filters = {
      rentMode,
      budgetMin,
      budgetMax,
      needSubway,
      needPets,
    };

    const { buildAnjukeUrl, buildBeikeUrl, buildLianjiaUrl, getCitySlug } = require('../lib/webview-scraper');
    const slug = getCitySlug(prefs.city, platform);
    const url = platform === 'anjuke' 
      ? buildAnjukeUrl(slug, 1, filters)
      : platform === 'lianjia'
      ? buildLianjiaUrl(slug, 1, filters)
      : buildBeikeUrl(slug, 1, filters);
    
    setBackgroundWebViewUrl(url);
  }

  function handleBackgroundScrapeResult(result: any) {
    setScraping(false);
    setScrapingPlatform(null);
    setBackgroundWebViewUrl('');

    // ★ 如果 CAPTCHA Modal 正在显示，不显示任何 Alert（避免干扰用户验证）
    if (showCaptchaModal) {
      console.log('[Search] Scrape completed but CAPTCHA modal is showing, skip alert');
      return;
    }

    if (!result.success) {
      Alert.alert('抓取失败', result.reason || '未能提取到房源数据');
      return;
    }

    if (result.count === 0) {
      Alert.alert('提示', '当前页面没有找到房源');
      return;
    }

    // ★ 调试日志：检查后台抓取结果中的 URL
    console.log('[Search] handleBackgroundScrapeResult - listings count:', result.listings?.length);
    if (result.listings && result.listings.length > 0) {
      console.log('[Search] First listing URL:', result.listings[0]?.url?.substring(0, 100));
      console.log('[Search] First listing title:', result.listings[0]?.title?.substring(0, 30));
      console.log('[Search] First listing platform:', result.listings[0]?.platform);
      
      // ★ 使用静默模式，不弹窗打扰用户
      void convertAndSaveListings(result.listings, result.count, { silent: true });
    }
  }

  function handleBackgroundScrapeError(error: string) {
    setScraping(false);
    setScrapingPlatform(null);
    setBackgroundWebViewUrl('');
    Alert.alert('抓取失败', error);
  }

  // ── CAPTCHA 检测处理 ──────────────────────────────────────
  async function handleCaptchaDetected(url: string) {
    console.log('[Search] CAPTCHA detected, URL:', url);
    
    const platform = scrapingPlatform || 'beike';
    
    // ★ 直接显示 CAPTCHA Modal，让用户手动完成验证
    // 不再检查登录状态，因为即使登录了也可能触发验证
    setScraping(false);
    setScrapingPlatform(null);
    setBackgroundWebViewUrl('');
    
    setCaptchaUrl(url);
    setCaptchaRetryPlatform(platform);
    setShowCaptchaModal(true);
    
    console.log(`[Search] CAPTCHA Modal opened for platform: ${platform}`);
  }

  // 监听 CAPTCHA WebView 的导航变化
  function handleCaptchaNavigationChange(navState: any) {
    const currentUrl = navState.url || '';
    console.log('[CAPTCHA WebView] Navigation:', currentUrl);
    
    // ★ 检测验证是否完成：URL 不再包含验证相关关键词
    const isVerifying = 
      currentUrl.includes('/captcha') || 
      currentUrl.includes('/verify') ||
      currentUrl.includes('geetest') ||
      currentUrl.includes('slider') ||
      currentUrl.includes('challenge');
    
    // 如果不在验证中，且URL已经变化（不是初始的captchaUrl），说明验证完成
    if (!isVerifying && captchaUrl && currentUrl !== captchaUrl) {
      console.log('[CAPTCHA WebView] Verification completed, URL changed from:', captchaUrl, 'to:', currentUrl);
      
      // 验证完成，关闭 Modal
      setShowCaptchaModal(false);
      setCaptchaUrl('');
      
      // ★ 延迟1秒后自动重试抓取，给Cookie保存留出时间
      setTimeout(() => {
        if (captchaRetryPlatform) {
          console.log('[CAPTCHA] Auto-retrying scrape after verification for platform:', captchaRetryPlatform);
          // 直接调用重试函数，不需要用户确认
          void retryScrapeAfterCaptcha();
        }
      }, 1000);
    }
  }

  // 验证完成后重试抓取
  async function retryScrapeAfterCaptcha() {
    if (!captchaRetryPlatform) return;
    
    console.log('[Search] Retrying scrape after CAPTCHA verification for platform:', captchaRetryPlatform);
    
    // ★ 保存平台信息到局部变量，避免在setTimeout中丢失
    const platformToRetry = captchaRetryPlatform;
    setCaptchaRetryPlatform(null);
    
    // ★ 立即显示提示，让用户知道正在重试
    Alert.alert(
      '验证完成 ✓',
      '人机验证已通过，正在自动抓取房源...',
      [{ text: '好的' }]
    );
    
    // 延迟 1.5 秒后重试，确保 Cookie 已更新并且 Alert 已显示
    setTimeout(() => {
      console.log('[Search] Executing retry for platform:', platformToRetry);
      void handleAutoScrape(platformToRetry);
    }, 1500);
  }

  // 手动关闭 CAPTCHA Modal
  function closeCaptchaModal() {
    setShowCaptchaModal(false);
    setCaptchaUrl('');
    setCaptchaRetryPlatform(null);
  }

  async function runEnrichPipeline(listings: Listing[]) {
    const picked = pickListingsForEnrichment(listings);
    if (picked.length === 0) {
      setEnrichStatus('');
      return;
    }
    enrichQueueRef.current = picked;
    enrichIndexRef.current = 0;
    const first = picked[0];
    if (!first.url) return;
    setEnrichStatus(`增强详情 1/${picked.length}…`);
    setEnrichWebViewUrl(first.url);
  }

  function advanceEnrichQueue() {
    enrichIndexRef.current += 1;
    const queue = enrichQueueRef.current;
    if (enrichIndexRef.current >= queue.length) {
      setEnrichStatus('');
      setEnrichWebViewUrl('');
      void (async () => {
        const history = await getHistory();
        setListings(filterByCityCode(history, prefs.city));
        Alert.alert('详情增强完成', `已为 ${queue.length} 套高分房源补充详情与图片，可用于砍价与精筛。`);
      })();
      return;
    }
    const next = queue[enrichIndexRef.current];
    if (!next.url) {
      advanceEnrichQueue();
      return;
    }
    setEnrichStatus(`增强详情 ${enrichIndexRef.current + 1}/${queue.length}…`);
    setEnrichWebViewUrl(next.url);
  }

  function handleEnrichWebViewMessage(event: { nativeEvent: { data: string } }) {
    const payload = parseDetailExtractMessage(event.nativeEvent.data);
    const current = enrichQueueRef.current[enrichIndexRef.current];
    if (payload && current) {
      void patchListingDetail(current.id, detailExtractToPatch(payload));
    }
    advanceEnrichQueue();
  }

  // ── 扫描当前页面房源 ──────────────────────────────────────────
  function scanCurrentPage() {
    if (!webViewRef.current) return;
    
    Alert.alert('扫描中', '正在提取当前页面的房源信息...');
    const script = getScraperScript(selectedPlatform);
    webViewRef.current.injectJavaScript(script);
  }

  // ── 处理 WebView 消息（扫描结果）────────────────────────────────
  async function handleWebViewMessage(event: any) {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      
      if (data.type === 'scrape_result') {
        // 自动看房模式
        const av = autoViewRef.current;
        if (av?.active) {
          autoViewRef.current = null;
          if (data.success) {
            await markPageScraped(prefs.city, av.platform, av.page);
            if (av.platform === 'anjuke') {
              setScrapedPagesAnjuke(prev => new Set(prev).add(av.page));
            } else {
              setScrapedPagesBeike(prev => new Set(prev).add(av.page));
            }
          }
          closeBrowser();
          return;
        }

        // 手动扫描模式
        if (!data.success) {
          // ★ 检测是否为人机验证错误
          if (data.needLogin || (data.debug && data.debug.isCaptcha)) {
            // 清除可能已失效的 Cookie
            const { clearBeikeCookie } = require('../lib/storage');
            clearBeikeCookie().catch(() => {});
            
            Alert.alert(
              '需要登录',
              data.reason || '触发人机验证，请先登录贝壳账号',
              [
                { text: '取消', style: 'cancel' },
                { text: '去登录', onPress: () => router.push('/platform-login?platform=beike') },
              ]
            );
            return;
          }
          
          const debugText = data.debug
            ? `\n\n页面：${data.debug.title || '-'}\n链接：${data.debug.url || '-'}`
            : '';
          Alert.alert('扫描失败', (data.reason || '未能提取到房源数据，可能需要滚动页面加载更多房源') + debugText);
          return;
        }
        
        if (data.count === 0) {
          const debugText = data.debug
            ? `\n\n页面：${data.debug.title || '-'}\n链接：${data.debug.url || '-'}`
            : '';
          Alert.alert('提示', '当前页面没有找到房源，请先下拉加载列表，再点扫描。' + debugText);
          return;
        }
        
        await convertAndSaveListings(data.listings as ScrapedListing[], data.count as number);
      }
    } catch {
      Alert.alert('错误', '解析扫描结果失败');
    }
  }

  function sanitizeSourceUrl(platform: string, input?: string): string | undefined {
    if (!input) return undefined;
    
    // ★ 调试日志：检查 URL 字段类型和内容
    console.log('[sanitizeSourceUrl] input:', input, 'type:', typeof input, 'platform:', platform);
    
    try {
      const url = new URL(input);
      const href = url.toString();
      if (platform === 'anjuke') {
        // ★ 修复：安居客 URL 包含 /fangyuan/ 而不是 /zufang/
        if (href.includes('/fangyuan/') || href.includes('/zufang/') || href.includes('/rent/') || href.includes('/x1')) {
          console.log('[sanitizeSourceUrl] Anjuke URL validated:', href.substring(0, 100));
          return href;
        }
        console.log('[sanitizeSourceUrl] Anjuke URL rejected (no matching pattern):', href.substring(0, 100));
        return undefined;
      }
      if (platform === 'beike') {
        if (href.includes('/zufang/') || href.includes('/chuzu/')) return href;
        return undefined;
      }
      return href;
    } catch (e) {
      console.log('[sanitizeSourceUrl] URL parse error:', e);
      return undefined;
    }
  }

  function cleanText(input?: string, fallback = ''): string {
    const text = (input || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    return text;
  }

  // ── 转换并保存房源数据 ────────────────────────────────────────
  async function convertAndSaveListings(
    scrapedListings: ScrapedListing[], 
    scrapedCount?: number,
    options?: { silent?: boolean }
  ) {
    console.log('[convertAndSaveListings] Received listings:', scrapedListings.length);
    console.log('[convertAndSaveListings] First listing:', {
      title: scrapedListings[0]?.title?.substring(0, 50),
      url: scrapedListings[0]?.url?.substring(0, 100),
      platform: scrapedListings[0]?.platform,
    });
    
    // ★ 修复：动态获取当前城市，避免使用过期的 prefs state
    const currentPrefs = await getPrefs();
    const currentCity = currentPrefs.city;
    console.log('[convertAndSaveListings] Current city from prefs:', currentCity);
    
    const converted: Listing[] = scrapedListings.map((item, index) => {
      const titleLower = item.title.toLowerCase();
      const tagsText = item.tags.join('').toLowerCase();
      
      const sanitizedUrl = sanitizeSourceUrl(item.platform, item.url);
      
      if (index === 0) {
        console.log('[convertAndSaveListings] First item conversion:', {
          originalUrl: item.url?.substring(0, 100),
          sanitizedUrl: sanitizedUrl?.substring(0, 100),
          platform: item.platform,
        });
      }
      
      return {
        id: generateListingId(item),
        title: cleanText(item.title, '未知标题'),
        community: cleanText(item.community, '未知小区'),
        district: cleanText(item.district, prefs.cityLabel),
        roomType: cleanText(item.roomType, '未知'),
        area: cleanText(item.area, '未知'),
        floor: cleanText(item.floor, '未知楼层'),
        price: item.price,
        tags: item.tags.map(tag => cleanText(tag)).filter(Boolean).slice(0, 8),
        hasSubway: item.tags.some(t => t.includes('地铁')) || titleLower.includes('地铁'),
        hasPets: item.tags.some(t => t.includes('宠物') || t.includes('可养')) || titleLower.includes('可养'),
        isWhole: !titleLower.includes('合租') && !item.roomType.includes('合租'),
        isShortTerm: titleLower.includes('短租') || tagsText.includes('短租') || tagsText.includes('日租'),
        isApartment: titleLower.includes('公寓') || tagsText.includes('公寓') || tagsText.includes('自如') || tagsText.includes('蛋壳'),
        rentDuration: item.title.match(/(\d+天|\d+个月|\d+月)/)?.[1],
        aiScore: 0, // 初始评分为0，Step 6 会用 AI 计算
        aiComment: '待分析',
        url: sanitizedUrl,
        imageUrl: item.imageUrl,
        platform: item.platform,
        scrapedAt: new Date().toISOString(),
        cityCode: currentCity, // ★ 使用动态获取的城市代码
      };
    });
    
    console.log('[convertAndSaveListings] Converted first listing:', {
      id: converted[0]?.id,
      title: converted[0]?.title?.substring(0, 50),
      url: converted[0]?.url?.substring(0, 100),
      platform: converted[0]?.platform,
    });
    
    // 加入历史并去重
    const result = await addToHistory(converted);
    
    // ★ 修复：先更新列表状态，确保房源立即显示
    const history = await getHistory();
    const cityFiltered = filterByCityCode(history, currentCity);
    setListings(cityFiltered);
    
    console.log('[convertAndSaveListings] Updated listings state:', {
      totalInHistory: history.length,
      filteredForCity: cityFiltered.length,
      cityCode: currentCity,
    });
    
    // ★ 延迟切换视图，确保状态已更新并渲染
    setTimeout(() => {
      setViewMode('list');
    }, 100);
    
    // ★ 显示提示，但不阻塞 UI（静默模式下不显示）
    if (!options?.silent) {
      Alert.alert(
        '扫描完成',
        `成功提取 ${converted.length} 套房源\n新增 ${result.added} 套，跳过重复 ${result.skipped} 套\n\n正在后台进行 AI 初筛...`,
        [{ text: '确定' }],
      );
    }

    // ★ 后台异步执行 AI 评分和详情增强，不阻塞 UI
    runAIScoring(converted, { silent: true })
      .then(scoredList => runEnrichPipeline(scoredList))
      .catch(err => {
        console.error('[convertAndSaveListings] AI scoring/enrichment failed:', err);
        // 即使 AI 评分失败，房源仍然可见，不影响用户使用
      });
  }

  // ── AI 评分 ─────────────────────────────────────────────────
  async function runAIScoring(
    targetListings?: Listing[],
    options?: { silent?: boolean },
  ): Promise<Listing[]> {
    const toScore = targetListings || filtered;
    
    if (toScore.length === 0) {
      if (!options?.silent) Alert.alert('提示', '当前没有可评分的房源');
      return [];
    }
    
    setAiScoring(true);
    
    try {
      const scores = await batchScoreListings(toScore, prefs);
      
      if (scores.size === 0) {
        if (!options?.silent) {
          Alert.alert(
            'AI 评分失败',
            '可能原因：\n1. 网络连接问题\n2. API 额度不足或限流\n3. 本地配置被清空\n\n默认已内置 Key，若你曾修改过配置，请前往「我的」页面检查。',
          );
        }
        return toScore;
      }
      
      const scoredList = toScore.map(listing => {
        const score = scores.get(listing.id);
        if (score) {
          return {
            ...listing,
            aiScore: score.score,
            aiComment: score.comment,
          };
        }
        return listing;
      });
      await upsertHistoryListings(scoredList);
      const history = await getHistory();
      setListings(filterByCityCode(history, prefs.city));
      
      if (!options?.silent) {
        Alert.alert('AI 评分完成', `成功为 ${scores.size} 套房源评分`);
      }
      return scoredList;
    } catch {
      if (!options?.silent) Alert.alert('错误', 'AI 评分过程中出现异常');
      return toScore;
    } finally {
      setAiScoring(false);
    }
  }

  // 本地过滤
  const filtered = listings.filter(l => {
    // 平台筛选
    if (platformFilter !== 'all' && l.platform !== platformFilter) return false;
    
    // 硬性条件
    if (needSubway && !l.hasSubway) return false;
    if (needPets && !l.hasPets) return false;
    if (budgetMin && l.price < parseInt(budgetMin)) return false;
    if (budgetMax && l.price > parseInt(budgetMax)) return false;
    
    // ★ 修复：租房方式筛选改为宽松模式，避免过滤掉所有房源
    // 只有当用户明确选择了租房方式时才进行严格筛选
    // 如果是"整租"模式，允许显示整租和公寓（公寓通常也是整租）
    if (rentMode === '整租' && !l.isWhole && !l.isApartment) return false;
    // 如果是"合租"模式，只过滤掉明确标记为整租的（但保留未明确标记的）
    if (rentMode === '合租' && l.isWhole && !l.isApartment) return false;
    // 短租和公寓保持原有逻辑
    if (rentMode === '短租' && !l.isShortTerm) return false;
    if (rentMode === '公寓' && !l.isApartment && !l.isWhole) return false;
    
    // 子筛选条件
    if (subFilter !== '不限') {
      if (rentMode === '整租') {
        // 户型匹配
        if (subFilter === '一居' && !matchesRentLayoutFilter(l, subFilter)) return false;
        if (subFilter === '两居' && !matchesRentLayoutFilter(l, subFilter)) return false;
        if (subFilter === '三居以上' && !matchesRentLayoutFilter(l, subFilter)) return false;
      } else if (rentMode === '合租') {
        const hay = listingHaystack(l);
        if (subFilter === '主卧独卫' && !matchesMasterWithPrivateBath(hay)) return false;
        if (subFilter === '向阳' && !matchesSunnyShare(hay)) return false;
        if (subFilter === '独卫' && !matchesPrivateBath(hay)) return false;
        if (subFilter === '全女' && !matchesFemaleOnlyShare(hay)) return false;
      } else if (rentMode === '短租') {
        // 租期匹配
        if (subFilter === '7天内' && l.rentDuration && !l.rentDuration.includes('天')) return false;
        if (subFilter === '1个月' && l.rentDuration && !l.rentDuration.includes('月') && parseInt(l.rentDuration) <= 1) return false;
      } else if (rentMode === '公寓') {
        const hay = listingHaystack(l);
        if (subFilter === '品牌公寓' && !/(自如|蛋壳|泊寓|冠寓|品牌公寓|连锁)/.test(hay) && !l.tags.some(t => t.includes('自如') || t.includes('蛋壳') || t.includes('品牌'))) return false;
        if (subFilter === '酒店式公寓' && !/(酒店式|服务式公寓)/.test(hay) && !l.tags.some(t => t.includes('酒店式') || t.includes('服务式'))) return false;
      }
    }
    
    // 位置偏好
    if (locationInput.trim()) {
      const kw = locationInput.toLowerCase();
      const loc = `${l.district}${l.community}`.toLowerCase();
      if (!loc.includes(kw)) return false;
    }
    
    // 关键词搜索
    if (searchText) {
      const kw = searchText.toLowerCase();
      const text = `${l.title}${l.community}${l.district}`.toLowerCase();
      if (!text.includes(kw)) return false;
    }
    
    // 补充说明（模糊匹配）
    if (otherReqs.trim()) {
      const keywords = otherReqs.toLowerCase().split(/[，,\s]+/);
      const fullText = `${l.title}${l.tags.join('')}${l.floor}`.toLowerCase();
      const hasMatch = keywords.some(kw => kw && fullText.includes(kw));
      if (!hasMatch) return false;
    }
    
    return true;
  }).sort((a, b) => b.aiScore - a.aiScore);

  // 城市搜索结果
  const cityResults = citySearch ? searchCities(citySearch) : [];

  return (
    <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
      {/* 顶部搜索栏 */}
      <View style={s.topBar}>
        <TouchableOpacity style={s.cityBtn} onPress={() => setShowCityPicker(true)}>
          <Text style={s.cityText}>{prefs.cityLabel || '北京'}</Text>
          <Text style={s.cityArrow}>▾</Text>
        </TouchableOpacity>
        <View style={s.searchBox}>
          <TextInput
            style={s.searchInput}
            placeholder="搜索商圈、小区名"
            placeholderTextColor={Colors.textTertiary}
            value={searchText}
            onChangeText={setSearchText}
          />
          {searchText ? (
            <TouchableOpacity onPress={() => setSearchText('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={18} color={Colors.textTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity style={s.agentBtn} onPress={handoverToAgent}>
          <Ionicons name="chatbubble-ellipses-outline" size={16} color={Colors.primary} />
          <Text style={s.agentBtnText} numberOfLines={1}>Agent 接管</Text>
        </TouchableOpacity>
      </View>

      {/* 站点入口（列表模式）*/}
      {viewMode === 'list' && (
        <View style={s.platformBar}>
          <Text style={s.platformLabel}>在线看房</Text>
          <View style={s.platformBtns}>
            <TouchableOpacity
              style={[s.platformBtn, { backgroundColor: '#4CAF50' }]}
              onPress={() => openBrowser('anjuke')}
            >
              <Text style={s.platformBtnText}>安居客</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.platformBtn, { backgroundColor: '#2E7D32' }]}
              onPress={() => openBrowser('beike')}
            >
              <Text style={s.platformBtnText}>贝壳</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.platformBtn, { backgroundColor: '#1B5E20' }]}
              onPress={() => openBrowser('lianjia')}
            >
              <Text style={s.platformBtnText}>链家</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={s.clearSearchBtn}
            onPress={() =>
              Alert.alert(
                '确认清空',
                `确认清空 ${prefs.cityLabel} 在找房界面的缓存记录吗？`,
                [
                  { text: '取消', style: 'cancel' },
                  { text: '清空', style: 'destructive', onPress: clearSearchRecordsForCurrentCity },
                ]
              )
            }
          >
            <Text style={s.clearSearchBtnText}>清理记录</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 自动抓取 */}
      {viewMode === 'list' && (
        <View style={s.serverBar}>
          <View style={s.autoViewTopRow}>
            <TouchableOpacity
              style={[s.autoViewPlatformBtn, { backgroundColor: '#4CAF50' }, scraping && s.btnDisabled]}
              onPress={() => handleAutoScrape('anjuke')}
              disabled={scraping}
            >
              {scraping && scrapingPlatform === 'anjuke' ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={s.autoViewPlatformBtnText}>安居客自动抓取</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.autoViewPlatformBtn, { backgroundColor: '#2E7D32' }, scraping && s.btnDisabled]}
              onPress={() => handleAutoScrape('beike')}
              disabled={scraping}
            >
              {scraping && scrapingPlatform === 'beike' ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={s.autoViewPlatformBtnText}>贝壳自动抓取</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.autoViewPlatformBtn, { backgroundColor: '#1B5E20' }, scraping && s.btnDisabled]}
              onPress={() => handleAutoScrape('lianjia')}
              disabled={scraping}
            >
              {scraping && scrapingPlatform === 'lianjia' ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={s.autoViewPlatformBtnText}>链家自动抓取</Text>
              )}
            </TouchableOpacity>
          </View>
          {scraping && (
            <Text style={s.enrichStatusText}>
              正在获取房源... 第 {scrapingPage} 页
            </Text>
          )}
        </View>
      )}

      {/* 浏览器顶栏（浏览器模式）*/}
      {viewMode === 'browser' && (
        <View style={s.browserBar}>
          <TouchableOpacity style={s.backBtn} onPress={closeBrowser}>
            <Text style={s.backBtnText}>← 返回</Text>
          </TouchableOpacity>
          <Text style={s.browserTitle}>{PLATFORMS[selectedPlatform].name}</Text>
          <TouchableOpacity
            style={s.refreshBtn}
            onPress={() => webViewRef.current?.reload()}
          >
            <Text style={s.refreshBtnText}>↻</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 根据视图模式显示内容 */}
      {viewMode === 'browser' ? (
        // ── 浏览器模式 ──
        <View style={{ flex: 1, backgroundColor: '#fff' }}>
          {webViewError ? (
            <View style={s.errorState}>
              <Text style={s.errorIcon}>⚠️</Text>
              <Text style={s.errorText}>{webViewError}</Text>
              <TouchableOpacity
                style={s.retryBtn}
                onPress={() => {
                  setWebViewError('');
                  webViewRef.current?.reload();
                }}
              >
                <Text style={s.retryBtnText}>重试</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <WebView
                ref={webViewRef}
                source={{ uri: webViewUrl }}
                userAgent={WECHAT_UA}
                onLoad={handleWebViewLoad}
                onError={handleWebViewError}
                onMessage={handleWebViewMessage}
                style={{ flex: 1 }}
                startInLoadingState
                javaScriptEnabled
                domStorageEnabled
                sharedCookiesEnabled
                thirdPartyCookiesEnabled
                renderLoading={() => (
                  <View style={s.loadingState}>
                    <ActivityIndicator size="large" color="#00ae66" />
                    <Text style={s.loadingText}>加载中...</Text>
                  </View>
                )}
              />
              {/* 底部"一键扫描"按钮 */}
              <View style={s.browserFooter}>
                <TouchableOpacity
                  style={s.scanBtn}
                  onPress={scanCurrentPage}
                >
                  <Ionicons name="scan-outline" size={22} color={Colors.textInverse} />
                  <Text style={s.scanBtnText}>AI 扫描当前页</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      ) : (
        // ── 列表模式（保持原有逻辑）──
        <>
      {/* 一级筛选 */}
      <View style={s.filterBar}>
        {(['整租', '合租', '短租', '公寓'] as RentMode[]).map(mode => (
          <TouchableOpacity
            key={mode}
            style={[s.filterChip, rentMode === mode && s.filterChipActive]}
            onPress={() => {
              setRentMode(mode);
              setSubFilter('不限');
              void persistRentFilters(mode, '不限');
            }}
          >
            <Text style={[s.filterChipText, rentMode === mode && s.filterChipTextActive]}>
              {mode}
            </Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={s.moreFilterBtn} onPress={() => setShowFilterPanel(true)}>
          <Text style={s.moreFilterText}>筛选</Text>
          <Text style={s.moreFilterIcon}>▾</Text>
        </TouchableOpacity>
      </View>

      {/* 二级筛选 */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.subFilterBar}>
        {SUB_FILTERS[rentMode].map(sub => (
          <TouchableOpacity
            key={sub}
            style={[s.subChip, subFilter === sub && s.subChipActive]}
            onPress={() => {
              setSubFilter(sub);
              void persistRentFilters(rentMode, sub);
            }}
          >
            <Text style={[s.subChipText, subFilter === sub && s.subChipTextActive]}>{sub}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          style={[s.subChip, needSubway && s.subChipActive]}
          onPress={() => setNeedSubway(!needSubway)}
        >
          <Text style={[s.subChipText, needSubway && s.subChipTextActive]}>🚇 近地铁</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.subChip, needPets && s.subChipActive]}
          onPress={() => setNeedPets(!needPets)}
        >
          <Text style={[s.subChipText, needPets && s.subChipTextActive]}>🐾 可养宠</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* 平台筛选（单独一行）*/}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.subFilterBar}>
        <TouchableOpacity
          style={[s.subChip, platformFilter === 'all' && s.subChipActive]}
          onPress={() => setPlatformFilter('all')}
        >
          <Text style={[s.subChipText, platformFilter === 'all' && s.subChipTextActive]}>全部平台</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.subChip, platformFilter === 'anjuke' && s.subChipActive]}
          onPress={() => setPlatformFilter('anjuke')}
        >
          <Text style={[s.subChipText, platformFilter === 'anjuke' && s.subChipTextActive]}>安居客</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.subChip, platformFilter === 'beike' && s.subChipActive]}
          onPress={() => setPlatformFilter('beike')}
        >
          <Text style={[s.subChipText, platformFilter === 'beike' && s.subChipTextActive]}>贝壳</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.subChip, platformFilter === 'lianjia' && s.subChipActive]}
          onPress={() => setPlatformFilter('lianjia')}
        >
          <Text style={[s.subChipText, platformFilter === 'lianjia' && s.subChipTextActive]}>链家</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* 结果计数 */}
      <View style={s.resultBar}>
        <Text style={s.resultCount}>
          共 <Text style={s.resultNum}>{filtered.length}</Text> 套
          {filtered.length < listings.length ? '（已过滤）' : ''}
        </Text>
        <TouchableOpacity
          style={s.aiScoreBtn}
          onPress={() => runAIScoring()}
          disabled={aiScoring || filtered.length === 0}
        >
          <Text style={[s.aiScoreBtnText, (aiScoring || filtered.length === 0) && s.aiScoreBtnTextDis]}>
            {aiScoring ? '⏳ 评分中...' : '🤖 AI评分'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* 房源列表 - 使用 FlatList 优化性能 */}
      <FlatList
        style={s.listWrap}
        data={filtered}
        removeClippedSubviews
        initialNumToRender={8}
        windowSize={8}
        maxToRenderPerBatch={8}
        updateCellsBatchingPeriod={60}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={s.card}
            activeOpacity={0.7}
            onPress={() => router.push(`/listing/${item.id}`)}
          >
            <View style={s.cardImg}>
              <Ionicons name="home-outline" size={28} color={Colors.textTertiary} />
            </View>
            <View style={s.cardBody}>
              <View style={s.cardTitleRow}>
                <Text style={s.cardTitle} numberOfLines={1}>{item.title}</Text>
                <View style={s.cardActions}>
                  <TouchableOpacity
                    style={s.compareBtn}
                    onPress={() => toggleCompare(item)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons
                      name={compareIds.has(item.id) ? 'bar-chart' : 'bar-chart-outline'}
                      size={18}
                      color={compareIds.has(item.id) ? Colors.primary : Colors.textSecondary}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.favBtn}
                    onPress={() => toggleFavorite(item)}
                    onLongPress={() => handleFavoriteLongPress(item)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons
                      name={favoriteIds.has(item.id) ? 'heart' : 'heart-outline'}
                      size={18}
                      color={favoriteIds.has(item.id) ? '#e74c3c' : Colors.textSecondary}
                    />
                  </TouchableOpacity>
                </View>
              </View>

              <Text style={s.cardInfo}>{item.roomType}　{item.area}　{item.floor}</Text>
              <View style={s.cardLocationRow}>
                <Ionicons name="location-outline" size={12} color={Colors.textSecondary} style={{ marginRight: 2 }} />
                <Text style={s.cardLocation}>{item.community}　{item.district}</Text>
              </View>

              <View style={s.tagRow}>
                {/* 房源来源标签 - 优先显示 */}
                {(() => {
                  const platformLabel = 
                    item.platform === 'anjuke' ? '安居客' : 
                    item.platform === 'beike' ? '贝壳' : 
                    item.platform === 'lianjia' ? '链家' :
                    item.platform === 'ziroom' ? '自如' :
                    item.platform === 'w58' ? '58同城' :
                    item.aiComment?.includes('海报识别') ? '海报识别' : 
                    item.platform ? item.platform : null;
                  
                  return platformLabel ? (
                    <View style={[s.tag, s.tagPlatform]}>
                      <Text style={[s.tagText, s.tagTextPlatform]}>
                        {platformLabel}
                      </Text>
                    </View>
                  ) : null;
                })()}
                {item.tags.slice(0, 3).map((tag, index) => (
                  <View key={`${item.id}-tag-${index}-${tag}`} style={[s.tag, tag === '近地铁' && s.tagGreen, tag === '可养宠' && s.tagOrange]}>
                    <Text style={[s.tagText, tag === '近地铁' && s.tagTextGreen, tag === '可养宠' && s.tagTextOrange]}>{tag}</Text>
                  </View>
                ))}
              </View>

              <View style={s.cardBottom}>
                <Text style={s.cardPrice}>{item.price}<Text style={s.cardPriceUnit}> 元/月</Text></Text>
                <View style={[s.scoreBadge, item.aiScore >= 8 ? s.scoreHigh : item.aiScore >= 6 ? s.scoreMid : s.scoreLow]}>
                  <Text style={[s.scoreText, item.aiScore >= 8 ? s.scoreTextHigh : item.aiScore >= 6 ? s.scoreTextMid : s.scoreTextLow]}>AI {item.aiScore}</Text>
                </View>
              </View>

              <View style={s.aiRow}>
                <Ionicons name="sparkles-outline" size={11} color={Colors.primary} style={{ marginRight: 3, marginTop: 1 }} />
                <Text style={s.aiComment} numberOfLines={1}>{item.aiComment}</Text>
              </View>
            </View>
          </TouchableOpacity>
        )}
        keyExtractor={item => item.id}
        ListEmptyComponent={
          <View style={s.emptyState}>
            <Ionicons
              name={listings.length === 0 ? 'file-tray-outline' : 'search-outline'}
              size={52}
              color={Colors.textTertiary}
              style={{ marginBottom: 12 }}
            />
            <Text style={s.emptyTitle}>
              {listings.length === 0 ? `${prefs.cityLabel}暂无已抓取房源` : '没有符合条件的房源'}
            </Text>
            <Text style={s.emptyDesc}>
              {listings.length === 0 ? '请先进入在线看房并执行 AI 扫描当前页' : '试试放宽筛选条件'}
            </Text>
          </View>
        }
        ListFooterComponent={<View style={{ height: 40 }} />}
        scrollEnabled
      />

      {/* ── 城市选择器 ── */}
      <Modal visible={showCityPicker} animationType="slide" transparent>
        <View style={s.modalOverlay}>
          <View style={[s.modalPanel, { maxHeight: '90%' }]}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>选择城市</Text>
              <TouchableOpacity onPress={() => { setShowCityPicker(false); setCitySearch(''); }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* 搜索框 */}
            <View style={s.citySearchBox}>
              <TextInput
                style={s.citySearchInput}
                placeholder="输入城市名或拼音"
                placeholderTextColor={Colors.textTertiary}
                value={citySearch}
                onChangeText={setCitySearch}
                autoFocus
              />
              {citySearch ? (
                <TouchableOpacity onPress={() => setCitySearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={18} color={Colors.textTertiary} />
                </TouchableOpacity>
              ) : null}
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* 搜索结果 */}
              {citySearch ? (
                <View style={s.citySection}>
                  {cityResults.length ? cityResults.map(c => (
                    <TouchableOpacity
                      key={c.code}
                      style={[s.cityItem, prefs.city === c.code && s.cityItemActive]}
                      onPress={() => selectCity(c)}
                    >
                      <Text style={[s.cityItemText, prefs.city === c.code && s.cityItemTextActive]}>
                        {c.name}
                      </Text>
                      {prefs.city === c.code && <Text style={s.cityCheck}>✓</Text>}
                    </TouchableOpacity>
                  )) : (
                    <Text style={s.cityEmpty}>没有找到「{citySearch}」</Text>
                  )}
                </View>
              ) : (
                <>
                  {/* 当前城市 */}
                  <View style={s.citySection}>
                    <Text style={s.citySectionLabel}>当前城市</Text>
                    <View style={s.cityGrid}>
                      <View style={[s.cityItem, s.cityItemActive]}>
                        <Text style={[s.cityItemText, s.cityItemTextActive]}>{prefs.cityLabel}</Text>
                      </View>
                    </View>
                  </View>

                  {/* 热门城市 */}
                  <View style={s.citySection}>
                    <Text style={s.citySectionLabel}>热门城市</Text>
                    <View style={s.cityGrid}>
                      {HOT_CITIES.map(c => (
                        <TouchableOpacity
                          key={c.code}
                          style={[s.cityItem, prefs.city === c.code && s.cityItemActive]}
                          onPress={() => selectCity(c)}
                        >
                          <Text style={[s.cityItemText, prefs.city === c.code && s.cityItemTextActive]}>
                            {c.name}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>

                  {/* 全部城市 */}
                  <View style={s.citySection}>
                    <Text style={s.citySectionLabel}>全部城市</Text>
                    <View style={s.cityGrid}>
                      {CITIES.filter(c => !c.hot).map(c => (
                        <TouchableOpacity
                          key={c.code}
                          style={[s.cityItem, prefs.city === c.code && s.cityItemActive]}
                          onPress={() => selectCity(c)}
                        >
                          <Text style={[s.cityItemText, prefs.city === c.code && s.cityItemTextActive]}>
                            {c.name}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                </>
              )}
              <View style={{ height: 40 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── 筛选面板 ── */}
      <Modal visible={showFilterPanel} animationType="slide" transparent>
        <View style={s.modalOverlay}>
          <View style={s.modalPanel}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>筛选条件</Text>
              <TouchableOpacity onPress={() => setShowFilterPanel(false)}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* 预算 */}
              <View style={s.modalSection}>
                <Text style={s.modalLabel}>💰 预算（元/月）</Text>
                <View style={s.budgetRow}>
                  <TextInput style={s.budgetInput} placeholder="最低" placeholderTextColor="#bbb" keyboardType="numeric" value={budgetMin} onChangeText={setBudgetMin} />
                  <Text style={s.budgetSep}>—</Text>
                  <TextInput style={s.budgetInput} placeholder="最高" placeholderTextColor="#bbb" keyboardType="numeric" value={budgetMax} onChangeText={setBudgetMax} />
                </View>
              </View>

              {/* 租房方式 */}
              <View style={s.modalSection}>
                <Text style={s.modalLabel}>租房方式</Text>
                <View style={s.chipRow}>
                  {(['整租', '合租', '短租', '公寓'] as RentMode[]).map(mode => (
                    <TouchableOpacity key={mode} style={[s.modalChip, rentMode === mode && s.modalChipActive]}
                      onPress={() => {
                        setRentMode(mode);
                        setSubFilter('不限');
                        void persistRentFilters(mode, '不限');
                      }}>
                      <Text style={[s.modalChipText, rentMode === mode && s.modalChipTextActive]}>{mode}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* 子条件 */}
              <View style={s.modalSection}>
                <Text style={s.modalLabel}>
                  {rentMode === '整租' ? '户型' : rentMode === '合租' ? '合租要求' : rentMode === '短租' ? '租期' : '公寓类型'}
                </Text>
                <View style={s.chipRow}>
                  {SUB_FILTERS[rentMode].map(sub => (
                    <TouchableOpacity key={sub} style={[s.modalChip, subFilter === sub && s.modalChipActive]}
                      onPress={() => {
                        setSubFilter(sub);
                        void persistRentFilters(rentMode, sub);
                      }}>
                      <Text style={[s.modalChipText, subFilter === sub && s.modalChipTextActive]}>{sub}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* 硬性条件 */}
              <View style={s.modalSection}>
                <Text style={s.modalLabel}>硬性条件</Text>
                <View style={s.chipRow}>
                  <TouchableOpacity style={[s.modalChip, needSubway && s.modalChipActive]}
                    onPress={() => setNeedSubway(!needSubway)}>
                    <Text style={[s.modalChipText, needSubway && s.modalChipTextActive]}>近地铁</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.modalChip, needPets && s.modalChipActive]}
                    onPress={() => setNeedPets(!needPets)}>
                    <Text style={[s.modalChipText, needPets && s.modalChipTextActive]}>可养宠</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* 位置偏好 */}
              <View style={s.modalSection}>
                <Text style={s.modalLabel}>位置偏好</Text>
                <TextInput style={s.modalInput} placeholder="商圈 / 行政区 / 地铁线"
                  placeholderTextColor="#bbb" value={locationInput} onChangeText={setLocationInput} />
                <TextInput style={[s.modalInput, { marginTop: 8 }]} placeholder="公司地址（用于计算通勤）"
                  placeholderTextColor="#bbb" value={commuteInput} onChangeText={setCommuteInput} />
              </View>

              {/* 补充说明 */}
              <View style={s.modalSection}>
                <Text style={s.modalLabel}>补充说明</Text>
                <TextInput style={[s.modalInput, { height: 72, textAlignVertical: 'top' }]}
                  multiline placeholder="例：需要电梯、南向、押一付一..." placeholderTextColor="#bbb"
                  value={otherReqs} onChangeText={setOtherReqs} />
              </View>
              <View style={{ height: 20 }} />
            </ScrollView>

            <View style={s.modalFooter}>
              <TouchableOpacity style={s.resetBtn} onPress={resetFilters}>
                <Text style={s.resetBtnText}>重置</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.applyBtn} onPress={applyFilters}>
                <Text style={s.applyBtnText}>确认筛选（{filtered.length} 套）</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── 收藏夹选择器 ── */}
      <FolderSelectorModal
        visible={showFolderSelector}
        onClose={() => {
          setShowFolderSelector(false);
          setSelectedListingForFolder(null);
        }}
        onSelectFolder={handleSelectFolder}
        title={selectedListingForFolder && favoriteIds.has(selectedListingForFolder.id) ? '移动到收藏夹' : '选择收藏夹'}
      />
        </>
      )}

      {enrichWebViewUrl ? (
        <View style={{ height: 0, width: 0, overflow: 'hidden' }}>
          <WebView
            ref={enrichWebViewRef}
            source={{ uri: enrichWebViewUrl }}
            userAgent={WECHAT_UA}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            javaScriptEnabled
            onLoadEnd={() => {
              setTimeout(() => {
                enrichWebViewRef.current?.injectJavaScript(getDetailExtractScript());
              }, 2000);
            }}
            onMessage={handleEnrichWebViewMessage}
          />
        </View>
      ) : null}

      {/* 后台 WebView 抓取组件 */}
      {backgroundWebViewUrl ? (
        (() => {
          const { BackgroundWebView } = require('../components/BackgroundWebView');
          return (
            <BackgroundWebView
              url={backgroundWebViewUrl}
              platform={scrapingPlatform || 'anjuke'}
              onExtracted={handleBackgroundScrapeResult}
              onError={handleBackgroundScrapeError}
              onCaptchaDetected={handleCaptchaDetected}
            />
          );
        })()
      ) : null}

      {/* CAPTCHA 手动验证 Modal - 使用 presentationStyle 确保全屏覆盖 */}
      <Modal 
        visible={showCaptchaModal} 
        animationType="slide" 
        transparent={false}
        presentationStyle="fullScreen"
        statusBarTranslucent
      >
        <SafeAreaView style={s.captchaModalContainer}>
          <View style={s.captchaHeader}>
            <Text style={s.captchaTitle}>🤖 人机验证</Text>
            <TouchableOpacity onPress={closeCaptchaModal} style={s.captchaCloseBtn}>
              <Ionicons name="close" size={24} color={Colors.textPrimary} />
            </TouchableOpacity>
          </View>
          
          <View style={s.captchaHint}>
            <Ionicons name="information-circle-outline" size={20} color={Colors.primary} />
            <Text style={s.captchaHintText}>
              请完成下方的人机验证，验证通过后会自动继续抓取
            </Text>
          </View>

          {captchaUrl ? (
            <WebView
              ref={captchaWebViewRef}
              source={{ uri: captchaUrl }}
              userAgent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
              onNavigationStateChange={handleCaptchaNavigationChange}
              javaScriptEnabled
              domStorageEnabled
              sharedCookiesEnabled
              thirdPartyCookiesEnabled
              style={s.captchaWebView}
              startInLoadingState
              renderLoading={() => (
                <View style={s.loadingState}>
                  <ActivityIndicator size="large" color={Colors.primary} />
                  <Text style={s.loadingText}>加载验证页面...</Text>
                </View>
              )}
            />
          ) : null}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

// ── 样式 ──────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bgSecondary },

  topBar: {
    backgroundColor: Colors.bgPrimary,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  cityBtn: { flexDirection: 'row', alignItems: 'center', marginRight: Spacing.md, paddingVertical: Spacing.xs },
  cityText: { ...Typography.h3, color: Colors.textPrimary },
  cityArrow: { fontSize: 10, color: Colors.textTertiary, marginLeft: Spacing.xs },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.divider,
    paddingHorizontal: Spacing.md,
    height: 36,
  },
  searchInput: { flex: 1, ...Typography.body1, color: Colors.textPrimary, padding: 0, minWidth: 0 },
  agentBtn: {
    marginLeft: Spacing.sm,
    maxWidth: 112,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primaryLight,
    borderWidth: 1,
    borderColor: Colors.primary,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.xs,
    paddingVertical: Spacing.sm,
  },
  agentBtnText: { flexShrink: 1, fontSize: 11, color: Colors.primary, fontWeight: '700' },

  filterBar: {
    backgroundColor: Colors.bgPrimary,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    gap: Spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  filterChip: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.xs, borderRadius: 16, backgroundColor: Colors.bgSecondary },
  filterChipActive: { backgroundColor: Colors.primaryLight },
  filterChipText: { ...Typography.body2, color: Colors.textSecondary },
  filterChipTextActive: { color: Colors.primary, fontWeight: '600' },
  moreFilterBtn: { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto', paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs },
  moreFilterText: { ...Typography.body2, color: Colors.textSecondary },
  moreFilterIcon: { fontSize: 10, color: Colors.textTertiary, marginLeft: Spacing.xs },

  subFilterBar: {
    backgroundColor: Colors.bgPrimary,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
    flexGrow: 0,
  },
  subChip: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs, borderRadius: 14, backgroundColor: Colors.bgSecondary, marginRight: Spacing.md },
  subChipActive: { backgroundColor: Colors.primary },
  subChipText: { fontSize: 12, color: Colors.textSecondary },
  subChipTextActive: { color: Colors.textInverse, fontWeight: '500' },

  resultBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  resultCount: { ...Typography.body2, color: Colors.textSecondary },
  resultNum: { color: Colors.primary, fontWeight: '600' },
  aiScoreBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: 12,
    backgroundColor: Colors.primaryLight,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  aiScoreBtnText: { fontSize: 12, color: Colors.primary, fontWeight: '600' },
  aiScoreBtnTextDis: { color: Colors.textTertiary },

  listWrap: { flex: 1 },
  card: {
    backgroundColor: Colors.bgPrimary,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    borderRadius: Radius.lg,
    flexDirection: 'row',
    overflow: 'hidden',
    ...Shadow.xs,
  },
  cardImg: { width: 110, backgroundColor: '#f0f0f0', alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1, padding: Spacing.md },
  cardTitleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs },
  cardTitle: { ...Typography.h4, color: Colors.textPrimary, marginBottom: Spacing.xs, flex: 1 },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  compareBtn: { paddingLeft: Spacing.xs, paddingTop: 2 },
  favBtn: { paddingLeft: Spacing.xs, paddingTop: 2 },
  cardInfo: { ...Typography.label, color: Colors.textSecondary, marginBottom: 3 },
  cardLocationRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  cardLocation: { ...Typography.label, color: Colors.textTertiary },

  tagRow: { flexDirection: 'row', gap: Spacing.xs, marginBottom: Spacing.md },
  tag: { paddingHorizontal: Spacing.xs, paddingVertical: 2, borderRadius: Radius.sm, backgroundColor: Colors.bgSecondary },
  tagGreen: { backgroundColor: Colors.primaryLight },
  tagOrange: { backgroundColor: '#fff3e6' },
  tagPlatform: { backgroundColor: '#e8f5e9' },
  tagText: { fontSize: 10, color: Colors.textSecondary },
  tagTextGreen: { color: Colors.primary },
  tagTextOrange: { color: Colors.warning },
  tagTextPlatform: { color: '#2e7d32', fontWeight: '600' },

  cardBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md },
  cardPrice: { fontSize: 18, fontWeight: '700', color: '#fe5500' },
  cardPriceUnit: { fontSize: 12, fontWeight: '400', color: Colors.textSecondary },

  scoreBadge: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs, borderRadius: 10 },
  scoreHigh: { backgroundColor: Colors.primaryLight },
  scoreMid: { backgroundColor: '#fff8e6' },
  scoreLow: { backgroundColor: '#fff0f0' },
  scoreText: { fontSize: 11, fontWeight: '600' },
  scoreTextHigh: { color: Colors.primary },
  scoreTextMid: { color: Colors.warning },
  scoreTextLow: { color: Colors.error },

  aiRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.bgSecondary, borderRadius: Radius.sm, padding: Spacing.xs },
  aiComment: { fontSize: 11, color: Colors.textSecondary, flex: 1 },

  emptyState: { alignItems: 'center', paddingVertical: 60 },
  emptyTitle: { ...Typography.h3, color: Colors.textPrimary },
  emptyDesc: { ...Typography.body2, color: Colors.textSecondary, marginTop: Spacing.md },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalPanel: { backgroundColor: Colors.bgPrimary, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%', paddingTop: Spacing.lg },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: Spacing.lg, marginBottom: Spacing.lg },
  modalTitle: { ...Typography.h2, color: Colors.textPrimary },
  modalClose: { fontSize: 20, color: Colors.textTertiary, padding: Spacing.xs },

  modalSection: { paddingHorizontal: Spacing.lg, marginBottom: Spacing.xl },
  modalLabel: { ...Typography.h4, color: Colors.textPrimary, marginBottom: Spacing.md },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  modalChip: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: 20,
    backgroundColor: Colors.bgSecondary,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  modalChipActive: { backgroundColor: Colors.primaryLight, borderColor: Colors.primary },
  modalChipText: { ...Typography.body2, color: Colors.textSecondary },
  modalChipTextActive: { color: Colors.primary, fontWeight: '600' },

  budgetRow: { flexDirection: 'row', alignItems: 'center' },
  budgetInput: {
    flex: 1,
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    padding: Spacing.md,
    ...Typography.body1,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  budgetSep: { color: Colors.divider, marginHorizontal: Spacing.lg },

  modalInput: {
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    padding: Spacing.md,
    ...Typography.body1,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: Colors.divider,
  },

  modalFooter: {
    flexDirection: 'row',
    padding: Spacing.lg,
    gap: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.divider,
  },
  resetBtn: {
    flex: 1,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.divider,
    alignItems: 'center',
  },
  resetBtnText: { ...Typography.h4, color: Colors.textSecondary },
  applyBtn: { flex: 2, paddingVertical: Spacing.lg, borderRadius: Radius.md, backgroundColor: Colors.primary, alignItems: 'center' },
  applyBtnText: { ...Typography.h4, fontWeight: '600', color: Colors.textInverse },

  // City picker
  citySearchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.lg,
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.divider,
    paddingHorizontal: Spacing.md,
    height: 40,
  },
  citySearchInput: { flex: 1, ...Typography.body1, color: Colors.textPrimary, padding: 0 },

  citySection: { paddingHorizontal: Spacing.lg, marginBottom: Spacing.xl },
  citySectionLabel: { ...Typography.label, color: Colors.textTertiary, marginBottom: Spacing.md },
  cityGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  cityItem: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: Colors.bgSecondary,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  cityItemActive: { backgroundColor: Colors.primaryLight, borderColor: Colors.primary },
  cityItemText: { ...Typography.body1, color: Colors.textSecondary },
  cityItemTextActive: { color: Colors.primary, fontWeight: '600' },
  cityCheck: { color: Colors.primary, fontSize: 12, marginLeft: Spacing.xs },
  cityEmpty: { ...Typography.body1, color: Colors.textSecondary, textAlign: 'center', paddingVertical: Spacing.xl },

  // 站点入口
  platformBar: {
    backgroundColor: Colors.bgPrimary,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  platformLabel: { ...Typography.body2, color: Colors.textSecondary, fontWeight: '600', marginRight: Spacing.xs },
  platformBtns: { flexDirection: 'row', gap: Spacing.sm, flex: 1 },
  platformBtn: {
    flex: 1,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
  },
  platformBtnText: { fontSize: 12, fontWeight: '600', color: Colors.textInverse },
  clearSearchBtn: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    backgroundColor: '#fff5f5',
    borderWidth: 1,
    borderColor: '#ffd9d9',
  },
  clearSearchBtnText: { fontSize: 12, color: Colors.error, fontWeight: '600' },

  // 自动抓取栏
  serverBar: {
    backgroundColor: Colors.bgPrimary,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  autoViewTopRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.sm },
  autoViewPlatformBtn: {
    flex: 1,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    backgroundColor: '#4CAF50',
    alignItems: 'center',
  },
  autoViewPlatformBtnText: { fontSize: 12, fontWeight: '600', color: Colors.textInverse },
  autoViewPageScroll: { marginTop: Spacing.xs },
  autoViewPageChip: {
    width: 38,
    height: 38,
    marginRight: 6,
    borderRadius: Radius.md,
    backgroundColor: Colors.bgSecondary,
    borderWidth: 1,
    borderColor: Colors.divider,
    justifyContent: 'center',
    alignItems: 'center',
  },
  autoViewPageChipDone: { backgroundColor: '#d4edda', borderColor: '#a3d9a5' },
  autoViewPageChipPartial: { backgroundColor: '#fff3e0', borderColor: '#ffcc80' },
  autoViewPageChipInner: { alignItems: 'center' },
  autoViewPageChipNum: { fontSize: 13, fontWeight: '600', color: Colors.textPrimary },
  autoViewPageChipNumDone: { color: '#2d6a4f' },
  autoViewDot: { width: 6, height: 6, borderRadius: 3, marginTop: 2 },
  enrichStatusText: {
    ...Typography.label,
    color: Colors.primary,
    marginTop: Spacing.xs,
    textAlign: 'center',
  },

  // 浏览器顶栏
  browserBar: {
    backgroundColor: Colors.bgPrimary,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  backBtn: { paddingRight: Spacing.md },
  backBtnText: { fontSize: 15, color: Colors.primary, fontWeight: '600' },
  browserTitle: { flex: 1, ...Typography.h3, color: Colors.textPrimary, textAlign: 'center' },
  refreshBtn: { paddingLeft: Spacing.md },
  refreshBtnText: { fontSize: 20, color: Colors.primary },

  // 浏览器底部
  browserFooter: {
    backgroundColor: Colors.bgPrimary,
    padding: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.divider,
  },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.lg,
  },
  scanBtnText: { fontSize: 15, fontWeight: '700', color: Colors.textInverse },

  // 加载和错误状态
  loadingState: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.bgPrimary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: { ...Typography.body1, color: Colors.textSecondary, marginTop: Spacing.md },
  errorState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.bgPrimary,
    padding: Spacing.xxxl,
  },
  errorIcon: { fontSize: 48, marginBottom: Spacing.lg },
  errorText: { ...Typography.body1, color: Colors.textSecondary, textAlign: 'center', marginBottom: Spacing.xl },
  retryBtn: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
  },
  retryBtnText: { ...Typography.h4, fontWeight: '600', color: Colors.textInverse },
  
  // 通用禁用状态
  btnDisabled: {
    opacity: 0.5,
  },

  // CAPTCHA Modal - 确保最高层级显示
  captchaModalContainer: {
    flex: 1,
    backgroundColor: Colors.bgPrimary,
    zIndex: 9999,
    elevation: 9999,
  },
  captchaHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
    backgroundColor: Colors.bgPrimary,
    zIndex: 10000,
    elevation: 10000,
  },
  captchaTitle: {
    ...Typography.h2,
    color: Colors.textPrimary,
  },
  captchaCloseBtn: {
    padding: Spacing.xs,
  },
  captchaHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
    zIndex: 10000,
    elevation: 10000,
  },
  captchaHintText: {
    flex: 1,
    ...Typography.body2,
    color: Colors.primary,
  },
  captchaWebView: {
    flex: 1,
    backgroundColor: Colors.bgPrimary,
  },
});
