import { Ionicons } from '@expo/vector-icons';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput, TouchableOpacity,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { callRagLegalAnswer, isLikelyListingSearchIntent, runAgent, runAgentEngineSelfCheck, type AgentMessage, type AgentResponse } from '../lib/agent-engine';
import { onAgentEvent } from '../lib/agent-events';
import { prepareAgentListingExcludeIds } from '../lib/agent-search-context';
import { AGENT_TOOLS } from '../lib/agent-tools';
import { Colors, Radius, Spacing, Typography } from '../lib/design';
import { MarkdownView } from '../lib/markdown';
import { clearChatSessions, getChatSessions, getPrefs, upsertChatSession } from '../lib/storage';

/** 底部快捷入口：RAG 检索 + DeepSeek 结合生成建议，不凭空创造法条 */
const LEGAL_QUICK_TOPICS: { label: string; ragQuery: string }[] = [
  { label: '租房避坑', ragQuery: '租房避坑陷阱中介虚假房源看房押金合同风险租客注意事项' },
  { label: '看房清单', ragQuery: '看房现场检查清单房屋质量设施水电证件房东身份交割' },
  { label: '合同注意', ragQuery: '租赁合同条款解约违约金转租押金费用霸王条款书面合同' },
  { label: '押金维权', ragQuery: '押金退还扣押金纠纷维权证据调解诉讼民法典租赁' },
];

function isAffirmativeSearchReply(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^(确认[,，]?\s*按此找房|确认[,，]?\s*就按这个找)$/u.test(t)) return true;
  if (t.length <= 36) {
    if (/^(确认|好的|可以|行|嗯嗯|没问题|就这样|开始找|开始吧|没有补充|就这些)([。.!！…]|$)/i.test(t)) return true;
    if (/^(OK|ok)([。.!！]|$)/i.test(t)) return true;
  }
  if (/^(是|对|嗯)(的|呀)?[！!.。]?$/u.test(t)) return true;
  return false;
}

function buildDemandConfirmAssistantMessage(demand: string, cityLabel: string): string {
  const m = demand.match(/需求是[：:]\s*([^。]+)/u);
  const summary = (m?.[1] || demand).trim().replace(/\s+/g, ' ').slice(0, 220);
  return [
    '收到。我先和你对齐一下信息，再去找房源，这样不容易漏条件。',
    '',
    `当前默认城市：**${cityLabel || '偏好里设置的城市'}**`,
    `我目前理解的需求要点：${summary || '见上一条消息'}`,
    '',
    '请确认：有没有要补充或修改的？',
    '若**没有补充**，请回复「确认」或点下方「确认，按此找房」，我再开始检索并展示房源。',
  ].join('\n');
}

/** 用户明确要「下一批」时使用；长句视为改条件的新搜索，不排除历史卡片 */
function isContinueListingIntent(text: string): boolean {
  const t = text.trim();
  if (t.length > 16) return false;
  return (
    /^(继续搜索|换一批|更多房源|再看看|还有吗|下一批)/.test(t) ||
    ['继续搜索', '换一批', '更多房源', '再看看', '还有吗', '下一批'].includes(t)
  );
}

function collectAllListingCardIds(msgs: UIMessage[]): string[] {
  const set = new Set<string>();
  for (const m of msgs) {
    if (m.role !== 'assistant' || m.responseType !== 'listing_cards' || !Array.isArray(m.data)) continue;
    for (const item of m.data) {
      const id = item?.id;
      if (id != null && String(id).length > 0) set.add(String(id));
    }
  }
  return [...set];
}

/** 助手内「开始精筛」等：要走决策报告，不要对比表复述卡片 */
function isDeepRefineIntent(text: string): boolean {
  const t = text.trim();
  if (t.length > 48) return false;
  return /精筛|深度分析|决策报告|该选哪|帮我挑|帮我选|哪套更合适|哪一套/.test(t);
}

function buildListingDigestForAgent(msgs: UIMessage[]): string {
  const last = [...msgs].reverse().find(
    (m) =>
      m.role === 'assistant' &&
      m.responseType === 'listing_cards' &&
      Array.isArray(m.data) &&
      m.data.length > 0
  );
  if (!last?.data) return '';
  return (last.data as Record<string, unknown>[])
    .map((item, i) => {
      const tags = Array.isArray(item.tags) ? (item.tags as string[]).join('、') : '';
      return [
        `### 房源${i + 1}`,
        `- 标题：${item.title ?? '—'}`,
        `- 小区：${item.community ?? '—'}｜区域：${item.district ?? '—'}`,
        `- 租金：${item.price ?? '—'} 元/月｜户型：${item.roomType ?? '—'}｜面积：${item.area ?? '—'}｜楼层：${item.floor ?? '—'}`,
        `- 近地铁：${item.hasSubway ? '是' : '否'}｜租赁：${item.isWhole === false ? '合租' : '整租'}`,
        `- AI初筛：${item.aiScore ?? '—'}｜初筛点评：${item.aiComment ?? '—'}`,
        `- 标签：${tags || '—'}`,
      ].join('\n');
    })
    .join('\n\n');
}

type UIMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 用户气泡内海报/图片缩略（data URL 或 http），不入库 */
  imageUri?: string;
  responseType?: AgentResponse['type'] | 'thinking';
  data?: any;
  sources?: string[];
  quickReplies?: string[];
};

