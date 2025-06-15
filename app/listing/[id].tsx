import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert,
  Clipboard,
  Image,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import {
  deepAnalyzeListing,
  generateBargainScripts, getBargainCategoryLabel,
  isLikelyInvalidBeikePosterUrl,
  summarizeListingImagesForDeepAnalysis,
  type BargainScript,
} from '../lib/api';
import { Colors, Radius, Shadow, Spacing, Typography } from '../lib/design';
import { buildListingDestinationCandidates, calculateCommute, type CommuteResult } from '../lib/geo';
import {
  detailExtractToPatch, needsDetailEnrichment,
  parseDetailExtractMessage,
} from '../lib/listing-enrich';
import { findCrossPlatformMatches, type MatchResult } from '../lib/listing-match';
import {
  buildListingSearchSnippet,
  detectListingSourceFromUrl,
  getListingExternalOpenDisclaimer,
  getListingWechatHintLines,
} from '../lib/listing-share-hints';
import { buildPlatformSearchUrl, WECHAT_UA, type SearchPlatform } from '../lib/platform-search';
import { getDetailExtractScript } from '../lib/scraper';
import {
  addFavorite,
  addToCompare,
  clearDeepAnalysisRecords,
  getCompareList,
  getDeepAnalysisRecordByListingId,
  getFavorites,
  getHistory,
  getPlatformLoginStatus,
  getPrefs,
  patchListingDetail,
  removeFavorite,
  removeFromCompare,
  saveDeepAnalysisRecord,
  type Listing
} from '../lib/storage';
import { useXHSReview, XHSCaptchaModal, XHSReviewModal } from '../lib/xhs-review-ui';

// ── 精筛结果类型 ──────────────────────────────────────────────
type DeepAnalysis = {
  summary: string;
  scoreRationale: string;
  imageAnalysis: string;
  pros: string[];
  cons: string[];
  risks: string[];
  suggestion: string;
  score: number;
};

// ── 精筛状态 ──────────────────────────────────────────────────
type AnalysisState = 'idle' | 'loading' | 'done' | 'error';

type TabKey = 'info' | 'browser' | 'analysis';

/** 详情页正文提取（与 scraper 统一脚本） */
const INJECT_EXTRACT_PAGE_TEXT = getDetailExtractScript();

