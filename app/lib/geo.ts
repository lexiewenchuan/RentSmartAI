import { getApiConfig, type CommuteRouteMode } from './storage';

export type CommuteResult = {
  distance: string;
  duration: string;
  success: boolean;
  errorReason?: string; // 失败原因诊断
  routeMode?: CommuteRouteMode;
  routeModeLabel?: string;
};

type Coord = { lng: number; lat: number };

// ★ 高德地图 QPS 限流队列（每秒最多3次请求，安全起见设置为400ms间隔）
type QueuedRequest = {
  fn: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (error: any) => void;
};

class AmapRequestQueue {
  private queue: QueuedRequest[] = [];
  private processing = false;
  private readonly INTERVAL_MS = 500; // 每次请求间隔500ms，确保不超过每秒2次（更安全的限流）

  async enqueue<T>(fn: () => Promise<T>, retryCount = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  private async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      if (!request) break;
      
      try {
        const result = await request.fn();
        request.resolve(result);
      } catch (error) {
        request.reject(error);
      }
      
      // 等待间隔时间再处理下一个请求
      if (this.queue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, this.INTERVAL_MS));
      }
    }
    
    this.processing = false;
  }
}

const amapQueue = new AmapRequestQueue();

// 城市代码到城市名映射（用于高德地理编码的city参数）
const CITY_CODE_MAP: Record<string, string> = {
  bj: '北京',
  sh: '上海',
  gz: '广州',
  sz: '深圳',
  wh: '武汉',
  cd: '成都',
  cq: '重庆',
  hz: '杭州',
  nj: '南京',
  xm: '厦门',
};

// 清理和优化地址字符串
function cleanAddress(rawAddress: string): string {
  let addr = rawAddress.trim();
  
  // 移除多余的空格和特殊字符
  addr = addr.replace(/\s+/g, ' ');
  
  // 移除价格信息（如 "4500元"）
  addr = addr.replace(/\d+元/g, '');
  
  // 移除房型信息（如 "2室1厅"、"1房"）
  addr = addr.replace(/\d室\d厅/g, '');
  addr = addr.replace(/\d室/g, '');
  addr = addr.replace(/\d房/g, '');
  addr = addr.replace(/一室一厅|两室一厅|三室一厅|一居|两居|三居|四居/g, '');
  
  // 移除面积信息
  addr = addr.replace(/\d+(?:\.\d+)?(?:㎡|平|平方米)/g, '');
  
  // 移除整租、合租等标签
  addr = addr.replace(/整租|合租|主卧|次卧/g, '');
  
  // ★ 移除距离描述（如 "300米"、"2公里"、"步行5分钟"）
  addr = addr.replace(/\d+(?:\.\d+)?(?:米|公里|km|m)/g, '');
  addr = addr.replace(/步行\d+分钟/g, '');
  
  // ★ 移除方向描述（如 "双南"、"南北通透"、"朝南"）
  addr = addr.replace(/双南|双北|南北通透|南北|东西|朝南|朝北|朝东|朝西|东南|西南|东北|西北|南向|北向|东向|西向/g, '');
  
  // ★ 移除设施和装修描述
  addr = addr.replace(/独立厨卫|独卫|明卫|暗卫|原始明卫|精装修|简装|毛坯|带阳台|有电梯|无电梯/g, '');
  
  // ★ 移除楼层信息
  addr = addr.replace(/\d+楼|高楼层|中楼层|低楼层/g, '');
  
  // ★ 移除地铁/公交线路信息（如 "78号线"、"地铁口"）
  addr = addr.replace(/\d+号线/g, '');
  addr = addr.replace(/地铁口/g, '');
  
  // ★ 移除房源特性描述（如 "宠物友好"、"可办居住证"、"边套"）
  addr = addr.replace(/宠物友好|可养宠|宠物|可办居住证|边套|中套|拎包入住|随时看房|民用水电|安选/g, '');
  
  // 移除连续的特殊字符
  addr = addr.replace(/[·｜,，\s]+/g, ' ');
  
  return addr.trim();
}