function ListingCardMessage({
  item,
  onPress,
}: {
  item: any;
  onPress: (id: string) => void;
}) {
  const thumb =
    item.imageUrl && (String(item.imageUrl).startsWith('http') || String(item.imageUrl).startsWith('data:'))
      ? String(item.imageUrl)
      : '';

  return (
    <TouchableOpacity style={s.listingCard} activeOpacity={0.8} onPress={() => onPress(String(item.id))}>
      {thumb ? (
        <Image source={{ uri: thumb }} style={s.listingThumb} resizeMode="cover" />
      ) : null}
      <Text style={s.listingTitle} numberOfLines={1}>{item.title || '未知标题'}</Text>
      <Text style={s.listingMeta}>
        {item.roomType || '-'} · {item.area || '-'} · {item.floor || '-'}
      </Text>
      <View style={s.listingDistrictRow}>
        <Ionicons name="location-outline" size={12} color={Colors.textSecondary} style={s.listingPinIcon} />
        <Text style={s.listingDistrict}>
          {item.community || '-'} · {item.district || '-'}
        </Text>
      </View>
      <View style={s.listingTagRow}>
        {Array.isArray(item.tags) ? item.tags.slice(0, 3).map((tag: string, index: number) => (
          <View key={`${item.id || item.title}-tag-${index}-${tag}`} style={s.listingTag}>
            <Text style={s.listingTagText}>{tag}</Text>
          </View>
        )) : null}
      </View>
      <View style={s.listingBottomRow}>
        <Text style={s.listingPrice}>{item.price || '-'} 元/月</Text>
        <Text style={s.listingScore}>AI {typeof item.aiScore === 'number' ? item.aiScore.toFixed(1) : '-'}</Text>
      </View>
    </TouchableOpacity>
  );
}