async function waitForWebPageText(
  getText: () => string,
  options: { minLen: number; timeoutMs: number; intervalMs: number },
): Promise<string> {
  const { minLen, timeoutMs, intervalMs } = options;
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const v = getText();
      if (v && v.trim().length >= minLen) {
        resolve(v);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(typeof v === 'string' ? v : '');
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function parseDeepAnalysis(raw: string, fallbackScore: number): DeepAnalysis {
  const cleaned = raw
    .replace(/```json/gi, '```')
    .replace(/```/g, '')
    .trim();

  // 先尝试 JSON 解析（兼容旧格式）
  const candidates = [cleaned];
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch?.[0]) candidates.push(jsonMatch[0]);

  for (const item of candidates) {
    try {
      const parsed = JSON.parse(item);
      return {
        summary: parsed.summary || '',
        scoreRationale: parsed.scoreRationale || '',
        imageAnalysis: parsed.imageAnalysis || '',
        pros: Array.isArray(parsed.pros) ? parsed.pros : [],
        cons: Array.isArray(parsed.cons) ? parsed.cons : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks : [],
        suggestion: parsed.suggestion || '',
        score: Number(parsed.score) || fallbackScore || 0,
      };
    } catch {
      // continue
    }
  }

  // JSON 解析失败，尝试 Markdown 解析
  console.log('[parseDeepAnalysis] JSON 解析失败，尝试 Markdown 解析');
  
  // 提取评分
  let score = fallbackScore || 0;
  const scoreMatch = cleaned.match(/##\s*综合评分[：:]\s*(\d+(?:\.\d+)?)\s*[/／]\s*10/i);
  if (scoreMatch) {
    score = parseFloat(scoreMatch[1]);
  }

  // 提取评分依据
  let scoreRationale = '';
  const rationaleMatch = cleaned.match(/###\s*评分依据\s*\n([\s\S]*?)(?=\n###|$)/i);
  if (rationaleMatch) {
    scoreRationale = rationaleMatch[1].trim();
  }

  // 提取优点
  const pros: string[] = [];
  const prosMatch = cleaned.match(/###\s*✅?\s*优点\s*\n([\s\S]*?)(?=\n###|$)/i);
  if (prosMatch) {
    const prosText = prosMatch[1].trim();
    const prosLines = prosText.split('\n').filter(line => line.trim().startsWith('-') || line.trim().startsWith('•'));
    prosLines.forEach(line => {
      const cleaned = line.replace(/^[-•]\s*/, '').trim();
      if (cleaned) pros.push(cleaned);
    });
  }

  // 提取缺点与风险
  const cons: string[] = [];
  const risks: string[] = [];
  const consMatch = cleaned.match(/###\s*⚠️?\s*缺点(?:与风险)?\s*\n([\s\S]*?)(?=\n###|$)/i);
  if (consMatch) {
    const consText = consMatch[1].trim();
    const consLines = consText.split('\n').filter(line => line.trim().startsWith('-') || line.trim().startsWith('•'));
    consLines.forEach(line => {
      const cleaned = line.replace(/^[-•]\s*/, '').trim();
      if (cleaned) {
        // 包含"风险"关键词的放到 risks，否则放到 cons
        if (/风险|隐患|注意|警惕/i.test(cleaned)) {
          risks.push(cleaned);
        } else {
          cons.push(cleaned);
        }
      }
    });
  }

  // 提取价格分析（作为 summary 的一部分）
  let priceAnalysis = '';
  const priceMatch = cleaned.match(/###\s*💰?\s*价格分析\s*\n([\s\S]*?)(?=\n###|$)/i);
  if (priceMatch) {
    priceAnalysis = priceMatch[1].trim();
  }

  // 提取居住建议
  let suggestion = '';
  const suggestionMatch = cleaned.match(/###\s*🏠?\s*居住建议\s*\n([\s\S]*?)(?=\n###|$)/i);
  if (suggestionMatch) {
    suggestion = suggestionMatch[1].trim();
  }

  // 提取图片分析（如果有）
  let imageAnalysis = '';
  const imageMatch = cleaned.match(/###\s*(?:图片分析|实拍图分析)\s*\n([\s\S]*?)(?=\n###|$)/i);
  if (imageMatch) {
    imageAnalysis = imageMatch[1].trim();
  }

  // 组合 summary：包含价格分析
  const summary = priceAnalysis || cleaned.slice(0, 500);

  return {
    summary,
    scoreRationale,
    imageAnalysis,
    pros,
    cons,
    risks,
    suggestion,
    score,
  };
}

export default function ListingDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [listing, setListing] = useState<Listing | null>(null);
  const [loadFinished, setLoadFinished] = useState(false);
  const [isFav, setIsFav] = useState(false);
  const [isInCompare, setIsInCompare] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('info');
  const [analysisState, setAnalysisState] = useState<AnalysisState>('idle');
  const [analysis, setAnalysis] = useState<DeepAnalysis | null>(null);
  const [webLoading, setWebLoading] = useState(false);
  const [webPageContent, setWebPageContent] = useState<string>('');
  const webPageContentRef = useRef<string>('');
  const pageExtractExtrasRef = useRef<{ facilities: string[]; imageUrls: string[] }>({
    facilities: [],
    imageUrls: [],
  });
  const [commute, setCommute] = useState<CommuteResult | null>(null);
  const [workAddressConfigured, setWorkAddressConfigured] = useState(false);
  const [commuteLoading, setCommuteLoading] = useState(false);
  const webViewRef = useRef<WebView>(null);
  const enrichWebViewRef = useRef<WebView>(null);
  const enrichResolveRef = useRef<((listing: Listing) => void) | null>(null);
  const [enrichWebViewUrl, setEnrichWebViewUrl] = useState('');

  // ★ 高级功能状态（提升到父组件，供 AnalysisTab 使用）
  const [bargainScripts, setBargainScripts] = useState<BargainScript[]>([]);
  const [crossResults, setCrossResults] = useState<MatchResult[]>([]);
  const [xhsReview, setXhsReview] = useState('');
  
  // 砍价话术状态
  const [bargainLoading, setBargainLoading] = useState(false);
  const [bargainLoadingHint, setBargainLoadingHint] = useState('');
  const [showBargainModal, setShowBargainModal] = useState(false);

  // 跨平台比价状态
  const [crossLoading, setCrossLoading] = useState(false);
  const [crossError, setCrossError] = useState('');
  const [showCrossModal, setShowCrossModal] = useState(false);
  const [crossPlatformStatus, setCrossPlatformStatus] = useState<Record<SearchPlatform, string>>({
    anjuke: '', beike: '', lianjia: '', xiaohongshu: '',
  });
  const [crossLoginHints, setCrossLoginHints] = useState<{ settings: boolean; platforms: SearchPlatform[] }>({
    settings: false,
    platforms: [],
  });
  const [crossWebViewSearch, setCrossWebViewSearch] = useState<null | {
    url: string;
    platform: SearchPlatform;
    query: string;
    cityCode: string;
    queue: SearchPlatform[];
    queueIndex: number;
    collected: Listing[];
    startTime: number; // ★ 添加开始时间用于超时检测
  }>(null);
  const [showCaptchaModal, setShowCaptchaModal] = useState(false);
  const [captchaPlatform, setCaptchaPlatform] = useState<SearchPlatform | null>(null);
  const crossWebViewRef = useRef<WebView>(null);
  const crossTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // ★ 超时定时器

  // 小红书评价状态（始终调用 hook，避免条件调用导致 hook 顺序变化）
  const {
    xhsState,
    setXhsState,
    xhsWebViewRef,
    handleGenerateXHSReview,
    handleStopScraping,
    handleWebViewMessage,
    handleWebViewLoadStart,
    handleWebViewLoadEnd,
    handleWebViewError,
    handleCaptchaContinue,
    handleCaptchaClose,
  } = useXHSReview(listing);

  const loadListing = useCallback(async () => {
    setLoadFinished(false);
    webPageContentRef.current = '';
    pageExtractExtrasRef.current = { facilities: [], imageUrls: [] };
    setWebPageContent('');
    // 先从历史里找，再从收藏里找
    const history = await getHistory();
    const favs = await getFavorites();
    const compares = await getCompareList();
    const found = [...history, ...favs, ...compares].find(l => l.id === id);
    if (found) {
      setListing(found);
      const isFavNow = favs.some(f => f.id === id);
      setIsFav(isFavNow);
      
      // 检查是否在对比列表中
      const compareList = await getCompareList();
      setIsInCompare(compareList.some(c => c.id === id));
      
      // 加载通勤信息
      loadCommute(found);

      // 恢复精筛记录
      const previous = await getDeepAnalysisRecordByListingId(id);
      if (previous) {
        setAnalysis(parseDeepAnalysis(previous.raw, found.aiScore));
        setAnalysisState('done');
      }
    }
    setLoadFinished(true);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      loadListing();
    }, [loadListing])
  );

  async function loadCommute(target: Listing) {
    try {
      const prefs = await getPrefs();
      const workAddress = (prefs.workAddress || '').trim();
      setWorkAddressConfigured(Boolean(workAddress));
      if (!workAddress) {
        setCommute(null);
        return;
      }
      setCommuteLoading(true);

      const cityCode = target.cityCode || prefs.city || 'bj';
      const candidates = buildListingDestinationCandidates(target);
      if (!candidates.length) {
        setCommute({
          distance: '',
          duration: '',
          success: false,
          errorReason: '房源缺少可用于估算的地址信息',
        });
        setCommuteLoading(false);
        return;
      }

      const [primary, ...fallbacks] = candidates;
      const result = await calculateCommute(workAddress, primary, cityCode, fallbacks);
      setCommute(result);
    } catch (error) {
      console.error('通勤计算异常:', error);
      setCommute({ distance: '', duration: '', success: false });
    } finally {
      setCommuteLoading(false);
    }
  }

  async function toggleFav() {
    if (!listing) return;
    if (isFav) {
      await removeFavorite(listing.id);
      setIsFav(false);
    } else {
      await addFavorite(listing);
      setIsFav(true);
    }
  }

  async function toggleCompare() {
    if (!listing) return;
    if (isInCompare) {
      await removeFromCompare(listing.id);
      setIsInCompare(false);
      Alert.alert('提示', '已从对比列表中移除');
    } else {
      const currentList = await getCompareList();
      if (currentList.length >= 5) {
        Alert.alert('提示', '最多只能对比 5 套房源\n请先移除其他房源', [
          { text: '知道了', style: 'cancel' },
          { text: '去对比', onPress: () => router.push('/compare') },
        ]);
        return;
      }
      await addToCompare(listing);
      setIsInCompare(true);
      const newCount = currentList.length + 1;
      Alert.alert('已加入对比', `当前对比 ${newCount}/5 套房源`, [
        { text: '继续查看', style: 'cancel' },
        { text: '去对比', onPress: () => router.push('/compare') },
      ]);
    }
  }

  async function enrichListingIfNeeded(target: Listing): Promise<Listing> {
    if (!needsDetailEnrichment(target) || !target.url) return target;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        enrichResolveRef.current = null;
        setEnrichWebViewUrl('');
        resolve(target);
      }, 25000);
      enrichResolveRef.current = (result: Listing) => {
        clearTimeout(timeout);
        enrichResolveRef.current = null;
        resolve(result);
      };
      setEnrichWebViewUrl(target.url!);
    });
  }

  async function handleDetailEnrichMessage(event: { nativeEvent: { data: string } }) {
    const payload = parseDetailExtractMessage(event.nativeEvent.data);
    const resolve = enrichResolveRef.current;
    const targetId = listing?.id;
    if (!resolve || !targetId) return;
    if (payload) {
      await patchListingDetail(targetId, detailExtractToPatch(payload));
      const history = await getHistory();
      const fresh = history.find(l => l.id === targetId);
      if (fresh) {
        setListing(fresh);
        setEnrichWebViewUrl('');
        resolve(fresh);
        return;
      }
    }
    setEnrichWebViewUrl('');
    resolve(listing!);
  }

  async function runDeepAnalysis(incomingPageContent?: string) {
    if (!listing) return;

    setAnalysisState('loading');
    setActiveTab('analysis');

    try {
      const prefs = await getPrefs();
      let working = listing;
      if (needsDetailEnrichment(listing)) {
        working = await enrichListingIfNeeded(listing);
      }

      // GLM-4V 看图先行（专用于精筛）
      const detailImages = (working.detailImages || []).filter(u => /^https?:\/\//i.test(String(u)));
      const imageAnalysis = detailImages.length > 0
        ? await summarizeListingImagesForDeepAnalysis(working, detailImages)
        : '';

      let content =
        working.detailDescription
        || (typeof incomingPageContent === 'string' ? incomingPageContent : '')
        || webPageContentRef.current
        || webPageContent;
      if (typeof content !== 'string') content = '';

      if ((!content || content.trim().length < 30) && working.url?.trim()) {
        webViewRef.current?.injectJavaScript(INJECT_EXTRACT_PAGE_TEXT);
        content = await waitForWebPageText(() => webPageContentRef.current, {
          minLen: 30,
          timeoutMs: 22000,
          intervalMs: 350,
        });
        if (content.trim().length >= 30) {
          webPageContentRef.current = content;
          setWebPageContent(content);
        }
      }

      const pageExtras = {
        facilities: working.facilities || pageExtractExtrasRef.current.facilities,
        imageUrls: working.detailImages || pageExtractExtrasRef.current.imageUrls,
      };
      const pageForModel = content.trim().length >= 30 ? content : undefined;
      const raw = await deepAnalyzeListing(
        working,
        prefs,
        working.detailImages,
        pageForModel,
        pageExtras,
        imageAnalysis,
      );
      const parsed = parseDeepAnalysis(raw, listing.aiScore);
      // 将 GLM 图分析结果合并进解析
      if (imageAnalysis && !parsed.imageAnalysis) {
        parsed.imageAnalysis = imageAnalysis;
      }
      setAnalysis(parsed);
      await saveDeepAnalysisRecord({
        listingId: listing.id,
        title: listing.title,
        score: parsed.score,
        summary: parsed.summary,
        raw,
        createdAt: new Date().toISOString(),
      });
      setAnalysisState('done');
    } catch (error: any) {
      console.error('[详情页] 精筛失败:', error);
      setAnalysisState('error');
      Alert.alert('精筛失败', error?.message || '请检查 API Key 配置或网络连接');
    }
  }

  // ── 跨平台比价相关函数 ──────────────────────────────────────
  const PLATFORM_LABELS: Record<SearchPlatform, string> = {
    anjuke: '安居客',
    beike: '贝壳',
    lianjia: '链家',
    xiaohongshu: '小红书',
  };

  const PLATFORM_REQUIRES_LOGIN: Record<SearchPlatform, boolean> = {
    anjuke: false,
    beike: true,
    lianjia: true,
    xiaohongshu: true,
  };

  function scraperResultToListings(items: any[], cityCode: string): Listing[] {
    return (items || []).map((l: any, i: number) => ({
      id: `cross-tmp-${i}`,
      title: l.title || '',
      community: l.community || '',
      district: l.district || '',
      roomType: l.roomType || '',
      area: l.area || '',
      floor: l.floor || '',
      price: l.price || 0,
      tags: l.tags || [],
      hasSubway: false,
      hasPets: false,
      isWhole: true,
      aiScore: 0,
      aiComment: '',
      url: l.url,
      platform: l.platform,
      scrapedAt: new Date().toISOString(),
      cityCode,
    }));
  }

  function finishCrossSearch(collected: Listing[], status: Record<SearchPlatform, string>) {
    if (!listing) return;
    
    // ★ 清除超时定时器
    if (crossTimeoutRef.current) {
      clearTimeout(crossTimeoutRef.current);
      crossTimeoutRef.current = null;
    }
    
    setCrossWebViewSearch(null);
    setCrossLoading(false);
    setCrossPlatformStatus(status);
    const matches = findCrossPlatformMatches(listing, collected);
    setCrossResults(matches);
    if (matches.length === 0) {
      const total = collected.length;
      if (total > 0) {
        setCrossError(`各平台共搜到 ${total} 套，但无高度匹配`);
      } else {
        setCrossError('');
      }
    } else {
      setCrossError('');
    }
    setShowCrossModal(true);
  }

  function startCrossWebViewSearch(
    platform: SearchPlatform,
    query: string,
    cityCode: string,
    queue: SearchPlatform[],
    queueIndex: number,
    collected: Listing[],
    status: Record<SearchPlatform, string>,
  ) {
    const url = buildPlatformSearchUrl(platform, cityCode, query);
    console.log('[CrossPlatform] 启动WebView:', platform, url);
    status[platform] = '搜索中…';
    setCrossPlatformStatus({ ...status });
    
    // ★ 清除之前的超时定时器
    if (crossTimeoutRef.current) {
      clearTimeout(crossTimeoutRef.current);
    }
    
    // ★ 设置30秒超时
    crossTimeoutRef.current = setTimeout(() => {
      console.log('[CrossPlatform] Timeout for platform:', platform);
      setCrossWebViewSearch(null);
      setCrossLoading(false);
      const newStatus = { ...status };
      newStatus[platform] = '搜索超时';
      setCrossPlatformStatus(newStatus);
      setCrossError(`${PLATFORM_LABELS[platform]}搜索超时，请重试`);
      setShowCrossModal(true);
    }, 30000);
    
    setCrossWebViewSearch({
      url,
      platform,
      query,
      cityCode,
      queue,
      queueIndex,
      collected,
      startTime: Date.now(), // ★ 添加开始时间
    });
    console.log('[CrossPlatform] WebView状态已设置:', platform);
  }

  async function handleCrossPlatformCheck() {
    console.log('[CrossPlatform] ========== 函数被调用 ==========');
    console.log('[CrossPlatform] listing:', listing ? `存在 (${listing.title})` : '不存在');
    console.log('[CrossPlatform] crossLoading:', crossLoading);
    
    if (!listing || crossLoading) {
      console.log('[CrossPlatform] 提前返回: listing不存在或正在加载中');
      return;
    }
    
    console.log('[CrossPlatform] 开始执行多平台比价...');
    setCrossLoading(true);
    setCrossError('');
    setCrossResults([]);
    setCrossLoginHints({ settings: false, platforms: [] });

    const status: Record<SearchPlatform, string> = {
      anjuke: listing.platform === 'anjuke' ? '当前房源来源' : '',
      beike: listing.platform === 'beike' ? '当前房源来源' : '',
      lianjia: listing.platform === 'lianjia' ? '当前房源来源' : '',
      xiaohongshu: listing.platform === 'xiaohongshu' ? '当前房源来源' : '',
    };

    try {
      console.log('[CrossPlatform] 开始检查本地历史记录...');
      const history = await getHistory();
      console.log('[CrossPlatform] 历史记录数量:', history.length);
      const localMatches = findCrossPlatformMatches(listing, history);
      console.log('[CrossPlatform] 本地匹配数量:', localMatches.length);
      
      if (localMatches.length > 0) {
        console.log('[CrossPlatform] 找到本地匹配，直接显示结果');
        setCrossPlatformStatus(status);
        setCrossResults(localMatches);
        setShowCrossModal(true);
        setCrossLoading(false);
        return;
      }

      const cityCode = listing.cityCode || '';
      console.log('[CrossPlatform] cityCode:', cityCode);
      
      if (!cityCode) {
        console.log('[CrossPlatform] 缺少城市代码，终止');
        setCrossError('无法确定城市，请在找房页选择城市后重试');
        setCrossPlatformStatus(status);
        setShowCrossModal(true);
        setCrossLoading(false);
        return;
      }

      // ★ 优化：提取多个候选搜索关键词
      const originalCommunity = listing.community.trim();
      const candidates: string[] = [];
      
      // 策略1：提取小区名（带常见后缀）
      const communityMatch = originalCommunity.match(/(?:近|靠近)?([^\s]{2,15}(?:小区|公寓|花园|苑|园|广场|大厦|中心|城|府|居|庭|墅|里|坊|轩|阁|台|村|庄|邸|湾))/);
      if (communityMatch) {
        candidates.push(communityMatch[1]);
      }
      
      // 策略2：提取地铁站附近的地标
      const landmarkMatch = originalCommunity.match(/(?:近|靠近)([^\s]{2,10}(?:商场|商业|广场|中心|大厦|公园|医院|学校))/);
      if (landmarkMatch && landmarkMatch[1] !== communityMatch?.[1]) {
        candidates.push(landmarkMatch[1]);
      }
      
      // 策略3：提取地铁站名
      const subwayMatch = originalCommunity.match(/(\d+号线)?([^\s]{2,8}站)/);
      if (subwayMatch && subwayMatch[2]) {
        const stationName = subwayMatch[2].replace(/站$/, '');
        if (stationName.length >= 2) {
          candidates.push(stationName);
        }
      }
      
      // 策略4：如果以上都没有，尝试分词提取
      if (candidates.length === 0) {
        const parts = originalCommunity.split(/\s+|[·｜\-]/);
        for (const part of parts) {
          const cleaned = part.replace(/^\d+号线|独立|朝南|朝北|电梯|厨卫|有|无/g, '').trim();
          if (cleaned.length >= 2 && cleaned.length <= 10) {
            candidates.push(cleaned);
          }
        }
      }
      
      // 策略5：使用区域名作为最后的备选
      if (listing.district && listing.district !== '未知区域' && listing.district !== '未知') {
        candidates.push(listing.district);
      }
      
      // 去重并限制数量
      const uniqueCandidates = [...new Set(candidates)].slice(0, 3);
      const query = uniqueCandidates[0] || originalCommunity.split(/\s+/)[0] || originalCommunity;
      
      console.log('[CrossPlatform] 原始community:', originalCommunity);
      console.log('[CrossPlatform] 候选关键词:', uniqueCandidates);
      console.log('[CrossPlatform] 使用关键词:', query);
      
      const loginStatus = await getPlatformLoginStatus();
      console.log('[CrossPlatform] 登录状态:', loginStatus);

      const queue: SearchPlatform[] = [];
      const allPlatforms: SearchPlatform[] = ['anjuke', 'beike', 'lianjia'];
      let hasAnyLogin = false;
      const lockedPlatforms: SearchPlatform[] = [];

      for (const plat of allPlatforms) {
        if (plat === listing.platform) continue;
        const loggedIn = loginStatus[plat] === true;
        if (loggedIn) hasAnyLogin = true;
        if (loggedIn || !PLATFORM_REQUIRES_LOGIN[plat]) {
          queue.push(plat);
        } else {
          status[plat] = '未登录，无法搜索';
          lockedPlatforms.push(plat);
        }
      }
      
      console.log('[CrossPlatform] 搜索队列:', queue);
      console.log('[CrossPlatform] 锁定平台:', lockedPlatforms);

      if (!hasAnyLogin) {
        setCrossLoginHints(prev => ({ ...prev, settings: true }));
      }
      if (lockedPlatforms.length > 0) {
        setCrossLoginHints(prev => ({ ...prev, platforms: lockedPlatforms }));
      }

      setCrossPlatformStatus({ ...status });
      setShowCrossModal(true);

      if (queue.length === 0) {
        console.log('[CrossPlatform] 搜索队列为空，终止');
        setCrossLoading(false);
        return;
      }

      console.log('[CrossPlatform] 开始WebView搜索，平台:', queue[0]);
      startCrossWebViewSearch(queue[0], query, cityCode, queue, 0, [], status);
    } catch (e: unknown) {
      console.error('[CrossPlatform] 发生错误:', e);
      setCrossError(e instanceof Error ? e.message : '比价失败，请稍后重试');
      setCrossPlatformStatus(status);
      setShowCrossModal(true);
      setCrossLoading(false);
    }
  }

  function handleCrossWebViewMessage(event: { nativeEvent: { data: string } }) {
    const search = crossWebViewSearch;
    if (!search) return;

    try {
      const data = JSON.parse(event.nativeEvent.data);
      
      // ★ 处理脚本启动确认
      if (data.type === 'script_started') {
        console.log('[CrossPlatform WebView] 脚本已启动:', data.platform, '时间戳:', data.timestamp);
        return;
      }
      
      // ★ 处理脚本完成信号
      if (data.type === 'script_completed') {
        console.log('[CrossPlatform WebView] 脚本已完成:', data.platform, '时间戳:', data.timestamp);
        return;
      }
      
      if (data.type !== 'scrape_result') return;

      // ★ 检测到 CAPTCHA - 弹出 Modal 让用户完成验证
      if (!data.success && data.needLogin && data.debug?.isCaptcha) {
        console.log('[CrossPlatform] CAPTCHA detected for platform:', search.platform);
        setCaptchaPlatform(search.platform);
        setShowCaptchaModal(true);
        // 不关闭 WebView，等待用户完成验证后继续
        return;
      }

      // ★ 移除自动验证完成处理 - 改为由用户点击"继续"按钮触发

      // ★ 清除超时定时器
      if (crossTimeoutRef.current) {
        clearTimeout(crossTimeoutRef.current);
        crossTimeoutRef.current = null;
      }
      
      const platform = search.platform;
      const status = { ...crossPlatformStatus };

      let collected = [...search.collected];
      if (data.success && data.listings?.length) {
        const items = scraperResultToListings(data.listings, search.cityCode);
        collected = collected.concat(items);
        status[platform] = `已搜到 ${data.count || items.length} 套`;
        console.log('[CrossPlatform] 成功收集房源:', platform, items.length);
      } else {
        const reason = data.reason || '搜索失败';
        status[platform] = data.success ? '暂无数据' : reason;
        console.log('[CrossPlatform] 搜索失败或无数据:', platform, reason);
      }
      setCrossPlatformStatus(status);

      const nextIndex = search.queueIndex + 1;
      if (nextIndex < search.queue.length) {
        console.log('[CrossPlatform] 继续下一个平台:', search.queue[nextIndex]);
        startCrossWebViewSearch(
          search.queue[nextIndex],
          search.query,
          search.cityCode,
          search.queue,
          nextIndex,
          collected,
          status,
        );
        return;
      }

      console.log('[CrossPlatform] 所有平台搜索完成，总收集:', collected.length);
      finishCrossSearch(collected, status);
    } catch {
      setCrossWebViewSearch(null);
      setCrossLoading(false);
      setCrossError('解析搜索结果失败');
      setShowCrossModal(true);
    }
  }

  if (!listing && !loadFinished) {
    return (
      <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
        <View style={s.loadingWrap}>
          <ActivityIndicator size="large" color="#00ae66" />
          <Text style={s.loadingText}>加载中...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!listing && loadFinished) {
    return (
      <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
        <View style={s.emptyState}>
          <Ionicons name="file-tray-outline" size={52} color={Colors.textTertiary} style={{ marginBottom: Spacing.lg }} />
          <Text style={s.emptyTitle}>未找到该房源</Text>
          <Text style={s.emptyDesc}>该房源可能已被清理，请返回列表重新选择</Text>
          <TouchableOpacity style={s.deepBtn} onPress={() => router.replace('/search')}>
            <Text style={s.deepBtnText}>返回找房</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (!listing) {
    return null;
  }

  return (
    <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
      {/* 顶部导航栏 */}
      <View style={s.navbar}>
        <TouchableOpacity style={s.navBack} onPress={() => router.back()}>
          <Text style={s.navBackText}>←</Text>
        </TouchableOpacity>
        <Text style={s.navTitle} numberOfLines={1}>{listing.community || '房源详情'}</Text>
        <View style={s.navActions}>
          <TouchableOpacity style={s.navCompare} onPress={toggleCompare}>
            <Ionicons
              name={isInCompare ? 'bar-chart' : 'bar-chart-outline'}
              size={22}
              color={isInCompare ? Colors.primary : Colors.textSecondary}
            />
          </TouchableOpacity>
          <TouchableOpacity style={s.navFav} onPress={toggleFav}>
            <Ionicons
              name={isFav ? 'heart' : 'heart-outline'}
              size={22}
              color={isFav ? '#e74c3c' : Colors.textSecondary}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Tab 切换 */}
      <View style={s.tabBar}>
        {([
          { key: 'info', label: '基本信息', icon: 'document-text-outline' },
          { key: 'browser', label: '原始页面', icon: 'globe-outline' },
          { key: 'analysis', label: '精筛报告', icon: 'search-outline' },
        ] as { key: TabKey; label: string; icon: string }[]).map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[s.tabItem, activeTab === tab.key && s.tabItemActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Ionicons
              name={tab.icon as any}
              size={14}
              color={activeTab === tab.key ? Colors.primary : Colors.textSecondary}
              style={{ marginBottom: 2 }}
            />
            <Text style={[s.tabLabel, activeTab === tab.key && s.tabLabelActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* 内容区域：原始页 WebView 有链接时始终在后台挂载，便于未切 Tab 也能抓取正文做精筛 */}
      <View style={{ flex: 1, position: 'relative' }}>
        {activeTab === 'info' && (
          <View style={{ flex: 1, zIndex: 1, backgroundColor: Colors.bgSecondary }}>
            <InfoTab
              listing={listing}
              commute={commute}
              workAddressConfigured={workAddressConfigured}
              commuteLoading={commuteLoading}
              onStartAnalysis={runDeepAnalysis}
              onRequestEnrich={enrichListingIfNeeded}
            />
          </View>
        )}
        {activeTab === 'analysis' && (
          <View style={{ flex: 1, zIndex: 1, backgroundColor: Colors.bgSecondary }}>
            <AnalysisTab
              state={analysisState}
              analysis={analysis}
              listing={listing}
              onRetry={runDeepAnalysis}
              onClearDeepRecords={async () => {
                await clearDeepAnalysisRecords();
                Alert.alert('完成', '已精筛记录缓存已清空');
              }}
              onSwitchToBrowser={() => setActiveTab('browser')}
              bargainScripts={bargainScripts}
              crossResults={crossResults}
              xhsReview={typeof xhsState.review === 'string' ? xhsState.review : ''}
              onGenerateBargain={async () => {
                if (bargainLoading) return;
                setBargainLoading(true);
                try {
                  setBargainLoadingHint('正在读取详情…');
                  let working = listing;
                  if (needsDetailEnrichment(listing)) {
                    working = await enrichListingIfNeeded(listing);
                  }
                  const prefs = await getPrefs();
                  setBargainLoadingHint('正在生成话术…');
                  const scripts = await generateBargainScripts(working, prefs, (hint) => {
                    setBargainLoadingHint(hint);
                  });
                  setBargainScripts(scripts);
                  setShowBargainModal(true);
                } catch (e: unknown) {
                  Alert.alert('生成失败', e instanceof Error ? e.message : '请检查 API Key 配置');
                } finally {
                  setBargainLoading(false);
                  setBargainLoadingHint('');
                }
              }}
              onCrossPlatformCheck={handleCrossPlatformCheck}
              onGenerateXHSReview={handleGenerateXHSReview}
              bargainLoading={bargainLoading}
              crossLoading={crossLoading}
              xhsLoading={xhsState.loading}
            />
          </View>
        )}
        {activeTab === 'browser' && (
          <View style={{ flex: 1, zIndex: 1, backgroundColor: Colors.bgSecondary }}>
            <BrowserTab
              url={listing.url}
              webViewRef={webViewRef}
              loading={webLoading}
              setLoading={setWebLoading}
              onStartAnalysis={runDeepAnalysis}
              onPageExtract={(payload) => {
                webPageContentRef.current = payload.text;
                pageExtractExtrasRef.current = {
                  facilities: payload.facilities,
                  imageUrls: payload.imageUrls,
                };
                setWebPageContent(payload.text);
                if (listing && (payload.text.length > 30 || payload.facilities.length > 0 || payload.imageUrls.length > 0)) {
                  patchListingDetail(listing.id, {
                    detailDescription: payload.text.slice(0, 2000),
                    detailImages: payload.imageUrls.slice(0, 8),
                    facilities: payload.facilities,
                    detailFetchedAt: new Date().toISOString(),
                  }).catch(() => {});
                }
              }}
            />
          </View>
        )}
      </View>
      {enrichWebViewUrl ? (
        <View style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }} pointerEvents="none">
          <WebView
            ref={enrichWebViewRef}
            source={{ uri: enrichWebViewUrl }}
        userAgent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            javaScriptEnabled
            onLoadEnd={() => {
              setTimeout(() => {
                enrichWebViewRef.current?.injectJavaScript(getDetailExtractScript());
              }, 800);
            }}
            onMessage={handleDetailEnrichMessage}
          />
        </View>
      ) : null}
      
      {/* 跨平台比价搜索 WebView */}
      {crossWebViewSearch && (() => {
        // ★ 捕获当前状态，避免闭包陷阱
        const currentSearch = crossWebViewSearch;
        return (
          <View style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }} pointerEvents="none">
            <WebView
              ref={crossWebViewRef}
              source={{ uri: currentSearch.url }}
              userAgent={WECHAT_UA}
              sharedCookiesEnabled
              thirdPartyCookiesEnabled
              javaScriptEnabled
              onLoadStart={() => {
                console.log('[CrossPlatform WebView] 开始加载:', currentSearch.platform, currentSearch.url.substring(0, 100));
              }}
              onLoadEnd={() => {
                console.log('[CrossPlatform WebView] 加载完成:', currentSearch.platform);
                setTimeout(() => {
                  console.log('[CrossPlatform WebView] 准备注入脚本...');
                  try {
                    // 动态导入 getScraperScript
                    const { getScraperScript } = require('../lib/scraper');
                    const script = getScraperScript(currentSearch.platform);
                    console.log('[CrossPlatform WebView] 脚本长度:', script.length, '字符');
                    crossWebViewRef.current?.injectJavaScript(script);
                    console.log('[CrossPlatform WebView] 脚本已注入');
                  } catch (error) {
                    console.error('[CrossPlatform WebView] 脚本注入失败:', error);
                  }
                }, 1500);
              }}
              onError={(e) => {
                console.error('[CrossPlatform WebView] 加载错误:', e.nativeEvent);
                const newStatus = { ...crossPlatformStatus };
                newStatus[currentSearch.platform] = '页面加载失败';
                setCrossPlatformStatus(newStatus);
              }}
              onHttpError={(e) => {
                console.error('[CrossPlatform WebView] HTTP错误:', e.nativeEvent.statusCode);
                const search = currentSearch;
                
                // ★ 清除超时定时器
                if (crossTimeoutRef.current) {
                  clearTimeout(crossTimeoutRef.current);
                  crossTimeoutRef.current = null;
                }
                
                const status = { ...crossPlatformStatus };
                const statusCode = e.nativeEvent.statusCode;
                
                if (statusCode === 404) {
                  status[search.platform] = '未找到匹配房源';
                } else if (statusCode === 403) {
                  status[search.platform] = '访问被拒绝，可能需要登录';
                } else {
                  status[search.platform] = `HTTP ${statusCode} 错误`;
                }
                
                setCrossPlatformStatus(status);
                
                // 立即继续下一个平台
                const nextIndex = search.queueIndex + 1;
                if (nextIndex < search.queue.length) {
                  startCrossWebViewSearch(
                    search.queue[nextIndex],
                    search.query,
                    search.cityCode,
                    search.queue,
                    nextIndex,
                    search.collected,
                    status,
                  );
                } else {
                  finishCrossSearch(search.collected, status);
                }
              }}
              onMessage={handleCrossWebViewMessage}
            />
          </View>
        );
      })()}

      {/* 小红书验证码 Modal（统一显示 WebView，无论是否有验证码） */}
      <XHSCaptchaModal
        visible={xhsState.showCaptchaModal || (xhsState.loading && !!xhsState.webViewUrl)}
        webViewUrl={xhsState.webViewUrl}
        webViewRef={xhsWebViewRef}
        onMessage={handleWebViewMessage}
        onLoadEnd={handleWebViewLoadEnd}
        onLoadStart={handleWebViewLoadStart}
        onError={handleWebViewError}
        onContinue={handleCaptchaContinue}
        onClose={() => {
          if (xhsState.showCaptchaModal) {
            handleCaptchaClose();
          } else {
            // 如果是正常爬取状态，关闭等同于停止
            handleStopScraping();
          }
        }}
      />

      {/* 小红书评价结果 Modal */}
      <XHSReviewModal 
        visible={xhsState.showModal}
        loading={xhsState.loading}
        review={xhsState.review}
        reviewState={xhsState.reviewState}
        error={xhsState.error}
        onClose={() => setXhsState(prev => ({ ...prev, showModal: false }))}
        onStop={handleStopScraping}
      />

      {/* 跨平台比价验证码 Modal */}
      <Modal
        visible={showCaptchaModal}
        animationType="slide"
        transparent={false}
        onRequestClose={() => {
          setShowCaptchaModal(false);
          setCaptchaPlatform(null);
        }}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bgPrimary }}>
          <View style={s.captchaHeader}>
            <Text style={s.captchaTitle}>
              {captchaPlatform ? `${PLATFORM_LABELS[captchaPlatform]}需要验证` : '需要验证'}
            </Text>
            <Text style={s.captchaSubtitle}>请完成验证后点击"继续"</Text>
            <View style={s.captchaActions}>
              <TouchableOpacity
                style={[s.captchaBtn, s.captchaBtnSecondary]}
                onPress={() => {
                  setShowCaptchaModal(false);
                  setCaptchaPlatform(null);
                  setCrossWebViewSearch(null);
                  setCrossLoading(false);
                }}
              >
                <Text style={s.captchaBtnTextSecondary}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.captchaBtn, s.captchaBtnPrimary]}
                onPress={() => {
                  console.log('[CrossPlatform] User clicked continue after CAPTCHA');
                  setShowCaptchaModal(false);
                  setCaptchaPlatform(null);
                  
                  // ★ 清除超时定时器
                  if (crossTimeoutRef.current) {
                    clearTimeout(crossTimeoutRef.current);
                    crossTimeoutRef.current = null;
                  }
                  
                  // ★ 重新开始抓取流程
                  if (crossWebViewSearch) {
                    const newStatus = { ...crossPlatformStatus };
                    newStatus[crossWebViewSearch.platform] = '验证完成，重新搜索...';
                    setCrossPlatformStatus(newStatus);
                    
                    // 重置 WebView 状态
                    setCrossWebViewSearch({
                      ...crossWebViewSearch,
                      startTime: Date.now(),
                    });
                    
                    // 延迟重新注入脚本
                    setTimeout(() => {
                      const { getScraperScript } = require('../lib/scraper');
                      const script = getScraperScript(crossWebViewSearch.platform);
                      crossWebViewRef.current?.injectJavaScript(script);
                    }, 2000);
                  }
                }}
              >
                <Text style={s.captchaBtnTextPrimary}>继续</Text>
              </TouchableOpacity>
            </View>
          </View>
          {crossWebViewSearch && (
            <WebView
              ref={crossWebViewRef}
              source={{ uri: crossWebViewSearch.url }}
              userAgent={WECHAT_UA}
              sharedCookiesEnabled
              thirdPartyCookiesEnabled
              javaScriptEnabled
              onMessage={handleCrossWebViewMessage}
              onLoadEnd={() => {
                console.log('[CrossPlatform CAPTCHA] WebView loaded in modal');
                // ★ 页面加载完成后，如果不是验证页面，自动注入脚本
                setTimeout(() => {
                  if (crossWebViewSearch) {
                    const { getScraperScript } = require('../lib/scraper');
                    const script = getScraperScript(crossWebViewSearch.platform);
                    crossWebViewRef.current?.injectJavaScript(script);
                  }
                }, 1500);
              }}
            />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

// ── 基本信息 Tab ──────────────────────────────────────────────
function InfoTab({
  listing,
  commute,
  workAddressConfigured,
  commuteLoading,
  onStartAnalysis,
  onRequestEnrich,
}: {
  listing: Listing;
  commute: CommuteResult | null;
  workAddressConfigured: boolean;
  commuteLoading: boolean;
  onStartAnalysis: () => void;
  onRequestEnrich: (listing: Listing) => Promise<Listing>;
}) {
  const router = useRouter();

  // 砍价话术状态
  const [bargainLoading, setBargainLoading] = useState(false);
  const [bargainLoadingHint, setBargainLoadingHint] = useState('');
  const [bargainScripts, setBargainScripts] = useState<BargainScript[]>([]);
  const [showBargainModal, setShowBargainModal] = useState(false);

  const urlStr = String(listing.url || '').trim();
  const hasHttpUrl = urlStr.startsWith('http');
  const searchSnippet = buildListingSearchSnippet({
    title: listing.title,
    community: listing.community,
    district: listing.district,
    roomType: listing.roomType,
    price: listing.price,
  });
  const hintSource = hasHttpUrl
    ? detectListingSourceFromUrl(urlStr)
    : listing.platform === 'beike'
      ? 'beike'
      : listing.platform === 'anjuke'
        ? 'anjuke'
        : 'generic';
  const hintLine = getListingWechatHintLines(hintSource);

  async function handleGenerateBargain() {
    if (bargainLoading) return;
    setBargainLoading(true);
    try {
      setBargainLoadingHint('正在读取详情…');
      let working = listing;
      if (needsDetailEnrichment(listing)) {
        working = await onRequestEnrich(listing);
      }
      const prefs = await getPrefs();
      setBargainLoadingHint('正在生成话术…');
      const scripts = await generateBargainScripts(working, prefs, (hint) => {
        setBargainLoadingHint(hint);
      });
      setBargainScripts(scripts);
      setShowBargainModal(true);
    } catch (e: unknown) {
      Alert.alert('生成失败', e instanceof Error ? e.message : '请检查 API Key 配置');
    } finally {
      setBargainLoading(false);
      setBargainLoadingHint('');
    }
  }

  return (
    <ScrollView style={s.content} showsVerticalScrollIndicator={false}>
      {/* 价格 + 评分 */}
      <View style={s.priceRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.price}>
            {listing.price}
            <Text style={s.priceUnit}> 元/月</Text>
          </Text>
          {listing.scrapedAt && (
            <View style={s.scrapedAtRow}>
              <Ionicons name="radio-outline" size={11} color={Colors.textTertiary} style={{ marginRight: 3 }} />
              <Text style={s.scrapedAt}>
                {listing.platform === 'anjuke' ? '安居客' : listing.platform === 'beike' ? '贝壳' : '未知来源'}
                · {new Date(listing.scrapedAt).toLocaleDateString()}
              </Text>
            </View>
          )}
          {commuteLoading && (
            <Text style={s.commuteText}>计算通勤中...</Text>
          )}
          {!commuteLoading && workAddressConfigured && commute?.success && (
            <View style={s.commuteRow}>
              <Ionicons name="navigate-outline" size={12} color={Colors.textSecondary} style={{ marginRight: 3 }} />
              <Text style={s.commuteText}>
                通勤：{commute.distance}｜预计 {commute.duration.replace('分钟', ' 分钟')}
                {commute.routeModeLabel ? `（${commute.routeModeLabel}）` : '（公共交通）'}
              </Text>
            </View>
          )}
          {!commuteLoading && !workAddressConfigured && (
            <Text style={s.commuteError}>通勤时间：未设置常去地址，前往设置页配置</Text>
          )}
          {!commuteLoading && workAddressConfigured && commute && !commute.success && (
            <View style={s.commuteFailWrap}>
              <Text style={s.commuteMuted}>
                通勤：暂无法估算出行时间（地图对部分小区名称无法精确匹配，属正常情况）。
              </Text>
              {commute.errorReason ? (
                <Text style={s.commuteFailDetail} numberOfLines={2}>
                  {commute.errorReason}
                </Text>
              ) : null}
            </View>
          )}
        </View>
        {listing.aiScore > 0 && (
          <View style={{ flexShrink: 0 }}>
            <View style={[s.scoreBadge, listing.aiScore >= 8 ? s.scoreHigh : listing.aiScore >= 6 ? s.scoreMid : s.scoreLow]}>
              <Text style={s.scoreVal}>AI {listing.aiScore.toFixed(1)}</Text>
            </View>
          </View>
        )}
      </View>

      {/* 标题 */}
      <View style={s.card}>
        <Text style={s.sectionTitle}>房源信息</Text>
        <Text style={s.infoTitle}>{listing.title}</Text>

        <View style={s.infoGrid}>
          <InfoItem iconName="bed-outline" label="户型" value={listing.roomType} />
          <InfoItem iconName="resize-outline" label="面积" value={listing.area} />
          <InfoItem iconName="layers-outline" label="楼层" value={listing.floor} />
          <InfoItem iconName="home-outline" label="小区" value={listing.community} />
          <InfoItem iconName="map-outline" label="区域" value={listing.district} />
          <InfoItem iconName="cash-outline" label="价格" value={`${listing.price} 元/月`} />
        </View>
      </View>

      {/* 标签 */}
      {listing.tags.length > 0 && (
        <View style={s.card}>
          <Text style={s.sectionTitle}>房源标签</Text>
          <View style={s.tagWrap}>
            {listing.tags.map((tag, index) => (
              <View key={`${listing.id}-tag-${index}-${tag}`} style={s.tag}>
                <Text style={s.tagText}>{tag}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* AI 初筛点评 */}
      {listing.aiComment && listing.aiComment !== '待分析' && (
        <View style={s.card}>
          <View style={s.aiCommentHeader}>
            <Ionicons name="sparkles-outline" size={14} color={Colors.primary} style={{ marginRight: 4 }} />
            <Text style={[s.sectionTitle, { marginBottom: 0 }]}>AI 初筛点评</Text>
          </View>
          <View style={s.aiComment}>
            <Text style={s.aiCommentText}>{listing.aiComment}</Text>
          </View>
        </View>
      )}

      {/* 操作按钮 */}
      <View style={s.actionArea}>
        {/* 主 CTA：精筛分析 */}
        <TouchableOpacity style={s.deepBtn} onPress={onStartAnalysis}>
          <Text style={s.deepBtnText}>开始精筛分析</Text>
        </TouchableOpacity>

        {listing.url ? (
          <>
            {isLikelyInvalidBeikePosterUrl(listing.url) ? (
              <Text style={s.linkStubHint}>
                链接可能不完整。建议在贝壳 App 内重新复制分享链接。
              </Text>
            ) : null}
            <Text style={s.externalDisclaimerText}>{getListingExternalOpenDisclaimer()}</Text>
            <View style={s.externalLinkRow}>
              <TouchableOpacity
                style={[s.copyLinkBtn, s.externalLinkHalf]}
                onPress={() => {
                  Clipboard.setString(listing.url!);
                  Alert.alert('已复制', '链接已复制，请在微信中粘贴打开查看真实房源详情');
                }}
              >
                <Text style={s.copyLinkBtnText} numberOfLines={2}>复制链接 · 微信</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.srcBtn, s.externalLinkHalf]}
                onPress={() => Linking.openURL(listing.url!)}
              >
                <Text style={s.srcBtnText} numberOfLines={2}>系统浏览器打开</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.listingLinkHint}>{hintLine}</Text>
            {searchSnippet ? (
              <TouchableOpacity
                style={s.copySnippetBtn}
                onPress={() => {
                  Clipboard.setString(searchSnippet);
                  Alert.alert('已复制', '房源标题已复制，请在官方 App 搜索栏长按粘贴');
                }}
              >
                <Text style={s.copySnippetBtnText}>复制标题 · App 搜索</Text>
              </TouchableOpacity>
            ) : null}
          </>
        ) : null}
        {!listing.url && searchSnippet ? (
          <>
            <Text style={s.listingLinkHint}>{hintLine}</Text>
            <TouchableOpacity
              style={s.copySnippetBtn}
              onPress={() => {
                Clipboard.setString(searchSnippet);
                Alert.alert('已复制', '房源标题已复制，请在官方 App 搜索栏长按粘贴');
              }}
            >
              <Text style={s.copySnippetBtnText}>复制标题 · App 搜索</Text>
            </TouchableOpacity>
          </>
        ) : null}
      </View>

      <View style={{ height: 12 }} />

      {/* 砍价话术 Modal */}
      <Modal
        visible={showBargainModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowBargainModal(false)}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>砍价话术</Text>
              <TouchableOpacity onPress={() => setShowBargainModal(false)}>
                <Ionicons name="close" size={22} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <Text style={s.modalSubtitle}>
              {listing.community} · {listing.price} 元/月 · 仅供参考，请结合实际情况使用
            </Text>
            <ScrollView style={s.modalScroll} showsVerticalScrollIndicator={false}>
              {bargainScripts.map((script, i) => (
                <View key={i} style={s.bargainItem}>
                  <View style={s.bargainItemHeader}>
                    <Text style={s.bargainCategory}>{getBargainCategoryLabel(script.category)}</Text>
                    <TouchableOpacity
                      onPress={() => {
                        Clipboard.setString(script.script);
                        Alert.alert('已复制', '话术已复制到剪贴板');
                      }}
                    >
                      <Ionicons name="copy-outline" size={16} color={Colors.primary} />
                    </TouchableOpacity>
                  </View>
                  <Text style={s.bargainScript}>{script.script}</Text>
                  {script.tip ? <Text style={s.bargainTip}>{script.tip}</Text> : null}
                </View>
              ))}
              <TouchableOpacity
                style={[s.copySnippetBtn, { marginBottom: Spacing.xl }]}
                onPress={() => {
                  const text = bargainScripts.map(s => `【${getBargainCategoryLabel(s.category)}】${s.script}`).join('\n\n');
                  Clipboard.setString(text);
                  Alert.alert('已复制', '全部话术已复制到剪贴板');
                }}
              >
                <Text style={s.copySnippetBtnText}>复制全部话术</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.copySnippetBtn, { marginBottom: Spacing.xl }]}
                onPress={() => {
                  setShowBargainModal(false);
                  const text = `帮我润色这套房源的砍价话术：${listing.community}，${listing.roomType}，${listing.price}元/月，房源ID：${listing.id}`;
                  router.push(`/chat?autoMessage=${encodeURIComponent(text)}`);
                }}
              >
                <Text style={s.copySnippetBtnText}>发给助手继续润色</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

    </ScrollView>
  );
}

function InfoItem({ iconName, label, value }: { iconName: string; label: string; value: string }) {
  return (
    <View style={s.infoItem}>
      <Ionicons name={iconName as any} size={16} color={Colors.textTertiary} style={s.infoIcon} />
      <View>
        <Text style={s.infoLabel}>{label}</Text>
        <Text style={s.infoValue}>{value || '未知'}</Text>
      </View>
    </View>
  );
}

// ── 原始页面 Tab ──────────────────────────────────────────────
function BrowserTab({
  url,
  webViewRef,
  loading,
  setLoading,
  onStartAnalysis,
  onPageExtract,
}: {
  url?: string;
  webViewRef: React.RefObject<WebView | null>;
  loading: boolean;
  setLoading: (v: boolean) => void;
  onStartAnalysis: (pageContent?: string) => void;
  onPageExtract: (payload: { text: string; facilities: string[]; imageUrls: string[] }) => void;
}) {
  // Hooks 必须在组件顶部调用，不能在条件分支后
  const [extractBundle, setExtractBundle] = useState<{
    text: string;
    facilities: string[];
    imageUrls: string[];
  } | null>(null);
  const [pageLoaded, setPageLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!url || !url.trim()) {
    return (
      <View style={s.emptyState}>
        <Ionicons name="link-outline" size={52} color={Colors.textTertiary} style={{ marginBottom: Spacing.lg }} />
        <Text style={s.emptyTitle}>没有原始链接</Text>
        <Text style={s.emptyDesc}>
          海报中未识别到有效房源链接。{'\n'}
          可确保海报二维码清晰后重新上传，或手动在贝壳 App 内复制链接。
        </Text>
      </View>
    );
  }

  // 微信浏览器 User-Agent，用于绕过贝壳等平台的 WebView 检测
  const stubUrl = isLikelyInvalidBeikePosterUrl(url);

  function retryLoad() {
    setLoadError('');
    setPageLoaded(false);
    setExtractBundle(null);
    setReloadKey(k => k + 1);
  }

  function handleMessage(e: any) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'pageExtract') {
        const text = String(msg.text || '').trim();
        const facilities = Array.isArray(msg.facilities)
          ? msg.facilities.filter((x: unknown) => typeof x === 'string')
          : [];
        const imageUrls = Array.isArray(msg.imageUrls)
          ? msg.imageUrls.filter((x: unknown) => typeof x === 'string')
          : [];
        if (text.length > 30 || facilities.length > 0 || imageUrls.length > 0) {
          setExtractBundle({ text, facilities, imageUrls });
          onPageExtract({ text, facilities, imageUrls });
        } else if (pageLoaded) {
          setLoadError('页面无内容，可能被拦截或需先登录');
        }
        return;
      }
      if (msg.type === 'pageContent' && msg.content && String(msg.content).trim().length > 30) {
        const t = String(msg.content).trim();
        setExtractBundle({ text: t, facilities: [], imageUrls: [] });
        onPageExtract({ text: t, facilities: [], imageUrls: [] });
      }
      // ★ 处理detail_images消息（专门的图片提取）
      if (msg.type === 'detail_images' && Array.isArray(msg.images) && msg.images.length > 0) {
        const images = msg.images.filter((x: unknown) => typeof x === 'string' && x.startsWith('http'));
        if (images.length > 0) {
          console.log('[BrowserTab] Extracted detail images:', images.length);
          // 更新extractBundle，保留现有的text和facilities
          setExtractBundle(prev => ({
            text: prev?.text || '',
            facilities: prev?.facilities || [],
            imageUrls: images,
          }));
          // 通知父组件
          onPageExtract({
            text: extractBundle?.text || '',
            facilities: extractBundle?.facilities || [],
            imageUrls: images,
          });
        }
      }
    } catch {}
  }

  function hasUsefulExtract(b: typeof extractBundle): b is NonNullable<typeof extractBundle> {
    return Boolean(
      b && (b.text.trim().length > 30 || b.facilities.length > 0 || b.imageUrls.length > 0),
    );
  }

  function handleAnalysis() {
    if (hasUsefulExtract(extractBundle)) {
      onStartAnalysis(extractBundle.text.trim().length >= 30 ? extractBundle.text : undefined);
    } else if (pageLoaded) {
      // 页面已加载，手动触发提取后再分析
      webViewRef.current?.injectJavaScript(INJECT_EXTRACT_PAGE_TEXT);
      setTimeout(() => onStartAnalysis(), 800);
    } else {
      // 页面未加载成功，直接分析（基于结构化数据）
      onStartAnalysis();
    }
  }

  return (
    <View style={{ flex: 1 }}>
      {stubUrl ? (
        <View style={s.browserStubBanner}>
          <Text style={s.browserStubBannerText}>
            链接可能不完整或已失效。若网页空白，可在浏览器中手动搜索或复制链接到微信打开。
          </Text>
        </View>
      ) : null}
      {loadError ? (
        <View style={s.browserErrorBanner}>
          <Ionicons name="alert-circle-outline" size={18} color={Colors.warning} style={{ marginRight: 6 }} />
          <Text style={s.browserErrorText}>{loadError}</Text>
          <TouchableOpacity onPress={retryLoad} style={s.browserRetryBtn}>
            <Text style={s.browserRetryText}>重试</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {extractBundle && hasUsefulExtract(extractBundle) ? (
        <View style={s.pageContentBanner}>
          <Text style={s.pageContentBannerText}>✅ 已获取页面内容，精筛将基于真实页面分析</Text>
        </View>
      ) : null}
      <WebView
        key={reloadKey}
        ref={webViewRef}
        source={{
          uri: url,
          headers: { Referer: 'https://m.ke.com/' },
        }}
        userAgent={WECHAT_UA}
        onLoadStart={() => { setLoading(true); setPageLoaded(false); setLoadError(''); }}
        onLoad={() => {
          console.log('[BrowserTab] onLoad triggered, url:', url?.substring(0, 100));
          if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
          setLoading(false);
          setPageLoaded(true);
          setLoadError('');
          loadTimeoutRef.current = setTimeout(() => {
            if (!extractBundle || (extractBundle.text.length < 30 && extractBundle.facilities.length === 0)) {
              setLoadError('加载超时，页面可能无内容或需先登录');
            }
          }, 18000);
          setTimeout(() => {
            // 先注入页面正文提取脚本
            console.log('[BrowserTab] Injecting page text extraction script...');
            webViewRef.current?.injectJavaScript(INJECT_EXTRACT_PAGE_TEXT);
            
            // 延迟注入图片提取脚本（等待图片加载）
            setTimeout(() => {
              console.log('[BrowserTab] Injecting image extraction script...');
              const imageExtractScript = `
(function() {
  console.log('[ImageScript] Starting image extraction...');
  var imgs = [];
  var selectors = [
    '.property-photo img', '.house-photo img', '.pic-list img',
    '.swiper-slide img', '.content__article__slide img',
    '.housePic img', '.imgList img', '.album-img img',
    '[class*="photo"] img', '[class*="pic"] img', '[class*="swiper"] img'
  ];
  selectors.forEach(function(sel) {
    document.querySelectorAll(sel).forEach(function(img) {
      var src = img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
      if (src && src.startsWith('http') && 
          src.indexOf('placeholder') === -1 && 
          src.indexOf('default') === -1 &&
          (img.naturalWidth > 100 || img.width > 100)) {
        imgs.push(src);
      }
    });
  });
  imgs = [...new Set(imgs)].slice(0, 10);
  console.log('[ImageScript] Found imgs:', imgs.length, imgs.length > 0 ? imgs[0] : 'none');
  if (imgs.length > 0) {
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'detail_images', images: imgs}));
  } else {
    console.log('[ImageScript] No images found, page might not have loaded yet');
  }
})();
`;
              webViewRef.current?.injectJavaScript(imageExtractScript);
            }, 2000);
          }, 500);
        }}
        onLoadEnd={() => setLoading(false)}
        onError={(e) => {
          if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
          setLoading(false);
          setPageLoaded(false);
          const desc = e?.nativeEvent?.description || '';
          if (/403|forbidden/i.test(desc)) {
            setLoadError('页面拒绝访问（403），可尝试浏览器打开或检查登录态');
          } else if (stubUrl) {
            setLoadError('链接无效或房源已下架，请复制链接到微信/App 查看');
          } else {
            setLoadError('页面加载失败，请检查网络后重试');
          }
        }}
        onHttpError={(e) => {
          if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
          const code = e?.nativeEvent?.statusCode;
          if (code === 403) setLoadError('页面拒绝访问（403），可尝试浏览器打开');
          else if (code && code >= 400) setLoadError(`页面加载异常（HTTP ${code}）`);
        }}
        onMessage={handleMessage}
        style={{ flex: 1 }}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        mixedContentMode="always"
        renderLoading={() => (
          <View style={s.loadingWrap}>
            <ActivityIndicator size="large" color="#00ae66" />
            <Text style={s.loadingText}>加载原始页面...</Text>
          </View>
        )}
      />
      <View style={s.browserFooter}>
        <TouchableOpacity
          style={[s.deepBtn, { flex: 1, marginRight: 8, backgroundColor: '#555' }]}
          onPress={() => Linking.openURL(url)}
        >
          <Text style={s.deepBtnText}>浏览器打开</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.deepBtn, { flex: 1 }]}
          onPress={handleAnalysis}
        >
          <Text style={s.deepBtnText}>精筛分析</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── 可折叠功能卡片组件 ──────────────────────────────────────
function CollapsibleFeatureCard({
  title,
  icon,
  borderColor,
  isExpanded,
  onToggle,
  children,
}: {
  title: string;
  icon: string;
  borderColor: string;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={[s.collapsibleCard, { borderLeftColor: borderColor }]}>
      <TouchableOpacity 
        style={s.collapsibleHeader} 
        onPress={onToggle}
        activeOpacity={0.7}
      >
        <View style={s.collapsibleHeaderLeft}>
          <Ionicons name={icon as any} size={22} color={borderColor} />
          <Text style={s.collapsibleTitle}>{title}</Text>
        </View>
        <Ionicons 
          name={isExpanded ? 'chevron-up' : 'chevron-down'} 
          size={20} 
          color={Colors.textSecondary} 
        />
      </TouchableOpacity>
      {isExpanded && (
        <View style={s.collapsibleContent}>
          {children}
        </View>
      )}
    </View>
  );
}

// ── 精筛报告 Tab ──────────────────────────────────────────────
function AnalysisTab({
  state,
  analysis,
  listing,
  onRetry,
  onClearDeepRecords,
  onSwitchToBrowser,
  bargainScripts,
  crossResults,
  xhsReview,
  onGenerateBargain,
  onCrossPlatformCheck,
  onGenerateXHSReview,
  bargainLoading,
  crossLoading,
  xhsLoading,
}: {
  state: AnalysisState;
  analysis: DeepAnalysis | null;
  listing: Listing;
  onRetry: () => void;
  onClearDeepRecords: () => void;
  onSwitchToBrowser?: () => void;
  bargainScripts: BargainScript[];
  crossResults: MatchResult[];
  xhsReview: string;
  onGenerateBargain: () => void;
  onCrossPlatformCheck: () => void;
  onGenerateXHSReview: () => void;
  bargainLoading: boolean;
  crossLoading: boolean;
  xhsLoading: boolean;
}) {
  // 折叠状态管理
  const [expandedSections, setExpandedSections] = useState({
    analysis: state === 'done', // 如果已完成分析则默认展开
    compare: false,
    xhs: false,
    bargain: false,
  });

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  // 当功能完成时自动展开对应区块
  const autoExpandOnComplete = (section: keyof typeof expandedSections) => {
    if (!expandedSections[section]) {
      setExpandedSections(prev => ({ ...prev, [section]: true }));
    }
  };

  // 如果没有分析结果，显示四个独立功能卡片
  if (!analysis) {
    return (
      <ScrollView style={s.content} showsVerticalScrollIndicator={false}>
        {/* 1. 精筛分析 */}
        <CollapsibleFeatureCard
          title="精筛分析"
          icon="search-outline"
          borderColor="#2196F3"
          isExpanded={expandedSections.analysis}
          onToggle={() => toggleSection('analysis')}
        >
          {state === 'idle' && (
            <View style={s.featureEmptyState}>
              <Text style={s.featureEmptyText}>点击下方按钮，AI 将深度分析这套房源的优缺点、隐藏风险与话术陷阱</Text>
              <TouchableOpacity style={s.featureActionBtn} onPress={onRetry}>
                <Text style={s.featureActionBtnText}>开始精筛分析</Text>
              </TouchableOpacity>
            </View>
          )}
          {state === 'loading' && (
            <View style={s.featureLoadingState}>
              <ActivityIndicator size="small" color={Colors.primary} />
              <Text style={s.featureLoadingText}>AI 正在深度分析中...</Text>
            </View>
          )}
          {state === 'error' && (
            <View style={s.featureEmptyState}>
              <Text style={s.featureErrorText}>分析失败，请检查 API Key 配置</Text>
              <TouchableOpacity style={s.featureActionBtn} onPress={onRetry}>
                <Text style={s.featureActionBtnText}>重新分析</Text>
              </TouchableOpacity>
            </View>
          )}
        </CollapsibleFeatureCard>

        {/* 2. 多平台比价 */}
        <CollapsibleFeatureCard
          title="多平台比价"
          icon="bar-chart-outline"
          borderColor="#00ae66"
          isExpanded={expandedSections.compare}
          onToggle={() => toggleSection('compare')}
        >
          <TouchableOpacity 
            style={[s.featureActionBtn, crossLoading && s.featureActionBtnDisabled]}
            onPress={onCrossPlatformCheck}
            disabled={crossLoading}
          >
            {crossLoading ? (
              <>
                <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                <Text style={s.featureActionBtnText}>搜索中...</Text>
              </>
            ) : (
              <Text style={s.featureActionBtnText}>
                {crossResults.length > 0 ? '重新搜索' : '开始搜索'}
              </Text>
            )}
          </TouchableOpacity>
          
          {/* 搜索进度条 - 显示各平台搜索状态 */}
          {crossLoading && (
            <View style={s.crossProgressContainer}>
              <Text style={s.crossProgressTitle}>搜索进度</Text>
              {(['anjuke', 'beike', 'lianjia'] as const).map(platform => {
                const platformLabels = { anjuke: '安居客', beike: '贝壳', lianjia: '链家' };
                const status = listing.platform === platform ? '当前平台' : '等待搜索';
                return (
                  <View key={platform} style={s.crossProgressItem}>
                    <View style={s.crossProgressIcon}>
                      {status === '当前平台' ? (
                        <Ionicons name="checkmark-circle" size={16} color="#999" />
                      ) : status === '等待搜索' ? (
                        <Ionicons name="ellipse-outline" size={16} color="#ddd" />
                      ) : (
                        <ActivityIndicator size="small" color={Colors.primary} />
                      )}
                    </View>
                    <Text style={s.crossProgressPlatform}>{platformLabels[platform]}</Text>
                    <Text style={s.crossProgressStatus}>{status}</Text>
                  </View>
                );
              })}
            </View>
          )}
          
          {crossResults.length > 0 && (
            <View style={s.featureResultArea}>
              <Text style={s.featureResultTitle}>找到 {crossResults.length} 个相似房源</Text>
              {crossResults.slice(0, 2).map((result, i) => (
                <View key={i} style={s.featureResultItem}>
                  <Text style={s.featureResultText}>
                    {result.listing.platform === 'beike' ? '贝壳' : result.listing.platform === 'lianjia' ? '链家' : '安居客'} · {result.listing.price}元/月
                  </Text>
                </View>
              ))}
            </View>
          )}
        </CollapsibleFeatureCard>

        {/* 3. 小红书评价 */}
        <CollapsibleFeatureCard
          title="小红书评价"
          icon="book-outline"
          borderColor="#FF6B9D"
          isExpanded={expandedSections.xhs}
          onToggle={() => toggleSection('xhs')}
        >
          <TouchableOpacity 
            style={[s.featureActionBtn, xhsLoading && s.featureActionBtnDisabled]}
            onPress={onGenerateXHSReview}
            disabled={xhsLoading}
          >
            {xhsLoading ? (
              <>
                <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                <Text style={s.featureActionBtnText}>收集中...</Text>
              </>
            ) : (
              <Text style={s.featureActionBtnText}>
                {xhsReview ? '重新生成' : '生成评价'}
              </Text>
            )}
          </TouchableOpacity>
          {xhsReview && (
            <View style={s.featureResultArea}>
              <Text style={s.featureResultTitle}>小红书真实评价</Text>
              <Text style={s.xhsReviewText} numberOfLines={3}>{xhsReview}</Text>
            </View>
          )}
        </CollapsibleFeatureCard>

        {/* 4. 砍价话术 */}
        <CollapsibleFeatureCard
          title="砍价话术"
          icon="chatbubbles-outline"
          borderColor="#FF9800"
          isExpanded={expandedSections.bargain}
          onToggle={() => toggleSection('bargain')}
        >
          <TouchableOpacity 
            style={[s.featureActionBtn, bargainLoading && s.featureActionBtnDisabled]}
            onPress={onGenerateBargain}
            disabled={bargainLoading}
          >
            {bargainLoading ? (
              <>
                <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                <Text style={s.featureActionBtnText}>生成中...</Text>
              </>
            ) : (
              <Text style={s.featureActionBtnText}>
                {bargainScripts.length > 0 ? '重新生成' : '生成话术'}
              </Text>
            )}
          </TouchableOpacity>
          {bargainScripts.length > 0 && (
            <View style={s.featureResultArea}>
              <Text style={s.featureResultTitle}>生成了 {bargainScripts.length} 条话术</Text>
              {bargainScripts.slice(0, 2).map((script, i) => (
                <View key={i} style={s.featureResultItem}>
                  <Text style={s.featureResultText} numberOfLines={2}>{script.script}</Text>
                </View>
              ))}
            </View>
          )}
        </CollapsibleFeatureCard>

        <View style={{ height: 60 }} />
      </ScrollView>
    );
  }

  // 解析 Markdown 报告的各个部分
  const parseMarkdownSections = (raw: string) => {
    const sections: Record<string, string> = {};
    
    // 提取评分依据
    const rationaleMatch = raw.match(/###\s*评分依据\s*\n([\s\S]*?)(?=\n###|$)/i);
    if (rationaleMatch) sections.scoreRationale = rationaleMatch[1].trim();
    
    // 提取优点
    const prosMatch = raw.match(/###\s*✅?\s*优点\s*\n([\s\S]*?)(?=\n###|$)/i);
    if (prosMatch) sections.pros = prosMatch[1].trim();
    
    // 提取缺点与风险
    const consMatch = raw.match(/###\s*⚠️?\s*缺点(?:与风险)?\s*\n([\s\S]*?)(?=\n###|$)/i);
    if (consMatch) sections.cons = consMatch[1].trim();
    
    // 提取价格分析
    const priceMatch = raw.match(/###\s*💰?\s*价格分析\s*\n([\s\S]*?)(?=\n###|$)/i);
    if (priceMatch) sections.priceAnalysis = priceMatch[1].trim();
    
    // 提取居住建议
    const suggestionMatch = raw.match(/###\s*🏠?\s*居住建议\s*\n([\s\S]*?)(?=\n###|$)/i);
    if (suggestionMatch) sections.suggestion = suggestionMatch[1].trim();
    
    return sections;
  };

  // 从 listing 的 deepAnalysis 记录中获取原始 Markdown
  const sections = analysis.scoreRationale || analysis.pros.length > 0 
    ? {} 
    : parseMarkdownSections(analysis.summary);

  // 根据评分确定标签
  const getScoreLabel = (score: number) => {
    if (score >= 8) return { text: '推荐', color: '#4CAF50', bg: '#E8F5E9' };
    if (score >= 6) return { text: '可考虑', color: '#FF9800', bg: '#FFF3E0' };
    return { text: '谨慎', color: '#F44336', bg: '#FFEBEE' };
  };

  const scoreLabel = getScoreLabel(analysis.score);

  return (
    <ScrollView style={s.content} showsVerticalScrollIndicator={false}>
      {/* 顶部评分区 - 重新设计 */}
      <View style={s.analysisScoreHeader}>
        <Text style={s.analysisScoreBig}>{analysis.score.toFixed(1)}</Text>
        <Text style={s.analysisScoreMax}>/ 10</Text>
        <View style={[s.scoreTagBadge, { backgroundColor: scoreLabel.bg }]}>
          <Text style={[s.scoreTagText, { color: scoreLabel.color }]}>{scoreLabel.text}</Text>
        </View>
      </View>

      {/* 房源图片展示区 */}
      {listing.detailImages && listing.detailImages.length > 0 && (
        <View style={s.imageGallerySection}>
          <View style={s.imageGalleryHeader}>
            <Ionicons name="images-outline" size={20} color={Colors.primary} />
            <Text style={s.imageGalleryTitle}>房源实拍图 ({listing.detailImages.length})</Text>
          </View>
          <ScrollView 
            horizontal 
            showsHorizontalScrollIndicator={false}
            style={s.imageGalleryScroll}
            contentContainerStyle={s.imageGalleryContent}
          >
            {listing.detailImages.map((imgUrl, index) => (
              <TouchableOpacity
                key={index}
                style={s.imageGalleryItem}
                onPress={() => {
                  Alert.alert(
                    `图片 ${index + 1}/${listing.detailImages?.length}`,
                    imgUrl,
                    [
                      { text: '关闭', style: 'cancel' },
                      { text: '在浏览器打开', onPress: () => Linking.openURL(imgUrl) }
                    ]
                  );
                }}
              >
                <Image
                  source={{ uri: imgUrl }}
                  style={s.imageGalleryImage}
                  resizeMode="cover"
                />
                <View style={s.imageGalleryIndex}>
                  <Text style={s.imageGalleryIndexText}>{index + 1}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* 评分依据 - 蓝色左边框 */}
      {(analysis.scoreRationale || sections.scoreRationale) && (
        <View style={[s.analysisSection, s.analysisSectionBlue]}>
          <View style={s.analysisSectionHeader}>
            <Ionicons name="analytics-outline" size={20} color="#2196F3" />
            <Text style={[s.analysisSectionTitle, { color: '#2196F3' }]}>评分依据</Text>
          </View>
          <Markdown style={cleanMarkdownStyles}>
            {analysis.scoreRationale || sections.scoreRationale || ''}
          </Markdown>
        </View>
      )}

      {/* 优点 - 绿色左边框 */}
      {(analysis.pros.length > 0 || sections.pros) && (
        <View style={[s.analysisSection, s.analysisSectionGreen]}>
          <View style={s.analysisSectionHeader}>
            <Ionicons name="checkmark-circle-outline" size={20} color="#4CAF50" />
            <Text style={[s.analysisSectionTitle, { color: '#4CAF50' }]}>优点</Text>
          </View>
          {analysis.pros.length > 0 ? (
            analysis.pros.map((pro, i) => (
              <View key={i} style={s.cleanListItem}>
                <View style={[s.cleanListBullet, { backgroundColor: '#4CAF50' }]} />
                <Text style={s.cleanListText}>{pro}</Text>
              </View>
            ))
          ) : (
            <Markdown style={cleanMarkdownStyles}>{sections.pros || ''}</Markdown>
          )}
        </View>
      )}

      {/* 缺点与风险 - 红色左边框 */}
      {(analysis.cons.length > 0 || analysis.risks.length > 0 || sections.cons) && (
        <View style={[s.analysisSection, s.analysisSectionRed]}>
          <View style={s.analysisSectionHeader}>
            <Ionicons name="warning-outline" size={20} color="#FF5722" />
            <Text style={[s.analysisSectionTitle, { color: '#FF5722' }]}>缺点与风险</Text>
          </View>
          {analysis.cons.length > 0 ? (
            analysis.cons.map((con, i) => (
              <View key={i} style={s.cleanListItem}>
                <View style={[s.cleanListBullet, { backgroundColor: '#FF5722' }]} />
                <Text style={s.cleanListText}>{con}</Text>
              </View>
            ))
          ) : null}
          {analysis.risks.length > 0 ? (
            analysis.risks.map((risk, i) => (
              <View key={i} style={s.cleanListItem}>
                <View style={[s.cleanListBullet, { backgroundColor: '#FF5722' }]} />
                <Text style={s.cleanListText}>{risk}</Text>
              </View>
            ))
          ) : null}
          {!analysis.cons.length && !analysis.risks.length && sections.cons ? (
            <Markdown style={cleanMarkdownStyles}>{sections.cons}</Markdown>
          ) : null}
        </View>
      )}

      {/* 价格分析 - 紫色左边框 */}
      {(analysis.summary || sections.priceAnalysis) && (
        <View style={[s.analysisSection, s.analysisSectionPurple]}>
          <View style={s.analysisSectionHeader}>
            <Ionicons name="cash-outline" size={20} color="#9C27B0" />
            <Text style={[s.analysisSectionTitle, { color: '#9C27B0' }]}>价格分析</Text>
          </View>
          <Markdown style={cleanMarkdownStyles}>
            {sections.priceAnalysis || analysis.summary || ''}
          </Markdown>
        </View>
      )}

      {/* 实拍图分析 - 橙色左边框 */}
      {analysis.imageAnalysis && (
        <View style={[s.analysisSection, s.analysisSectionOrange]}>
          <View style={s.analysisSectionHeader}>
            <Ionicons name="camera-outline" size={20} color="#FF9800" />
            <Text style={[s.analysisSectionTitle, { color: '#FF9800' }]}>实拍图分析</Text>
          </View>
          <Markdown style={cleanMarkdownStyles}>{analysis.imageAnalysis}</Markdown>
        </View>
      )}

      {/* 居住建议 - 灰蓝色左边框 */}
      {(analysis.suggestion || sections.suggestion) && (
        <View style={[s.analysisSection, s.analysisSectionGray]}>
          <View style={s.analysisSectionHeader}>
            <Ionicons name="home-outline" size={20} color="#607D8B" />
            <Text style={[s.analysisSectionTitle, { color: '#607D8B' }]}>居住建议</Text>
          </View>
          <Markdown style={cleanMarkdownStyles}>
            {analysis.suggestion || sections.suggestion || ''}
          </Markdown>
        </View>
      )}

      {/* 高级功能区 */}
      <View style={s.advancedFeaturesSection}>
        <Text style={s.advancedFeaturesTitle}>高级功能</Text>
        
        {/* 1. 多平台比价 */}
        <View style={s.advancedFeatureBlock}>
          <View style={s.advancedFeatureBlockHeader}>
            <Ionicons name="bar-chart-outline" size={22} color={Colors.primary} />
            <Text style={s.advancedFeatureBlockTitle}>多平台比价</Text>
          </View>
          <TouchableOpacity 
            style={[s.advancedFeatureButton, crossLoading && s.advancedFeatureButtonDisabled]}
            onPress={onCrossPlatformCheck}
            disabled={crossLoading}
          >
            {crossLoading ? (
              <>
                <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                <Text style={s.advancedFeatureButtonText}>搜索中...</Text>
              </>
            ) : (
              <>
                <Ionicons name="search-outline" size={18} color="#fff" style={{ marginRight: 6 }} />
                <Text style={s.advancedFeatureButtonText}>
                  {crossResults.length > 0 ? '重新搜索' : '开始搜索'}
                </Text>
              </>
            )}
          </TouchableOpacity>
          {crossResults.length > 0 && (
            <View style={s.advancedFeatureResultArea}>
              <Text style={s.advancedFeatureResultTitle}>找到 {crossResults.length} 个相似房源：</Text>
              {crossResults.map((result, i) => (
                <View key={i} style={s.crossResultItem}>
                  <View style={s.crossResultHeader}>
                    <Text style={s.crossResultPlatform}>
                      {result.listing.platform === 'beike' ? '贝壳' : result.listing.platform === 'lianjia' ? '链家' : '安居客'}
                    </Text>
                    <Text style={s.crossResultPrice}>{result.listing.price}元/月</Text>
                    <Text style={[
                      s.crossResultDiff,
                      result.priceDiff === 0 ? s.crossResultDiffSame : 
                      result.priceDiff < 0 ? s.crossResultDiffLower : s.crossResultDiffHigher
                    ]}>
                      {result.priceDiff === 0 ? '同价' : 
                       result.priceDiff < 0 ? `低${Math.abs(result.priceDiff)}元` : 
                       `高${result.priceDiff}元`}
                    </Text>
                  </View>
                  <Text style={s.crossResultTitle} numberOfLines={1}>{result.listing.title}</Text>
                  <Text style={s.crossResultInfo} numberOfLines={1}>
                    {result.listing.area}m² · {result.listing.floor}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* 2. 小红书评价 */}
        <View style={s.advancedFeatureBlock}>
          <View style={s.advancedFeatureBlockHeader}>
            <Ionicons name="book-outline" size={22} color="#FF6B9D" />
            <Text style={s.advancedFeatureBlockTitle}>小红书评价</Text>
          </View>
          <TouchableOpacity 
            style={[s.advancedFeatureButton, xhsLoading && s.advancedFeatureButtonDisabled]}
            onPress={onGenerateXHSReview}
            disabled={xhsLoading}
          >
            {xhsLoading ? (
              <>
                <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                <Text style={s.advancedFeatureButtonText}>收集中...</Text>
              </>
            ) : (
              <>
                <Ionicons name="book-outline" size={18} color="#fff" style={{ marginRight: 6 }} />
                <Text style={s.advancedFeatureButtonText}>
                  {xhsReview ? '重新生成' : '生成评价'}
                </Text>
              </>
            )}
          </TouchableOpacity>
          {xhsReview && (
            <View style={s.advancedFeatureResultArea}>
              <Text style={s.advancedFeatureResultTitle}>小红书真实评价：</Text>
              <Text style={s.xhsReviewText} numberOfLines={4}>{xhsReview}</Text>
            </View>
          )}
        </View>

        {/* 3. 砍价话术 */}
        <View style={s.advancedFeatureBlock}>
          <View style={s.advancedFeatureBlockHeader}>
            <Ionicons name="chatbubbles-outline" size={22} color={Colors.primary} />
            <Text style={s.advancedFeatureBlockTitle}>砍价话术</Text>
          </View>
          <TouchableOpacity 
            style={[s.advancedFeatureButton, bargainLoading && s.advancedFeatureButtonDisabled]}
            onPress={onGenerateBargain}
            disabled={bargainLoading}
          >
            {bargainLoading ? (
              <>
                <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                <Text style={s.advancedFeatureButtonText}>生成中...</Text>
              </>
            ) : (
              <>
                <Ionicons name="bulb-outline" size={18} color="#fff" style={{ marginRight: 6 }} />
                <Text style={s.advancedFeatureButtonText}>
                  {bargainScripts.length > 0 ? '重新生成' : '生成话术'}
                </Text>
              </>
            )}
          </TouchableOpacity>
          {bargainScripts.length > 0 && (
            <View style={s.advancedFeatureResultArea}>
              <Text style={s.advancedFeatureResultTitle}>生成了 {bargainScripts.length} 条话术：</Text>
              {bargainScripts.map((script, i) => (
                <View key={i} style={s.bargainScriptItem}>
                  <View style={s.bargainScriptHeader}>
                    <Text style={s.bargainScriptReason}>{getBargainCategoryLabel(script.category)}</Text>
                    <TouchableOpacity
                      onPress={() => {
                        Clipboard.setString(script.script);
                        Alert.alert('已复制', '话术已复制到剪贴板');
                      }}
                    >
                      <Ionicons name="copy-outline" size={16} color={Colors.primary} />
                    </TouchableOpacity>
                  </View>
                  <Text style={s.bargainScriptText}>{script.script}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </View>

      {/* 底部按钮 */}
      <View style={s.actionArea}>
        {listing.url && onSwitchToBrowser && (
          <TouchableOpacity 
            style={[s.deepBtn, { backgroundColor: '#607D8B' }]} 
            onPress={onSwitchToBrowser}
          >
            <Text style={s.deepBtnText}>查看原始页面</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={s.retryAnalysisBtn} onPress={onRetry}>
          <Text style={s.retryAnalysisBtnText}>重新分析</Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: 60 }} />
    </ScrollView>
  );
}

// Markdown 样式配置 - 旧版（保留兼容）
const markdownStyles = {
  body: {
    fontSize: 14,
    lineHeight: 22,
    color: Colors.textPrimary,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 8,
  },
  strong: {
    fontWeight: '700' as '700',
  },
  em: {
    fontStyle: 'italic' as 'italic',
  },
  bullet_list: {
    marginTop: 4,
  },
  ordered_list: {
    marginTop: 4,
  },
  list_item: {
    marginTop: 4,
  },
};

// 简洁 Markdown 样式 - 新版精筛报告
const cleanMarkdownStyles = {
  body: {
    fontSize: 15,
    lineHeight: 24,
    color: '#333',
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 12,
  },
  strong: {
    fontWeight: '700' as '700',
    color: '#222',
  },
  em: {
    fontStyle: 'italic' as 'italic',
    color: '#555',
  },
  heading1: {
    fontSize: 20,
    fontWeight: '700' as '700',
    color: '#222',
    marginTop: 16,
    marginBottom: 12,
  },
  heading2: {
    fontSize: 18,
    fontWeight: '700' as '700',
    color: '#222',
    marginTop: 14,
    marginBottom: 10,
  },
  heading3: {
    fontSize: 16,
    fontWeight: '600' as '600',
    color: '#333',
    marginTop: 12,
    marginBottom: 8,
  },
  heading4: {
    fontSize: 15,
    fontWeight: '600' as '600',
    color: '#333',
    marginTop: 10,
    marginBottom: 6,
  },
  bullet_list: {
    marginTop: 8,
    marginBottom: 8,
    marginLeft: 0,
  },
  ordered_list: {
    marginTop: 8,
    marginBottom: 8,
    marginLeft: 0,
  },
  list_item: {
    marginTop: 6,
    marginBottom: 6,
    flexDirection: 'row' as 'row',
  },
  bullet_list_icon: {
    fontSize: 15,
    lineHeight: 24,
    marginLeft: 0,
    marginRight: 8,
    color: '#666',
  },
  ordered_list_icon: {
    fontSize: 15,
    lineHeight: 24,
    marginLeft: 0,
    marginRight: 8,
    color: '#666',
  },
  code_inline: {
    backgroundColor: '#f5f5f5',
    color: '#e91e63',
    fontSize: 14,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 3,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  code_block: {
    backgroundColor: '#f5f5f5',
    color: '#333',
    fontSize: 13,
    padding: 12,
    borderRadius: 6,
    marginTop: 8,
    marginBottom: 8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fence: {
    backgroundColor: '#f5f5f5',
    color: '#333',
    fontSize: 13,
    padding: 12,
    borderRadius: 6,
    marginTop: 8,
    marginBottom: 8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  blockquote: {
    backgroundColor: '#f9f9f9',
    borderLeftWidth: 4,
    borderLeftColor: '#ddd',
    paddingLeft: 12,
    paddingVertical: 8,
    marginTop: 8,
    marginBottom: 8,
  },
  hr: {
    backgroundColor: '#e0e0e0',
    height: 1,
    marginTop: 16,
    marginBottom: 16,
  },
  link: {
    color: '#2196F3',
    textDecorationLine: 'underline' as 'underline',
  },
  text: {
    fontSize: 15,
    lineHeight: 24,
    color: '#333',
  },
};

// ── 样式 ──────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bgSecondary },

  navbar: {
    backgroundColor: Colors.bgPrimary,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  navBack: { padding: Spacing.xs, marginRight: Spacing.md },
  navBackText: { fontSize: 22, color: Colors.primary, fontWeight: '600' },
  navTitle: { flex: 1, ...Typography.h3, color: Colors.textPrimary },
  navActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  navCompare: { padding: Spacing.xs },
  navFav: { padding: Spacing.xs },

  tabBar: {
    flexDirection: 'row',
    backgroundColor: Colors.bgPrimary,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  tabItem: {
    flex: 1,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabItemActive: { borderBottomColor: Colors.primary },
  tabLabel: { ...Typography.label, color: Colors.textSecondary, fontWeight: '500' },
  tabLabelActive: { color: Colors.primary, fontWeight: '700' },

  content: { flex: 1 },

  card: {
    backgroundColor: Colors.bgPrimary,
    marginHorizontal: Spacing.md,
    marginTop: Spacing.lg,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    ...Shadow.xs,
  },
  sectionTitle: {
    ...Typography.h4,
    color: Colors.textPrimary,
    marginBottom: Spacing.lg,
  },

  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    backgroundColor: Colors.bgPrimary,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  price: { fontSize: 26, fontWeight: '800', color: '#fe5500' },
  priceUnit: { fontSize: 14, fontWeight: '400', color: Colors.textSecondary },
  scrapedAt: { ...Typography.labelSmall, color: Colors.textTertiary, marginTop: Spacing.xs },
  commuteText: { ...Typography.label, color: Colors.textSecondary, marginTop: Spacing.xs },
  commuteError: { ...Typography.labelSmall, color: Colors.warning, marginTop: Spacing.xs },
  commuteFailWrap: { marginTop: Spacing.xs },
  commuteMuted: { ...Typography.labelSmall, color: Colors.textSecondary, lineHeight: 18 },
  commuteFailDetail: { ...Typography.labelSmall, color: Colors.textTertiary, marginTop: 4, lineHeight: 16 },
  scoreBadge: {
    minWidth: 85,
    paddingHorizontal: 12,
    paddingVertical: Spacing.sm,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreHigh: { backgroundColor: Colors.primaryLight },
  scoreMid: { backgroundColor: '#fff8e6' },
  scoreLow: { backgroundColor: '#fff0f0' },
  scoreVal: { fontSize: 14, fontWeight: '700', color: Colors.primary },

  infoTitle: {
    ...Typography.h3,
    color: Colors.textPrimary,
    lineHeight: 22,
    marginBottom: Spacing.lg,
  },
  scrapedAtRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.xs },
  commuteRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.xs },
  aiCommentHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.lg },

  infoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.lg },
  infoItem: { flexDirection: 'row', alignItems: 'flex-start', width: '46%', gap: Spacing.md },
  infoIcon: { marginTop: 2 },
  infoLabel: { ...Typography.label, color: Colors.textSecondary },
  infoValue: { ...Typography.body2, color: Colors.textPrimary, marginTop: Spacing.xs, fontWeight: '600' },

  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  tag: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryLight,
    borderWidth: 1,
    borderColor: '#c8eddc',
  },
  tagText: { fontSize: 12, color: Colors.primary },

  aiComment: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, padding: Spacing.md },
  aiCommentText: { ...Typography.body2, color: Colors.textSecondary, lineHeight: 20 },

  actionArea: { margin: Spacing.md, gap: Spacing.md },

  secondaryBtnRow: { flexDirection: 'row', gap: Spacing.md },
  secondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight,
    minHeight: 44,
  },
  secondaryBtnDisabled: { opacity: 0.6 },
  secondaryBtnText: { fontSize: 13, fontWeight: '600', color: Colors.primary },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: Colors.bgPrimary,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: '80%',
    paddingTop: Spacing.lg,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  modalTitle: { ...Typography.h3, color: Colors.textPrimary, fontWeight: '700' },
  modalSubtitle: {
    ...Typography.labelSmall,
    color: Colors.textSecondary,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  modalScroll: { paddingHorizontal: Spacing.lg },

  // 砍价话术
  bargainItem: {
    marginTop: Spacing.lg,
    padding: Spacing.md,
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
  },
  bargainItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  bargainCategory: { ...Typography.label, fontWeight: '700', color: Colors.primary },
  bargainScript: { ...Typography.body2, color: Colors.textPrimary, lineHeight: 20 },
  bargainTip: { ...Typography.labelSmall, color: Colors.textTertiary, marginTop: Spacing.sm, fontStyle: 'italic' },

  // 跨平台比价
  crossStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  crossStatusLabel: { ...Typography.body2, fontWeight: '600', color: Colors.textPrimary },
  crossStatusValue: { ...Typography.body2, color: Colors.textSecondary, flex: 1, textAlign: 'right', marginLeft: Spacing.md },
  crossLoginNeededWrap: {
    alignItems: 'center',
    marginTop: Spacing.xl,
    padding: Spacing.lg,
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
  },
  platformLoginBtn: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
  },
  platformLoginBtnText: { fontSize: 13, fontWeight: '600', color: Colors.textInverse },
  crossErrorWrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: Spacing.lg,
    backgroundColor: '#fff8e6',
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  crossErrorText: { ...Typography.body2, color: '#8a5a00', flex: 1, lineHeight: 18 },
  crossEmptyText: { ...Typography.body2, color: Colors.textTertiary, marginTop: Spacing.xl, textAlign: 'center' },
  crossItem: {
    marginTop: Spacing.lg,
    padding: Spacing.md,
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  crossItemHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.xs },
  crossPlatform: { ...Typography.label, fontWeight: '700', color: Colors.textSecondary },
  crossPriceDiff: { ...Typography.label, fontWeight: '700' },
  crossCheaper: { color: '#00ae66' },
  crossDearer: { color: Colors.error },
  crossSame: { color: Colors.textSecondary },
  crossPrice: { fontSize: 20, fontWeight: '800', color: '#fe5500', marginBottom: Spacing.xs },
  crossDetail: { ...Typography.body2, color: Colors.textPrimary },
  crossMeta: { ...Typography.labelSmall, color: Colors.textTertiary, marginTop: Spacing.xs },
  crossLink: { ...Typography.label, color: Colors.primary, marginTop: Spacing.sm },
  externalDisclaimerText: {
    ...Typography.labelSmall,
    lineHeight: 15,
    color: Colors.textSecondary,
  },
  externalLinkRow: { flexDirection: 'row', gap: Spacing.md, alignItems: 'stretch' },
  externalLinkHalf: { flex: 1, minWidth: 0 },
  deepBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
  },
  deepBtnText: { fontSize: 15, fontWeight: '700', color: Colors.textInverse },
  copyLinkBtn: {
    borderRadius: Radius.lg,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    backgroundColor: Colors.primaryLight,
    borderWidth: 1,
    borderColor: '#b8e0cc',
  },
  copyLinkBtnText: { fontSize: 14, color: Colors.primary, fontWeight: '700' },
  listingLinkHint: {
    marginTop: Spacing.md,
    ...Typography.labelSmall,
    lineHeight: 16,
    color: Colors.textSecondary,
  },
  copySnippetBtn: {
    marginTop: Spacing.md,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    backgroundColor: Colors.bgPrimary,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  copySnippetBtnText: { ...Typography.h4, color: Colors.textSecondary, fontWeight: '600' },
  srcBtn: {
    borderRadius: Radius.lg,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  srcBtnText: { ...Typography.h4, color: Colors.textSecondary },

  // 精筛报告 - 优化后的卡片风格
  analysisScoreHeader: {
    alignItems: 'center',
    paddingVertical: 32,
    backgroundColor: '#FFFFFF',
    marginHorizontal: Spacing.md,
    marginTop: Spacing.md,
    marginBottom: Spacing.md,
    borderRadius: Radius.lg,
    ...Shadow.sm,
  },
  analysisScoreBig: {
    fontSize: 56,
    fontWeight: '800',
    color: '#00ae66',
    lineHeight: 64,
  },
  analysisScoreLabel: {
    fontSize: 12,
    fontWeight: '400',
    color: '#999',
    marginTop: 4,
  },
  analysisScoreSummary: {
    fontSize: 14,
    fontWeight: '400',
    color: '#999',
    marginTop: 8,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  analysisScoreMax: {
    fontSize: 28,
    fontWeight: '600',
    color: Colors.textTertiary,
  },
  scoreTagBadge: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
  },
  scoreTagText: {
    fontSize: 14,
    fontWeight: '700',
  },
  
  // 精筛报告模块 - 卡片化设计，使用色块区分
  analysisSection: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderRadius: Radius.lg,
    borderLeftWidth: 4,
    ...Shadow.xs,
  },
  analysisSectionBlue: {
    borderLeftColor: '#2196F3',
    backgroundColor: '#E3F2FD',
  },
  analysisSectionGreen: {
    borderLeftColor: '#4CAF50',
    backgroundColor: '#E8F5E9',
  },
  analysisSectionRed: {
    borderLeftColor: '#FF5722',
    backgroundColor: '#FFEBEE',
  },
  analysisSectionPurple: {
    borderLeftColor: '#9C27B0',
    backgroundColor: '#F3E5F5',
  },
  analysisSectionGray: {
    borderLeftColor: '#607D8B',
    backgroundColor: '#ECEFF1',
  },
  analysisSectionOrange: {
    borderLeftColor: '#FF9800',
    backgroundColor: '#FFF3E0',
  },
  analysisSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  analysisSectionEmoji: {
    fontSize: 16,
    marginRight: 8,
  },
  analysisSectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#222',
    marginLeft: 8,
  },
  analysisSectionDivider: {
    height: 1,
    backgroundColor: '#f0f0f0',
    marginVertical: 16,
  },
  
  // 简洁列表项 - 优化后的圆点样式
  cleanListItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 14,
    paddingLeft: 8,
  },
  cleanListBullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#999',
    marginRight: 12,
    marginTop: 8,
    flexShrink: 0,
  },
  analysisCard: {
    backgroundColor: Colors.bgPrimary,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    borderRadius: 12,
    padding: 16,
    ...Shadow.xs,
  },
  analysisCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  analysisCardEmoji: {
    fontSize: 20,
    marginRight: Spacing.sm,
  },
  analysisCardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  analysisCardGray: {
    backgroundColor: '#f5f5f5',
  },
  analysisCardGreen: {
    backgroundColor: '#f0fdf4',
  },
  analysisCardOrange: {
    backgroundColor: '#fff7ed',
  },
  analysisCardBlue: {
    backgroundColor: '#eff6ff',
  },
  analysisCardPurple: {
    backgroundColor: '#faf5ff',
  },
  analysisCardRed: {
    backgroundColor: '#fef2f2',
  },
  analysisCardYellow: {
    backgroundColor: '#fefce8',
  },
  markdownListItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: Spacing.sm,
  },
  markdownBullet: {
    fontSize: 16,
    color: Colors.primary,
    marginRight: Spacing.sm,
    marginTop: 2,
  },

  listItem: { flexDirection: 'row', marginBottom: Spacing.md, alignItems: 'flex-start' },
  listDot: { fontSize: 16, color: Colors.primary, marginRight: Spacing.md, marginTop: -1 },
  listText: { ...Typography.body2, color: Colors.textSecondary, lineHeight: 20, flex: 1 },

  riskCard: { borderWidth: 1, borderColor: '#ffd5d5' },
  suggestionCard: { backgroundColor: Colors.primaryLight },
  suggestionText: { fontSize: 14, color: Colors.primary, lineHeight: 22 },

  retryAnalysisBtn: {
    borderRadius: Radius.lg,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  retryAnalysisBtnText: { ...Typography.h4, color: Colors.textSecondary },
  clearDeepBtn: {
    borderRadius: Radius.lg,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ffd9d9',
    backgroundColor: '#fff5f5',
  },
  clearDeepBtnText: { fontSize: 14, color: Colors.error, fontWeight: '600' },

  linkStubHint: {
    ...Typography.body2,
    color: Colors.warning,
    lineHeight: 18,
    marginBottom: Spacing.md,
    paddingHorizontal: Spacing.xs,
  },
  pageContentBanner: {
    backgroundColor: Colors.primaryLight,
    borderBottomWidth: 1,
    borderBottomColor: '#b8e0cc',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  pageContentBannerText: {
    ...Typography.body2,
    color: Colors.primary,
    fontWeight: '600',
  },
  browserStubBanner: {
    backgroundColor: '#fff8e6',
    borderBottomWidth: 1,
    borderBottomColor: '#ffe0a3',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  browserStubBannerText: {
    ...Typography.body2,
    color: '#8a5a00',
    lineHeight: 18,
  },
  browserErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff0f0',
    borderBottomWidth: 1,
    borderBottomColor: '#ffcdd2',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  browserErrorText: { ...Typography.body2, color: '#c62828', flex: 1, lineHeight: 18 },
  browserRetryBtn: {
    marginLeft: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    backgroundColor: Colors.primary,
    borderRadius: Radius.sm,
  },
  browserRetryText: { fontSize: 12, fontWeight: '600', color: Colors.textInverse },

  // 精筛报告新字段
  scoreRationaleText: { ...Typography.body2, color: Colors.textPrimary, lineHeight: 20, marginTop: Spacing.sm },
  imageAnalysisText: { ...Typography.body2, color: Colors.textPrimary, lineHeight: 20, marginTop: Spacing.sm },
  noImageText: { ...Typography.body2, color: Colors.textTertiary, fontStyle: 'italic', marginTop: Spacing.sm },

  // 浏览器
  browserFooter: {
    backgroundColor: Colors.bgPrimary,
    padding: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.divider,
    flexDirection: 'row',
    gap: Spacing.md,
  },

  // 空态
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxxl,
    paddingBottom: 60,
  },
  emptyTitle: { ...Typography.h2, color: Colors.textPrimary, marginBottom: Spacing.md },
  emptyDesc: { ...Typography.body2, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: Spacing.xl },

  // 加载态
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.bgPrimary,
  },
  loadingText: { ...Typography.h3, color: Colors.textSecondary, marginTop: Spacing.lg, fontWeight: '600' },
  loadingSubText: { ...Typography.label, color: Colors.textSecondary, marginTop: Spacing.md, textAlign: 'center' },

  // 高级功能区
  advancedFeaturesSection: {
    marginHorizontal: Spacing.md,
    marginTop: Spacing.lg,
    marginBottom: Spacing.md,
  },
  advancedFeaturesTitle: {
    ...Typography.h4,
    color: Colors.textPrimary,
    marginBottom: Spacing.md,
    fontWeight: '700',
  },
  advancedFeatureCard: {
    backgroundColor: Colors.bgPrimary,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.divider,
    ...Shadow.xs,
  },
  advancedFeatureCardLoading: {
    opacity: 0.6,
  },
  advancedFeatureHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  advancedFeatureTitle: {
    ...Typography.h4,
    color: Colors.textPrimary,
    marginLeft: Spacing.sm,
    flex: 1,
    fontWeight: '600',
  },
  advancedFeatureBadge: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 20,
    alignItems: 'center',
  },
  advancedFeatureBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textInverse,
  },
  advancedFeatureLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  advancedFeatureLoadingText: {
    ...Typography.body2,
    color: Colors.textSecondary,
    marginLeft: Spacing.sm,
  },
  advancedFeatureContent: {
    marginTop: Spacing.xs,
  },
  advancedFeaturePreview: {
    ...Typography.body2,
    color: Colors.textSecondary,
    lineHeight: 20,
    marginBottom: Spacing.xs,
  },
  advancedFeatureMore: {
    ...Typography.labelSmall,
    color: Colors.textTertiary,
    fontStyle: 'italic',
    marginTop: Spacing.xs,
  },
  advancedFeatureDesc: {
    ...Typography.body2,
    color: Colors.textTertiary,
    marginTop: Spacing.xs,
  },

  // 高级功能区块样式（新版）
  advancedFeatureBlock: {
    backgroundColor: Colors.bgPrimary,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.divider,
    ...Shadow.xs,
  },
  advancedFeatureBlockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  advancedFeatureBlockTitle: {
    ...Typography.h4,
    color: Colors.textPrimary,
    marginLeft: Spacing.sm,
    fontWeight: '700',
  },
  advancedFeatureButton: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  advancedFeatureButtonDisabled: {
    opacity: 0.6,
  },
  advancedFeatureButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.textInverse,
  },
  advancedFeatureResultArea: {
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginTop: Spacing.sm,
  },
  advancedFeatureResultTitle: {
    ...Typography.label,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
    fontWeight: '600',
  },

  // 跨平台比价结果样式
  crossResultItem: {
    backgroundColor: Colors.bgPrimary,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  crossResultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.xs,
    gap: Spacing.sm,
  },
  crossResultPlatform: {
    ...Typography.label,
    fontWeight: '700',
    color: Colors.textSecondary,
  },
  crossResultPrice: {
    fontSize: 16,
    fontWeight: '800',
    color: '#fe5500',
    flex: 1,
  },
  crossResultDiff: {
    ...Typography.label,
    fontWeight: '700',
  },
  crossResultDiffSame: {
    color: Colors.textSecondary,
  },
  crossResultDiffLower: {
    color: '#00ae66',
  },
  crossResultDiffHigher: {
    color: Colors.error,
  },
  crossResultTitle: {
    ...Typography.body2,
    color: Colors.textPrimary,
    marginBottom: Spacing.xs,
  },
  crossResultInfo: {
    ...Typography.labelSmall,
    color: Colors.textTertiary,
  },

  // 小红书评价样式
  xhsReviewText: {
    ...Typography.body2,
    color: Colors.textPrimary,
    lineHeight: 22,
  },

  // 砍价话术样式
  bargainScriptItem: {
    backgroundColor: Colors.bgPrimary,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
  },
  bargainScriptHeader: {
    marginBottom: Spacing.sm,
  },
  bargainScriptReason: {
    ...Typography.label,
    fontWeight: '700',
    color: Colors.primary,
  },
  bargainScriptText: {
    ...Typography.body2,
    color: Colors.textPrimary,
    lineHeight: 20,
  },

  // 可折叠卡片样式
  collapsibleCard: {
    backgroundColor: Colors.bgPrimary,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    borderRadius: Radius.lg,
    borderLeftWidth: 4,
    ...Shadow.xs,
  },
  collapsibleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: Spacing.lg,
  },
  collapsibleHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    flex: 1,
  },
  collapsibleTitle: {
    ...Typography.h4,
    color: Colors.textPrimary,
    fontWeight: '700',
  },
  collapsibleContent: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.lg,
  },

  // 功能卡片内部样式
  featureEmptyState: {
    alignItems: 'center',
    paddingVertical: Spacing.lg,
  },
  featureEmptyText: {
    ...Typography.body2,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: Spacing.lg,
  },
  featureErrorText: {
    ...Typography.body2,
    color: Colors.error,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: Spacing.lg,
  },
  featureLoadingState: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.lg,
    gap: Spacing.md,
  },
  featureLoadingText: {
    ...Typography.body2,
    color: Colors.textSecondary,
  },
  featureActionBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureActionBtnDisabled: {
    opacity: 0.6,
  },
  featureActionBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.textInverse,
  },
  featureResultArea: {
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
  },
  featureResultTitle: {
    ...Typography.label,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
    fontWeight: '600',
  },
  featureResultItem: {
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  featureResultText: {
    ...Typography.body2,
    color: Colors.textPrimary,
    lineHeight: 20,
  },

  // 跨平台比价进度条样式
  crossProgressContainer: {
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  crossProgressTitle: {
    ...Typography.label,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
    fontWeight: '600',
  },
  crossProgressItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    gap: Spacing.md,
  },
  crossProgressIcon: {
    width: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  crossProgressPlatform: {
    ...Typography.body2,
    color: Colors.textPrimary,
    fontWeight: '600',
    flex: 1,
  },
  crossProgressStatus: {
    ...Typography.labelSmall,
    color: Colors.textSecondary,
  },

  // 图片展示区域样式
  imageGallerySection: {
    backgroundColor: Colors.bgPrimary,
    paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  imageGalleryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
    gap: Spacing.sm,
  },
  imageGalleryTitle: {
    ...Typography.h4,
    color: Colors.textPrimary,
    fontWeight: '600',
  },
  imageGalleryScroll: {
    paddingLeft: Spacing.lg,
  },
  imageGalleryContent: {
    paddingRight: Spacing.lg,
    gap: Spacing.md,
  },
  imageGalleryItem: {
    width: 200,
    height: 150,
    borderRadius: Radius.md,
    overflow: 'hidden',
    backgroundColor: Colors.bgSecondary,
    position: 'relative',
  },
  imageGalleryImage: {
    width: '100%',
    height: '100%',
  },
  imageGalleryIndex: {
    position: 'absolute',
    top: Spacing.sm,
    right: Spacing.sm,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  imageGalleryIndexText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
  },

  // 列表文本样式
  cleanListText: {
    ...Typography.body2,
    color: Colors.textPrimary,
    lineHeight: 20,
    flex: 1,
  },

  // 跨平台比价验证码 Modal 样式
  captchaHeader: {
    padding: Spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
    backgroundColor: Colors.bgPrimary,
  },
  captchaTitle: {
    ...Typography.h3,
    color: Colors.textPrimary,
    fontWeight: '700',
    marginBottom: Spacing.xs,
  },
  captchaSubtitle: {
    ...Typography.body2,
    color: Colors.textSecondary,
    marginBottom: Spacing.lg,
  },
  captchaActions: {
    flexDirection: 'row',
    gap: Spacing.md,
  },
  captchaBtn: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captchaBtnPrimary: {
    backgroundColor: Colors.primary,
  },
  captchaBtnSecondary: {
    backgroundColor: Colors.bgSecondary,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  captchaBtnTextPrimary: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textInverse,
  },
  captchaBtnTextSecondary: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textSecondary,
  },
});