/** 高德 Web 服务地理编码（与地图 JS API 分离，在 RN 中更可靠） */
export async function geocodeAddress(address: string, cityCode?: string): Promise<Coord | null> {
  // ★ 使用队列限流，避免 QPS 超限
  return amapQueue.enqueue(async () => {
    const { amapKey } = await getApiConfig();
    if (!amapKey || amapKey.trim().length === 0) {
      console.error('[geo] 高德地图 API Key 未配置或为空');
      throw new Error('未配置高德地图 Key，请在「我的」页面配置');
    }

    // 清理地址
    const cleanedAddress = cleanAddress(address);
    if (!cleanedAddress || cleanedAddress.length < 2) {
      console.log('[geo] 地址过短或为空:', address);
      return null;
    }

    const params = new URLSearchParams({
      key: amapKey,
      address: cleanedAddress,
    });
    
    // 如果提供了城市代码，添加city参数限定范围
    if (cityCode && CITY_CODE_MAP[cityCode.toLowerCase()]) {
      params.set('city', CITY_CODE_MAP[cityCode.toLowerCase()]);
    }

    const url = `https://restapi.amap.com/v3/geocode/geo?${params.toString()}`;
    console.log('[geo] 地理编码请求:', cleanedAddress, cityCode ? `(${CITY_CODE_MAP[cityCode.toLowerCase()]})` : '');
    
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error('[geo] 地理编码HTTP错误:', resp.status, resp.statusText);
      throw new Error(`高德地理编码请求失败（HTTP ${resp.status}），请检查网络连接`);
    }
    
    const data: any = await resp.json();
    
    // 检查API返回的错误信息
    if (data.status !== '1') {
      const infocode = data.infocode || 'unknown';
      console.error('[geo] 地理编码API错误:', data.info, 'infocode:', infocode);
      
      // 提供更详细的错误信息
      if (infocode === '10001') {
        throw new Error('高德地图 API Key 无效，请在「我的」页面重新配置');
      } else if (infocode === '10002') {
        throw new Error('高德地图服务不可用，请稍后重试');
      } else if (infocode === '10003') {
        throw new Error('高德地图访问已超出日配额，请明天再试或更换 API Key');
      } else if (infocode === '10004' || infocode === '10021') {
        // 10004: 访问过于频繁（单位时间内）
        // 10021: CUQPS_HAS_EXCEEDED_THE_LIMIT（并发QPS超限）
        throw new Error('高德地图访问过于频繁，请稍后再试');
      } else if (infocode === '10005') {
        throw new Error('高德地图 API Key 缺少权限，请检查 Key 配置');
      } else if (infocode === '30001') {
        // ENGINE_RESPONSE_DATA_ERROR - 引擎返回数据异常
        console.error('[geo] 地理编码引擎数据错误，可能是地址格式问题');
        throw new Error('地址解析失败，请尝试使用更详细的地址');
      }
      
      return null;
    }
    
    if (!data.geocodes || data.geocodes.length === 0) {
      console.log('[geo] 地理编码无结果:', cleanedAddress, '可能地址不够精确');
      return null;
    }

    const loc = data.geocodes[0].location as string;
    const [lngStr, latStr] = loc.split(',');
    const lng = parseFloat(lngStr);
    const lat = parseFloat(latStr);
    if (Number.isNaN(lng) || Number.isNaN(lat)) {
      console.error('[geo] 坐标解析失败:', loc);
      return null;
    }
    
    console.log('[geo] 地理编码成功:', cleanedAddress, '→', { lng, lat, city: data.geocodes[0].city });
    return { lng, lat };
  });
}

/** 高德 Web 服务逆地理编码（地图 WebView 内 Geocoder 失败时的兜底） */
export async function reverseGeocode(lng: number, lat: number): Promise<string | null> {
  // ★ 使用队列限流，避免 QPS 超限
  return amapQueue.enqueue(async () => {
    const { amapKey } = await getApiConfig();
    if (!amapKey || amapKey.trim().length === 0) {
      console.error('[geo] 逆地理编码：API Key 未配置');
      return null;
    }
    if (Number.isNaN(lng) || Number.isNaN(lat)) {
      console.error('[geo] 逆地理编码：坐标无效', { lng, lat });
      return null;
    }
    
    const params = new URLSearchParams({
      key: amapKey,
      location: `${lng},${lat}`,
      radius: '200',
      extensions: 'base',
    });
    
    try {
      console.log('[geo] 逆地理编码请求:', { lng, lat });
      const resp = await fetch(`https://restapi.amap.com/v3/geocode/regeo?${params.toString()}`);
      if (!resp.ok) {
        console.error('[geo] 逆地理编码HTTP错误:', resp.status);
        return null;
      }
      
      const data: any = await resp.json();
      
      if (data.status !== '1') {
        const infocode = data.infocode || 'unknown';
        console.error('[geo] 逆地理编码API错误:', data.info, 'infocode:', infocode);
        
        // 处理常见错误码
        if (infocode === '10004' || infocode === '10021') {
          console.warn('[geo] 逆地理编码QPS超限，已自动限流');
        } else if (infocode === '30001') {
          console.error('[geo] 逆地理编码引擎数据错误');
        }
        
        return null;
      }
      
      if (!data.regeocode) {
        console.log('[geo] 逆地理编码无结果');
        return null;
      }
      
      const formatted = String(data.regeocode.formatted_address || '').trim();
      if (formatted.length >= 4) {
        console.log('[geo] 逆地理编码成功:', formatted);
        return formatted;
      }
      
      return null;
    } catch (error) {
      console.error('[geo] 逆地理编码异常:', error);
      return null;
    }
  });
}