export default function ChatPage() {
  const router = useRouter();
  const tabBarHeight = useBottomTabBarHeight();
  const { autoMessage } = useLocalSearchParams<{ autoMessage?: string | string[] }>();
  const sessionIdRef = useRef(`session_${Date.now()}`);
  const pendingListingDemandRef = useRef<string | null>(null);
  const consumedAutoMessageRef = useRef<string>('');
  const sendMessageRef = useRef<(text?: string) => Promise<void>>(async () => {});
  
  // ★ 静默爬虫状态
  const [silentScrapeUrl, setSilentScrapeUrl] = useState<string | null>(null);
  const [silentScrapePlatform, setSilentScrapePlatform] = useState<'anjuke' | 'beike' | 'lianjia'>('anjuke');
  
  const [messages, setMessages] = useState<UIMessage[]>([
    {
      id: `init-${Date.now()}`,
      role: 'assistant',
      content: '你好！我是你的 AI 租房顾问。\n\n你可以：\n• 问我任何租房问题\n• 发送房源链接让我分析\n• 描述需求让我帮你出主意\n\n有什么可以帮你的？',
      responseType: 'text',
    },
  ]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [inputHeight, setInputHeight] = useState(40);
  const scrollRef = useRef<ScrollView>(null);
  const analyzePhotoTool = useMemo(
    () => AGENT_TOOLS.find((tool) => tool.name === 'analyze_house_photo'),
    []
  );

  useEffect(() => {
    (async () => {
      const sessions = await getChatSessions();
      setArchivedCount(sessions.length);
    })();
  }, []);

  useEffect(() => {
    const unsubscribe = onAgentEvent((event) => {
      if (event.type === 'FAVORITES_THRESHOLD') {
        const count = event.data.count;
        const proactiveMsg: UIMessage = {
          id: `evt-fav-${Date.now()}`,
          role: 'assistant',
          content: `检测到您已收藏 ${count} 套房源，是否需要我为您生成综合对比分析报告？`,
          responseType: 'text',
          quickReplies: ['生成报告', '稍后再说'],
        };
        setMessages((prev) => [...prev, proactiveMsg]);
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
      } else if (event.type === 'FOLDER_THRESHOLD_REACHED') {
        const eventData = event.data as { folderId: string; folderName: string; count: number };
        const { folderId, folderName, count } = eventData;
        
        console.log('[Chat] FOLDER_THRESHOLD_REACHED event received:', { folderId, folderName, count });
        
        // 显示通知提示用户
        Alert.alert(
          '🤖 AI 智能推荐',
          `正在根据「${folderName}」收藏记录智能推荐相似房源...`,
          [{ text: '好的', style: 'default' }],
          { cancelable: true }
        );
        
        // 直接调用工具，不依赖 Agent 推理
        (async () => {
          const userMsg: UIMessage = {
            id: `u-auto-${Date.now()}`,
            role: 'user',
            content: `📁 收藏夹「${folderName}」已达到 ${count} 套房源`,
          };
          setMessages((prev) => [...prev, userMsg]);
          setLoading(true);
          
          try {
            // 1. 分析收藏夹偏好
            const analyzeTool = AGENT_TOOLS.find(t => t.name === 'analyze_folder_preferences');
            const searchTool = AGENT_TOOLS.find(t => t.name === 'search_by_folder_preferences');
            
            if (!analyzeTool || !searchTool) {
              throw new Error('推荐工具不可用');
            }
            
            console.log('[Chat] Calling analyze_folder_preferences with folderId:', folderId);
            const analysisResult: any = await analyzeTool.execute({ folderId });
            
            console.log('[Chat] Analysis result:', JSON.stringify(analysisResult).substring(0, 500));
            
            if (!analysisResult.success) {
              console.error('[Chat] Analysis failed:', analysisResult.error);
              throw new Error(analysisResult.error || '偏好分析失败');
            }
            
            console.log('[Chat] Analysis success:', {
              priceRange: analysisResult.priceRange,
              topDistricts: analysisResult.topDistricts?.length,
              topRoomTypes: analysisResult.topRoomTypes?.length,
              features: analysisResult.features,
            });
            
            // 1.5. 触发静默爬虫（基于偏好）
            try {
              const prefs = await getPrefs();
              const { buildAnjukeUrl, getCitySlug } = require('../lib/webview-scraper');
              const citySlug = getCitySlug(prefs.city, 'anjuke');
              
              const filters = {
                budgetMin: analysisResult.priceRange?.avg > 0 
                  ? String(Math.round(analysisResult.priceRange.avg * 0.8))
                  : undefined,
                budgetMax: analysisResult.priceRange?.avg > 0
                  ? String(Math.round(analysisResult.priceRange.avg * 1.2))
                  : undefined,
              };
              
              const scrapeUrl = buildAnjukeUrl(citySlug, 1, filters);
              console.log('[Chat] Triggering silent scrape:', scrapeUrl);
              
              setSilentScrapeUrl(scrapeUrl);
              setSilentScrapePlatform('anjuke');
              
              // 等待爬虫完成（缩短到5秒，避免用户等待过久）
              await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (scrapeError: any) {
              console.warn('[Chat] Failed to prepare scrape:', scrapeError);
              // 爬虫失败不影响推荐流程
            }
            
            // 2. 基于偏好搜索房源（包含新抓取的）
            console.log('[Chat] Calling search_by_folder_preferences with folderId:', folderId);
            const searchResult: any = await searchTool.execute({ folderId });
            
            const listings = Array.isArray(searchResult.listings) ? searchResult.listings : [];
            console.log('[Chat] Search result:', {
              found: listings.length,
              total: searchResult.total,
              searchParams: searchResult.searchParams,
            });
            
            // 3. 构造简洁的推荐消息
            let content = `根据您在「${folderName}」中收藏的 ${count} 套房源，我为您推荐以下相似房源：\n\n`;
            
            if (listings.length === 0) {
              content = `已分析「${folderName}」中的 ${count} 套房源偏好，但暂未找到更多符合条件的房源。建议：\n\n• 在「找房」页面抓取更多房源\n• 调整筛选条件扩大搜索范围`;
            } else {
              // 简要说明推荐依据
              const { priceRange, topDistricts, features } = analysisResult;
              const hints: string[] = [];
              
              if (priceRange?.avg > 0) {
                hints.push(`价格在 ${Math.round(priceRange.avg * 0.8)}-${Math.round(priceRange.avg * 1.2)} 元`);
              }
              if (topDistricts?.length > 0) {
                hints.push(`${topDistricts[0].district}附近`);
              }
              if (features?.subwayRatio >= 50) {
                hints.push('近地铁');
              }
              
              if (hints.length > 0) {
                content += `💡 推荐依据：${hints.join('、')}\n`;
              }
            }
            
            const assistantMsg: UIMessage = {
              id: `a-folder-${Date.now()}`,
              role: 'assistant',
              content,
              responseType: listings.length > 0 ? 'listing_cards' : 'text',
              data: listings,
            };
            
            setMessages((prev) => [...prev, assistantMsg]);
            
            // 如果有推荐房源，添加后续引导
            if (listings.length > 0) {
              const guideMsg: UIMessage = {
                id: `guide-folder-${Date.now()}`,
                role: 'assistant',
                content: '点击房源卡片查看详情，或告诉我你的想法。',
                responseType: 'text',
                quickReplies: ['继续推荐', '分析这几套'],
              };
              setMessages((prev) => [...prev, guideMsg]);
            }
            
            // 持久化会话
            await persistSession([...messages, userMsg, assistantMsg]);
            
          } catch (error: any) {
            console.error('[Chat] Folder recommendation failed:', error);
            console.error('[Chat] Error stack:', error.stack);
            const errorMsg: UIMessage = {
              id: `e-folder-${Date.now()}`,
              role: 'assistant',
              content: `推荐失败：${error?.message || '未知错误'}。请稍后重试或手动在「找房」页面搜索。`,
              responseType: 'text',
            };
            setMessages((prev) => [...prev, errorMsg]);
            await persistSession([...messages, userMsg, errorMsg]);
          } finally {
            setLoading(false);
            setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
          }
        })();
        
        // Show notification if user is not on chat screen (background processing)
        import('../lib/notification-state').then(({ notificationState }) => {
          notificationState.showNotification({
            id: `folder-${event.ts}`,
            message: `AI 正在为您分析「${folderName}」收藏夹的偏好并推荐房源`,
            timestamp: event.ts,
            folderName,
          });
        }).catch(() => {
          // Silently fail if notification system is not available
        });
      }
    });

    return unsubscribe;
  }, []);
  
  // Dismiss notification when loading completes
  useEffect(() => {
    if (!loading) {
      // Dismiss notification after Agent completes processing
      import('../lib/notification-state').then(({ notificationState }) => {
        setTimeout(() => {
          notificationState.dismissNotification();
        }, 2000);
      }).catch(() => {
        // Silently fail
      });
    }
  }, [loading]);

  useEffect(() => {
    const showListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => {
        setKeyboardHeight(e.endCoordinates.height);
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120);
      }
    );
    const hideListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardHeight(0);
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120);
      }
    );
    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length, loading]);

  async function persistSession(nextMessages: { role: 'user' | 'assistant'; content: string }[]) {
    const plainMessages = nextMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-80)
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const firstUser = plainMessages.find(m => m.role === 'user');
    const topic = firstUser?.content?.slice(0, 24) || '新话题';

    await upsertChatSession({
      id: sessionIdRef.current,
      topic,
      messages: plainMessages,
      updatedAt: new Date().toISOString(),
    });
    const sessions = await getChatSessions();
    setArchivedCount(sessions.length);
  }

  async function sendQuickLegalFromKb(label: string, ragQuery: string) {
    if (loading) return;
    setInput('');
    const userMsg: UIMessage = { id: `u-${Date.now()}`, role: 'user', content: label };
    const base = [...messages, userMsg];
    setMessages(base);
    setLoading(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    try {
      const response = await callRagLegalAnswer(label, ragQuery);
      const assistantMsg: UIMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: response.content,
        responseType: 'legal_answer',
        data: response.data,
        sources: response.sources,
      };
      const finalMessages = [...base, assistantMsg];
      setMessages(finalMessages);
      await persistSession(finalMessages);
    } catch (error: any) {
      const errMsg: UIMessage = {
        id: `e-${Date.now()}`,
        role: 'assistant',
        content: `分析失败：${error?.message || '未知错误'}，请稍后重试`,
        responseType: 'text',
      };
      const finalMessages = [...base, errMsg];
      setMessages(finalMessages);
      await persistSession(finalMessages);
    } finally {
      setLoading(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }

  function toConversationHistory(msgs: { role: 'user' | 'assistant'; content: string }[]): AgentMessage[] {
    return msgs
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));
  }

  async function sendMessage(text?: string) {
    const msg = text || input.trim();
    if (!msg || loading) return;
    setInput('');

    const userMsg: UIMessage = { id: `u-${Date.now()}`, role: 'user', content: msg };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setLoading(true);

    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

    try {
      const prefs = await getPrefs();

      if (isContinueListingIntent(msg)) {
        prepareAgentListingExcludeIds(collectAllListingCardIds(messages));
      } else {
        prepareAgentListingExcludeIds(null);
      }

      if (msg.trim() === '我再改改') {
        pendingListingDemandRef.current = null;
        const guideMsg: UIMessage = {
          id: `guide-edit-${Date.now()}`,
          role: 'assistant',
          content: '好的。请在下一条消息里直接写出更新后的找房条件（一段话即可）。',
          responseType: 'text',
        };
        const finalMsgs = [...newMessages, guideMsg];
        setMessages(finalMsgs);
        await persistSession(finalMsgs);
        return;
      }

      if (!pendingListingDemandRef.current && isAffirmativeSearchReply(msg) && !isLikelyListingSearchIntent(msg)) {
        const hintMsg: UIMessage = {
          id: `hint-${Date.now()}`,
          role: 'assistant',
          content: '请先发一条具体的找房需求（预算、户型、区域、地铁等），或从找房页用「交给 AI」把筛选条件带过来。',
          responseType: 'text',
        };
        const finalMsgs = [...newMessages, hintMsg];
        setMessages(finalMsgs);
        await persistSession(finalMsgs);
        return;
      }

      const awaitingSupplement =
        pendingListingDemandRef.current != null &&
        isLikelyListingSearchIntent(msg) &&
        !isAffirmativeSearchReply(msg) &&
        !isContinueListingIntent(msg) &&
        msg.trim().length > 4;

      const needFirstGate =
        pendingListingDemandRef.current === null &&
        isLikelyListingSearchIntent(msg) &&
        !isContinueListingIntent(msg) &&
        !isAffirmativeSearchReply(msg);

      if (needFirstGate || awaitingSupplement) {
        if (awaitingSupplement && pendingListingDemandRef.current) {
          pendingListingDemandRef.current = `${pendingListingDemandRef.current}\n补充说明：${msg}`;
        } else {
          pendingListingDemandRef.current = msg;
        }
        const demandSnapshot = pendingListingDemandRef.current || msg;
        const confirmMsg: UIMessage = {
          id: `confirm-${Date.now()}`,
          role: 'assistant',
          content: buildDemandConfirmAssistantMessage(demandSnapshot, prefs.cityLabel),
          responseType: 'text',
          quickReplies: ['确认，按此找房', '我再改改'],
        };
        const finalMsgs = [...newMessages, confirmMsg];
        setMessages(finalMsgs);
        await persistSession(finalMsgs);
        return;
      }

      let agentInput = msg;
      if (pendingListingDemandRef.current && isAffirmativeSearchReply(msg)) {
        const stored = pendingListingDemandRef.current;
        pendingListingDemandRef.current = null;
        agentInput = `${stored}\n\n用户已确认以上找房需求无补充，请据此立即检索并推荐合适房源。`;
      }
      if (isDeepRefineIntent(msg)) {
        const digest = buildListingDigestForAgent(newMessages);
        if (digest) {
          agentInput = `${agentInput}\n\n【以下为助手刚推荐给您的房源结构化摘要。请据此写精筛决策报告：只可引用事实作论据，禁止再用表格重复罗列价格/面积/地铁/初筛分等已在卡片上展示过的字段。】\n${digest}`;
        }
      }
      const response = await runAgent(agentInput, toConversationHistory(messages));
      console.log('[Chat] runAgent returned:', response.type, Array.isArray(response.data), response.data?.length);
      const reply: UIMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: response.content,
        responseType: response.type,
        data: response.data,
        sources: response.sources,
      };
      const finalMessages = [...newMessages, reply];
      if (response.type === 'listing_cards') {
        finalMessages.push({
          id: `guide-${Date.now()}`,
          role: 'assistant',
          responseType: 'text',
          content: '需要我继续搜索更多房源，还是基于上面几套帮你做一份精筛决策报告？',
          quickReplies: ['继续搜索', '开始精筛'],
        });
      }
      setMessages(finalMessages);
      await persistSession(finalMessages);
    } catch (error: any) {
      const errorReply: UIMessage = {
        id: `e-${Date.now()}`,
        role: 'assistant',
        content: `抱歉，我暂时无法回答这个问题：${error.message}`,
        responseType: 'text',
      };
      const finalMessages = [...newMessages, errorReply];
      setMessages(finalMessages);
      await persistSession(finalMessages);
    } finally {
      setLoading(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }

  // ★ 修复：使用 useEffect 确保 sendMessageRef 在事件监听器注册后更新
  useEffect(() => {
    sendMessageRef.current = sendMessage;
  });

  useEffect(() => {
    const raw = Array.isArray(autoMessage) ? autoMessage[0] : autoMessage;
    const msg = typeof raw === 'string' ? raw.trim() : '';
    if (!msg) return;
    if (consumedAutoMessageRef.current === msg) return;
    if (loading) return;
    consumedAutoMessageRef.current = msg;
    sendMessageRef.current(msg);
  }, [autoMessage, loading]);

  function handlePickImage() {
    if (loading) return;

    const showTypePicker = () => {
      Alert.alert(
        '选择图片类型',
        '请选择要上传的图片类型：',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '房源海报（分享图）',
            onPress: () => {
              void pickAndProcessImage('poster');
            },
          },
          {
            text: '房屋照片（环境图）',
            onPress: () => {
              void pickAndProcessImage('photo');
            },
          },
        ],
        { cancelable: true },
      );
    };

    const showPrivacy = () => {
      Alert.alert(
        '相册与隐私说明',
        '仅在您主动选择图片时申请相册访问权限，用于：\n\n• 识别房源分享海报中的信息\n• 分析房屋环境照片\n\n图片仅用于上述功能，不会用于与租房无关的用途。',
        [
          { text: '暂不使用', style: 'cancel' },
          {
            text: '同意并继续',
            onPress: () => {
              if (Platform.OS === 'android') {
                setTimeout(showTypePicker, 100);
              } else {
                InteractionManager.runAfterInteractions(showTypePicker);
              }
            },
          },
        ],
        { cancelable: true },
      );
    };

    // Android 上紧跟触摸弹 Alert 有时不显示，延后一帧；iOS 在交互结束后再弹更稳
    if (Platform.OS === 'android') {
      setTimeout(showPrivacy, 80);
    } else {
      InteractionManager.runAfterInteractions(() => showPrivacy());
    }
  }

  async function pickAndProcessImage(imageType: 'poster' | 'photo') {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('提示', '未授予相册权限，无法选择图片');
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      base64: true,
      allowsEditing: false,
    });

    if (!picked.canceled && picked.assets[0]?.base64) {
      const base64 = picked.assets[0].base64;
      const mimeType = picked.assets[0].mimeType || 'image/jpeg';
      
      console.log('[chat] 图片选择成功:', {
        type: imageType,
        mimeType,
        base64Length: base64.length,
        width: picked.assets[0].width,
        height: picked.assets[0].height,
      });
      
      if (imageType === 'poster') {
        await handlePosterExtraction(base64, mimeType);
      } else {
        await runPhotoAnalysisWithTool(base64, mimeType);
      }
    }
  }

  // ★ 新增：海报信息提取
  async function handlePosterExtraction(base64: string, mimeType = 'image/jpeg') {
    const extractPosterTool = AGENT_TOOLS.find(t => t.name === 'extract_listing_from_poster');
    if (!extractPosterTool) {
      Alert.alert('提示', '海报识别功能不可用，请稍后重试');
      return;
    }

    const dataUrl = `data:${mimeType};base64,${base64}`;
    const userMsg: UIMessage = {
      id: `u-poster-${Date.now()}`,
      role: 'user',
      content: '📋 已上传房源分享海报，请帮我提取房源信息',
      imageUri: dataUrl,
    };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setLoading(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);

    try {
      const toolResult: any = await extractPosterTool.execute({
        imageBase64: dataUrl,
      });

      if (toolResult?.success && toolResult?.listing) {
        const listing = {
          ...(toolResult.listing as Record<string, unknown>),
          imageUrl: dataUrl,
        };
        const reply: UIMessage = {
          id: `a-poster-${Date.now()}`,
          role: 'assistant',
          content: '已从海报中提取房源信息，点击下方卡片查看详情：',
          responseType: 'listing_cards',
          data: [listing],
        };
        const finalMessages = [...nextMessages, reply];
        setMessages(finalMessages);
        await persistSession(finalMessages);
      } else {
        const errReply: UIMessage = {
          id: `e-poster-${Date.now()}`,
          role: 'assistant',
          content: `海报识别失败：${toolResult?.error || '无法提取房源信息'}`,
          responseType: 'text',
        };
        const finalMessages = [...nextMessages, errReply];
        setMessages(finalMessages);
        await persistSession(finalMessages);
      }
    } catch (error: any) {
      const errReply: UIMessage = {
        id: `e-poster-${Date.now()}`,
        role: 'assistant',
        content: `海报识别失败：${error?.message || '未知错误'}`,
        responseType: 'text',
      };
      const finalMessages = [...nextMessages, errReply];
      setMessages(finalMessages);
      await persistSession(finalMessages);
    } finally {
      setLoading(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }

  async function runPhotoAnalysisWithTool(base64: string, mimeType = 'image/jpeg') {
    if (!analyzePhotoTool) {
      Alert.alert('提示', '图片分析工具不可用，请稍后重试');
      return;
    }

    const dataUrl = `data:${mimeType};base64,${base64}`;
    const userMsg: UIMessage = {
      id: `u-img-${Date.now()}`,
      role: 'user',
      content: '📷 已上传房屋环境照片，请帮我分析',
      imageUri: dataUrl,
    };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setLoading(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);

    try {
      const toolResult = await analyzePhotoTool.execute({
        imageUrl: dataUrl,
        listingId: `img-${Date.now()}`,
      });
      
      // 检查是否成功
      if (!(toolResult as any)?.success) {
        const errorMsg = (toolResult as any)?.error || '图片分析失败';
        const errReply: UIMessage = {
          id: `e-img-${Date.now()}`,
          role: 'assistant',
          content: `❌ ${errorMsg}`,
          responseType: 'text',
        };
        const finalMessages = [...nextMessages, errReply];
        setMessages(finalMessages);
        await persistSession(finalMessages);
        return;
      }
      
      const findings = Array.isArray((toolResult as any)?.findings)
        ? (toolResult as any).findings
        : [];
      const score = (toolResult as any)?.score;
      const summary = (toolResult as any)?.summary || '';
      const highlights = Array.isArray((toolResult as any)?.highlights)
        ? (toolResult as any).highlights
        : [];
      const risks = Array.isArray((toolResult as any)?.risks)
        ? (toolResult as any).risks
        : [];
      
      // 构建回复文本
      let replyText = '✅ 已完成图片分析：\n\n';
      
      // 综合评分
      if (typeof score === 'number') {
        replyText += `📊 **综合评分**：${score.toFixed(1)} / 10\n\n`;
      }
      
      // 主要发现
      if (findings.length > 0) {
        replyText += '**主要发现**：\n';
        findings.forEach((f: string, i: number) => {
          replyText += `${i + 1}. ${f}\n`;
        });
        replyText += '\n';
      }
      
      // 亮点
      if (highlights.length > 0) {
        replyText += '✨ **亮点**：\n';
        highlights.forEach((h: string) => {
          replyText += `• ${h}\n`;
        });
        replyText += '\n';
      }
      
      // 风险点
      if (risks.length > 0) {
        replyText += '⚠️ **需要注意**：\n';
        risks.forEach((r: string) => {
          replyText += `• ${r}\n`;
        });
        replyText += '\n';
      }
      
      // 总结
      if (summary) {
        replyText += `💡 **总结**：${summary}`;
      }

      const reply: UIMessage = {
        id: `a-img-${Date.now()}`,
        role: 'assistant',
        content: replyText.trim(),
        responseType: 'text',
        data: toolResult,
      };
      const finalMessages = [...nextMessages, reply];
      setMessages(finalMessages);
      await persistSession(finalMessages);
    } catch (error: any) {
      const errReply: UIMessage = {
        id: `e-img-${Date.now()}`,
        role: 'assistant',
        content: `❌ 图片分析失败：${error?.message || '未知错误'}`,
        responseType: 'text',
      };
      const finalMessages = [...nextMessages, errReply];
      setMessages(finalMessages);
      await persistSession(finalMessages);
    } finally {
      setLoading(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerTitles}>
          <View style={s.headerTitleRow}>
            <Ionicons name="chatbubbles-outline" size={20} color={Colors.textPrimary} style={s.headerLeadIcon} />
            <Text style={s.headerTitle}>AI 租房助手</Text>
          </View>
          <Text style={s.headerSub}>有问必答，有坑必防（历史会话已保存 {archivedCount} 条）</Text>
        </View>
        <TouchableOpacity
          style={s.clearCacheBtn}
          onPress={() =>
            Alert.alert('确认清除', '确定清除 AI 助手的全部对话缓存吗？', [
              { text: '取消', style: 'cancel' },
              {
                text: '清除',
                style: 'destructive',
                onPress: async () => {
                  await clearChatSessions();
                  await runAgentEngineSelfCheck();
                  setArchivedCount(0);
                  const freshMessages: UIMessage[] = [{
                    id: `init-${Date.now()}`,
                    role: 'assistant',
                    content: '你好！我是你的 AI 租房顾问。\n\n你可以：\n• 问我任何租房问题\n• 发送房源链接让我分析\n• 描述需求让我帮你出主意\n\n有什么可以帮你的？',
                    responseType: 'text',
                  }];
                  setMessages(freshMessages);
                  sessionIdRef.current = `session_${Date.now()}`;
                  pendingListingDemandRef.current = null;
                },
              },
            ])
          }
        >
          <Text style={s.clearCacheBtnText}>清除缓存</Text>
        </TouchableOpacity>
      </View>

      {Platform.OS === 'ios' ? (
        <KeyboardAvoidingView
          style={s.flexFill}
          behavior="padding"
          keyboardVerticalOffset={tabBarHeight}
        >
          <ChatBody
            scrollRef={scrollRef}
            messages={messages}
            loading={loading}
            router={router}
            input={input}
            setInput={setInput}
            inputHeight={inputHeight}
            setInputHeight={setInputHeight}
            sendMessage={sendMessage}
            handlePickImage={handlePickImage}
            loadingDisabled={loading}
            onQuickLegal={sendQuickLegalFromKb}
          />
        </KeyboardAvoidingView>
      ) : (
        <ChatBody
          scrollRef={scrollRef}
          messages={messages}
          loading={loading}
          router={router}
          input={input}
          setInput={setInput}
          inputHeight={inputHeight}
          setInputHeight={setInputHeight}
          sendMessage={sendMessage}
          handlePickImage={handlePickImage}
          loadingDisabled={loading}
          onQuickLegal={sendQuickLegalFromKb}
        />
      )}
      
      {/* ★ 静默爬虫 WebView */}
      {silentScrapeUrl ? (
        <View style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
          {(() => {
            const { BackgroundWebView } = require('../components/BackgroundWebView');
            return (
              <BackgroundWebView
                url={silentScrapeUrl}
                platform={silentScrapePlatform}
                timeout={15000}
                onExtracted={async (result: any) => {
                  console.log('[Chat] Silent scrape completed:', result.count, 'listings');
                  if (result.success && result.listings?.length > 0) {
                    const { processScrapeResult } = require('../lib/silent-scraper');
                    const prefs = await getPrefs();
                    const saved = await processScrapeResult(result, prefs.city);
                    console.log('[Chat] Saved', saved, 'new listings');
                  }
                  setSilentScrapeUrl(null);
                }}
                onError={(error: string) => {
                  console.warn('[Chat] Silent scrape failed:', error);
                  setSilentScrapeUrl(null);
                }}
                onCaptchaDetected={() => {
                  console.warn('[Chat] CAPTCHA detected, skipping scrape');
                  setSilentScrapeUrl(null);
                }}
              />
            );
          })()}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

type ChatBodyProps = {
  scrollRef: RefObject<ScrollView | null>;
  messages: UIMessage[];
  loading: boolean;
  router: ReturnType<typeof useRouter>;
  input: string;
  setInput: (v: string) => void;
  inputHeight: number;
  setInputHeight: (v: number) => void;
  sendMessage: (text?: string) => Promise<void>;
  handlePickImage: () => void;
  loadingDisabled: boolean;
  onQuickLegal: (label: string, ragQuery: string) => void;
};

function ChatBody({
  scrollRef,
  messages,
  loading,
  router,
  input,
  setInput,
  inputHeight,
  setInputHeight,
  sendMessage,
  handlePickImage,
  loadingDisabled,
  onQuickLegal,
}: ChatBodyProps) {
  return (
    <View style={s.flexFill}>
      <ScrollView
        ref={scrollRef}
        style={s.msgList}
        contentContainerStyle={s.msgListContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
          {messages.map((m) => (
            <View key={m.id} style={[s.bubble, m.role === 'user' ? s.bubbleUser : s.bubbleAI]}>
              {m.role === 'assistant' && (
                <View style={s.bubbleAvatarWrap}>
                  <Ionicons name="sparkles-outline" size={18} color={Colors.primary} />
                </View>
              )}
              <View style={[s.bubbleContent, m.role === 'user' ? s.bubbleContentUser : s.bubbleContentAI]}>
                {m.role === 'assistant' ? (
                  <>
                    <MarkdownView content={m.content} />
                    {m.responseType === 'legal_answer' && m.sources?.length ? (
                      <View style={s.sourcesRow}>
                        <Ionicons name="book-outline" size={12} color={Colors.textTertiary} />
                        <Text style={s.sourcesText}>参考来源：[{m.sources.join('] [')}]</Text>
                      </View>
                    ) : null}
                    {m.responseType === 'listing_cards' && Array.isArray(m.data) && m.data.length > 0 ? (
                      <View style={s.listingCardsWrap}>
                        {m.data.map((item: any) => (
                          <ListingCardMessage
                            key={item.id || item.title}
                            item={item}
                            onPress={(id) => router.push(`/listing/${id}`)}
                          />
                        ))}
                      </View>
                    ) : null}
                    {m.responseType === 'compare_report' && m.data ? (
                      <View style={s.compareCard}>
                        <View style={s.compareTitleRow}>
                          <Ionicons name="bar-chart-outline" size={14} color={Colors.primary} />
                          <Text style={s.compareTitle}>对比报告</Text>
                        </View>
                        <Text style={s.compareText}>
                          {m.data.summary || m.data.recommendation || '已生成对比报告'}
                        </Text>
                        {Array.isArray(m.data.riskTips) && m.data.riskTips.length ? (
                          <Text style={s.compareRisk}>
                            风险提示：{m.data.riskTips.join('；')}
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
                    {m.quickReplies?.length ? (
                      <View style={s.quickReplyRow}>
                        {m.quickReplies.map((reply) => (
                          <TouchableOpacity
                            key={reply}
                            style={s.quickReplyBtn}
                            onPress={() => sendMessage(reply)}
                            disabled={loadingDisabled}
                          >
                            <Text style={s.quickReplyBtnText}>{reply}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    ) : null}
                  </>
                ) : (
                  <View>
                    {m.imageUri ? (
                      <Image source={{ uri: m.imageUri }} style={s.userImageThumb} resizeMode="cover" />
                    ) : null}
                    <Text style={[s.bubbleText, s.bubbleTextUser]}>
                      {m.content}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          ))}
          {loading && (
            <View style={[s.bubble, s.bubbleAI]}>
              <View style={s.bubbleAvatarWrap}>
                <Ionicons name="sparkles-outline" size={18} color={Colors.primary} />
              </View>
              <View style={[s.bubbleContent, s.bubbleContentAI, s.thinkingBubble]}>
                <ActivityIndicator color={Colors.primary} size="small" />
                <Text style={s.thinkingText}>正在思考...</Text>
              </View>
            </View>
          )}
        </ScrollView>

      <View style={s.inputSection}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.legalQuickScroll}
        contentContainerStyle={s.legalQuickScrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {LEGAL_QUICK_TOPICS.map((t, i) => (
          <TouchableOpacity
            key={t.label}
            style={[s.legalQuickBtn, i === LEGAL_QUICK_TOPICS.length - 1 && s.legalQuickBtnLast]}
            onPress={() => onQuickLegal(t.label, t.ragQuery)}
            disabled={loadingDisabled}
            accessibilityRole="button"
            accessibilityLabel={t.label}
          >
            <Text style={s.legalQuickBtnText} numberOfLines={1}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={s.inputBar}>
        <TouchableOpacity
          style={s.photoBtn}
          onPress={handlePickImage}
          disabled={loadingDisabled}
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
          accessibilityLabel="上传图片"
        >
          <Ionicons name="camera-outline" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <TextInput
          style={[s.input, { height: Math.min(Math.max(inputHeight, 40), 120) }]}
          placeholder="输入问题，或粘贴房源链接..."
          placeholderTextColor="#bbb"
          value={input}
          onChangeText={setInput}
          onContentSizeChange={(e) => {
            const h = e.nativeEvent.contentSize.height || 0;
            if (h > 0) setInputHeight(h);
          }}
          onSubmitEditing={() => sendMessage()}
          onFocus={() => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150)}
          returnKeyType="send"
          multiline
          maxLength={2000}
          textAlignVertical="top"
        />
        <TouchableOpacity
          style={[s.sendBtn, (!input.trim() || loadingDisabled) && s.sendBtnDis]}
          onPress={() => sendMessage()}
          disabled={!input.trim() || loadingDisabled}
        >
          <Ionicons name="arrow-up" size={22} color={Colors.textInverse} />
        </TouchableOpacity>
      </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  flexFill: { flex: 1 },
  safe: { flex: 1, backgroundColor: Colors.bgSecondary },

  header: {
    backgroundColor: Colors.bgPrimary,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitles: { flex: 1, minWidth: 0, marginRight: Spacing.sm },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center' },
  headerLeadIcon: { marginRight: Spacing.xs },
  headerTitle: { ...Typography.h3, color: Colors.textPrimary },
  headerSub: { ...Typography.labelSmall, color: Colors.textTertiary, marginTop: 2 },
  clearCacheBtn: {
    borderWidth: 1,
    borderColor: '#ffd9d9',
    backgroundColor: '#fff5f5',
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  clearCacheBtnText: { fontSize: 12, color: Colors.error, fontWeight: '600' },

  msgList: { flex: 1, paddingHorizontal: Spacing.sm },
  msgListContent: {
    flexGrow: 1,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
  },
  inputSection: {
    backgroundColor: Colors.bgPrimary,
    borderTopWidth: 1,
    borderTopColor: Colors.divider,
  },

  bubble: { flexDirection: 'row', marginBottom: Spacing.md, maxWidth: '90%' },
  bubbleAI: { alignSelf: 'flex-start' },
  bubbleUser: { alignSelf: 'flex-end' },
  bubbleAvatarWrap: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: Spacing.xs,
    marginRight: Spacing.sm,
  },
  bubbleContent: { borderRadius: Radius.lg, padding: Spacing.md, maxWidth: '85%' },
  bubbleContentAI: { backgroundColor: Colors.bgPrimary },
  bubbleContentUser: { backgroundColor: Colors.primary },
  bubbleText: { ...Typography.body1, color: Colors.textPrimary },
  bubbleTextUser: { color: Colors.textInverse },
  userImageThumb: {
    width: 200,
    maxWidth: '100%',
    height: 140,
    borderRadius: Radius.lg,
    marginBottom: Spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  sourcesRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.xs,
    marginTop: Spacing.md,
  },
  sourcesText: { ...Typography.labelSmall, color: Colors.textTertiary, flex: 1 },
  listingCardsWrap: { marginTop: Spacing.md, gap: Spacing.md },
  listingCard: {
    borderWidth: 1,
    borderColor: Colors.divider,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    backgroundColor: Colors.bgTertiary,
    overflow: 'hidden',
  },
  listingThumb: { width: '100%', height: 96, borderRadius: Radius.md, marginBottom: Spacing.md, backgroundColor: '#eee' },
  listingTitle: { ...Typography.h4, color: Colors.textPrimary },
  listingMeta: { ...Typography.label, color: Colors.textSecondary, marginTop: Spacing.xs },
  listingDistrictRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Spacing.xs,
  },
  listingPinIcon: { marginRight: 4 },
  listingDistrict: { ...Typography.label, color: Colors.textSecondary, flex: 1 },
  listingTagRow: { flexDirection: 'row', gap: Spacing.xs, marginTop: Spacing.xs },
  listingTag: {
    paddingHorizontal: Spacing.xs,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    backgroundColor: Colors.primaryLight,
    borderWidth: 1,
    borderColor: '#cfe7d9',
  },
  listingTagText: { fontSize: 10, color: Colors.primary, fontWeight: '600' },
  listingBottomRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.md, alignItems: 'center' },
  listingPrice: { fontSize: 14, color: '#fe5500', fontWeight: '700', marginTop: Spacing.xs },
  listingScore: { fontSize: 11, color: Colors.primary, fontWeight: '700' },
  compareCard: {
    marginTop: Spacing.md,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    backgroundColor: Colors.primaryLight,
    borderWidth: 1,
    borderColor: '#d7efe3',
  },
  compareTitleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  compareTitle: { ...Typography.h4, color: Colors.primary },
  compareText: { ...Typography.body2, color: Colors.textPrimary, marginTop: Spacing.xs },
  compareRisk: { fontSize: 11, color: Colors.warning, marginTop: Spacing.xs, lineHeight: 16 },
  quickReplyRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.lg },
  quickReplyBtn: {
    borderWidth: 1,
    borderColor: '#cfe7d9',
    backgroundColor: Colors.primaryLight,
    borderRadius: 14,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  quickReplyBtnText: { fontSize: 12, color: Colors.primary, fontWeight: '600' },

  legalQuickScroll: {
    flexGrow: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.divider,
    backgroundColor: Colors.bgPrimary,
  },
  legalQuickScrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.md,
  },
  legalQuickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor: Colors.bgSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.divider,
    flexShrink: 0,
  },
  legalQuickBtnLast: {
    marginRight: 0,
  },
  legalQuickBtnText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '500' },

  kbOnlyNote: {
    marginTop: Spacing.sm,
    paddingVertical: Spacing.xs,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.sm,
    backgroundColor: '#f5f7fa',
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  kbOnlyNoteText: { fontSize: 11, color: Colors.textTertiary, lineHeight: 16 },

  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: Spacing.md,
    gap: Spacing.md,
    backgroundColor: Colors.bgPrimary,
    borderTopWidth: 1,
    borderTopColor: Colors.divider,
  },
  photoBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.bgSecondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  input: {
    flex: 1,
    minWidth: 0,
    backgroundColor: Colors.bgSecondary,
    borderRadius: 20,
    paddingHorizontal: Spacing.lg,
    paddingTop: 10,
    paddingBottom: 10,
    ...Typography.body1,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDis: { backgroundColor: Colors.textTertiary },
  
  thinkingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  thinkingText: {
    ...Typography.body2,
    color: Colors.textSecondary,
    fontStyle: 'italic',
  },
});