/** 按顺序尝试多个地址串，返回首个解析成功的坐标（无法保证每个房源都能命中） */
export async function geocodeFirstMatch(
  candidates: string[],
  cityCode?: string,
): Promise<{ coord: Coord; matchedQuery: string } | null> {
  const seen = new Set<string>();
  for (const raw of candidates) {
    const q = cleanAddress(String(raw || '').trim());
    if (q.length < 2 || seen.has(q)) continue;
    seen.add(q);
    const coord = await geocodeAddress(q, cityCode);
    if (coord) return { coord, matchedQuery: q };
  }
  return null;
}

/** 为房源终点构建地理编码候选，提高命中率 */
export function buildListingDestinationCandidates(listing: {
  district?: string;
  community?: string;
  title?: string;
  cityCode?: string;
}): string[] {
  const city = listing.cityCode ? CITY_CODE_MAP[String(listing.cityCode).toLowerCase()] : '';
  const d = (listing.district || '').trim();
  const c = (listing.community || '').trim();
  const title = (listing.title || '').trim();
  const seen = new Set<string>();
  const out: string[] = [];

  function push(s: string) {
    const t = cleanAddress(s).trim();
    if (t.length < 2) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  }

  // ★ 优先使用小区+区域组合（最可靠）
  if (c && c !== '未知小区' && c !== '未知') {
    if (city) {
      push(`${city}${c}`);
      push(`${city} ${c}`);
    }
    push(c);
    if (d && d !== '未知区域' && d !== '未知') {
      push(`${d} ${c}`);
      if (city) push(`${city}${d}${c}`);
    }
  } else if (d && d !== '未知区域' && d !== '未知') {
    if (city) push(`${city}${d}`);
    push(d);
  }

  // ★ 标题作为最后的备选，且需要严格过滤
  if (title.length >= 4 && out.length === 0) {
    // 移除营销词汇和描述性内容
    const stripped = title
      .replace(/^(整租|合租|短租|公寓)[·｜|\s]*/u, '')
      .replace(/\d+室\d*厅?/g, ' ')
      .replace(/近地铁|地铁口|随时看房|民用水电|可养宠|精装修|拎包入住|安选/g, '')
      .replace(/\d+元/g, '')
      .trim();
    
    // 只有当清理后的标题看起来像地址时才使用
    if (stripped.length >= 4 && 
        stripped.length <= 48 && 
        /[\u4e00-\u9fa5]{3,}/.test(stripped) && // 至少3个汉字
        !/随时|看房|入住|水电|装修|拎包/.test(stripped)) { // 不含营销词
      push(stripped);
    }
  }

  return out;
}

function cityLabelForTransit(cityCode?: string): string {
  const c = String(cityCode || '').trim().toLowerCase();
  if (c && CITY_CODE_MAP[c]) return CITY_CODE_MAP[c];
  return '北京';
}

/** 按高德 Web 路径规划拉取时间与距离（公交地铁 / 驾车 / 步行 / 骑行） */
async function fetchAmapRouteByMode(
  mode: CommuteRouteMode,
  key: string,
  originLoc: string,
  destLoc: string,
  cityLabel: string,
): Promise<{ distanceMeters: number; durationSeconds: number; distanceLabel?: string } | null> {
  if (mode === 'transit') {
    const params = new URLSearchParams({
      key,
      origin: originLoc,
      destination: destLoc,
      city: cityLabel,
      extensions: 'base',
    });
    const resp = await fetch(`https://restapi.amap.com/v3/direction/transit/integrated?${params.toString()}`);
    if (!resp.ok) return null;
    const data: any = await resp.json();
    if (data.status !== '1' || !data.route) return null;
    const transits = data.route.transits;
    if (!Array.isArray(transits) || transits.length === 0) return null;
    const t0 = transits[0];
    const durationSeconds = Number(t0.duration || 0);
    const walkingM = Number(t0.walking_distance || 0);
    if (!durationSeconds) return null;
    const distanceLabel =
      walkingM > 150 ? `步行衔接约${(walkingM / 1000).toFixed(1)}km` : '公共交通';
    return { distanceMeters: 0, durationSeconds, distanceLabel };
  }

  const pathUrl =
    mode === 'driving'
      ? 'https://restapi.amap.com/v3/direction/driving'
      : mode === 'walking'
        ? 'https://restapi.amap.com/v3/direction/walking'
        : 'https://restapi.amap.com/v3/direction/bicycling';
  const params = new URLSearchParams({
    key,
    origin: originLoc,
    destination: destLoc,
  });
  const resp = await fetch(`${pathUrl}?${params.toString()}`);
  if (!resp.ok) return null;
  const data: any = await resp.json();
  if (data.status !== '1') return null;
  const path = data?.route?.paths?.[0];
  const distanceMeters = Number(path?.distance || 0);
  const durationSeconds = Number(path?.duration || 0);
  if (!distanceMeters || !durationSeconds) return null;
  return { distanceMeters, durationSeconds };
}

export async function calculateCommute(
  origin: string,
  destination: string,
  cityCode?: string,
  /** 主地址解析失败时继续尝试的其它写法 */
  destinationFallbacks?: string[],
): Promise<CommuteResult> {
  try {
    const from = origin.trim();
    const to = destination.trim();

    const { amapKey } = await getApiConfig();
    console.log('[geo] amapKey:', amapKey);
    console.log('[geo] origin:', from);
    console.log('[geo] destination:', to);
    console.log('[geo] cityCode:', cityCode);

    if (!from || !to) {
      return { distance: '', duration: '', success: false, errorReason: '起点或终点地址为空' };
    }

    const [originCoord, destHit] = await Promise.all([
      geocodeAddress(from, cityCode),
      geocodeFirstMatch(
        [to, ...(destinationFallbacks || [])].filter((s) => String(s || '').trim().length >= 2),
        cityCode,
      ),
    ]);

    if (!originCoord) {
      // #region agent log
      fetch('http://127.0.0.1:7750/ingest/c7852349-c1c4-418e-b862-f082a33bb43e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'cb84fa'},body:JSON.stringify({sessionId:'cb84fa',location:'geo.ts:calculateCommute',message:'origin_geocode_miss',data:{fromLen:from.length,fromLooksLikeCoordParen:/地图选点|[（(]\s*\d+\.\d+/.test(from),cityCode:String(cityCode||'')},timestamp:Date.now(),hypothesisId:'H-C'})}).catch(()=>{});
      // #endregion
      return {
        distance: '',
        duration: '',
        success: false,
        errorReason: `起点地址解析失败：${from}`,
      };
    }

    if (!destHit) {
      return {
        distance: '',
        duration: '',
        success: false,
        errorReason: '目的地未能解析为坐标（已尝试多种地址写法，部分房源在高德中无精确匹配）',
      };
    }

    const destCoord = destHit.coord;

    const apiCfg = await getApiConfig();
    const { amapKey: keyForRoute } = apiCfg;
    const mode: CommuteRouteMode = apiCfg.commuteRouteMode || 'transit';
    const routeModeLabel =
      mode === 'transit'
        ? '公共交通'
        : mode === 'driving'
          ? '驾车'
          : mode === 'walking'
            ? '步行'
            : '骑行';
    const originLoc = `${originCoord.lng},${originCoord.lat}`;
    const destinationLoc = `${destCoord.lng},${destCoord.lat}`;
    const cityLabel = cityLabelForTransit(cityCode);

    // ★ 使用队列限流，避免 QPS 超限
    const routed = await amapQueue.enqueue(() => 
      fetchAmapRouteByMode(mode, keyForRoute, originLoc, destinationLoc, cityLabel)
    );
    if (!routed) {
      return {
        distance: '',
        duration: '',
        success: false,
        errorReason:
          mode === 'transit'
            ? '未找到可行的公交/地铁路线（起终点过远或超出当前城市公交数据范围），可在「我的」设置中改为驾车/步行等方式重试'
            : '未找到有效的导航路线',
        routeMode: mode,
        routeModeLabel,
      };
    }

    const { distanceMeters, durationSeconds, distanceLabel } = routed;
    const mins = Math.max(1, Math.round(durationSeconds / 60));
    const distStr =
      distanceLabel ||
      (distanceMeters > 0 ? `${(distanceMeters / 1000).toFixed(1)}km` : '—');
    return {
      distance: distStr,
      duration: `${mins}分钟`,
      success: true,
      routeMode: mode,
      routeModeLabel,
    };
  } catch (error: any) {
    return { 
      distance: '', 
      duration: '', 
      success: false, 
      errorReason: error?.message || '网络异常或系统错误' 
    };
  }
}
 
