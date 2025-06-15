import { useState, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { WebView } from 'react-native-webview';
import { geocodeAddress, geocodeFirstMatch, reverseGeocode } from './lib/geo';
import { getApiConfig, getPrefs, savePrefs } from './lib/storage';

// #region agent log
const DEBUG_INGEST = 'http://127.0.0.1:7750/ingest/c7852349-c1c4-418e-b862-f082a33bb43e';
const DEBUG_SESSION = '50dec4';
function agentLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
) {
  fetch(DEBUG_INGEST, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': DEBUG_SESSION,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION,
      location,
      message,
      data,
      timestamp: Date.now(),
      hypothesisId,
    }),
  }).catch(() => {});
}
// #endregion

/** expo-router 查询参数常为 string | string[]，不能直接 .trim() 或传给 TextInput */
function searchParamToString(v: string | string[] | undefined): string {
  if (v == null) return '';
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s.trim() : '';
}

export default function MapPickerPage() {
  const router = useRouter();
  const { initialAddress } = useLocalSearchParams<{ initialAddress?: string | string[] }>();
  const initialAddressStr = searchParamToString(initialAddress);
  const webViewRef = useRef<WebView>(null);
  
  const [address, setAddress] = useState(initialAddressStr);
  const [selectedAddress, setSelectedAddress] = useState('');
  const [mapLoading, setMapLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const selectedCoordRef = useRef<{ lng: number; lat: number } | null>(null);
  const regeoSeqRef = useRef(0);

  const getMapHTML = useCallback(async () => {
    const config = await getApiConfig();
    const prefs = await getPrefs();
    const jsKey = config.amapJsKey || config.amapKey || '';
    const initAddr = initialAddressStr;

    const DEFAULT_LNG = 114.305539;
    const DEFAULT_LAT = 30.593099;
    let bootLng = DEFAULT_LNG;
    let bootLat = DEFAULT_LAT;
    const wLng = parseFloat(String(prefs.workLng || '').trim());
    const wLat = parseFloat(String(prefs.workLat || '').trim());
    if (!Number.isNaN(wLng) && !Number.isNaN(wLat) && Math.abs(wLng) <= 180 && Math.abs(wLat) <= 90) {
      bootLng = wLng;
      bootLat = wLat;
    } else if (initAddr.length >= 2) {
      const coord = await geocodeAddress(initAddr, prefs.city);
      if (coord) {
        bootLng = coord.lng;
        bootLat = coord.lat;
      }
    } else {
      const cityHit = await geocodeFirstMatch(
        [`${prefs.cityLabel}人民政府`, `${prefs.cityLabel}市政府`, prefs.cityLabel],
        prefs.city,
      );
      if (cityHit) {
        bootLng = cityHit.coord.lng;
        bootLat = cityHit.coord.lat;
      }
    }

    // #region agent log
    agentLog(
      'map-picker.tsx:getMapHTML',
      'html_build',
      {
        jsKeyLen: jsKey.length,
        initAddrLen: initAddr.length,
        hasJsKey: Boolean(jsKey),
        initWasArray: Array.isArray(initialAddress),
        bootFromRest: initAddr.length >= 2,
        bootLngRounded: Math.round(bootLng * 1e5) / 1e5,
        bootLatRounded: Math.round(bootLat * 1e5) / 1e5,
        cityCode: prefs.city,
      },
      'H2',
    );
    // #endregion

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>选择位置</title>
  <script src="https://webapi.amap.com/maps?v=2.0&key=${jsKey}"><\/script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    #map { width: 100%; height: 100%; }
    .map-pin {
      width: 30px; height: 40px;
      display: flex; align-items: flex-start; justify-content: center;
    }
    .map-pin-body {
      width: 26px; height: 26px; border-radius: 50% 50% 50% 0;
      background: #e74c3c; border: 3px solid #c0392b;
      transform: rotate(-45deg);
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
      position: relative;
    }
    .map-pin-body::after {
      content: '';
      width: 10px; height: 10px; border-radius: 50%;
      background: #fff;
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var map, marker, geocoder;

    /* ── 用 HTML content 创建水滴指针，避免 btoa/Icon 兼容问题 ── */
    var PIN_HTML = '<div class="map-pin"><div class="map-pin-body"></div></div>';

    function postMsg(obj) {
      try { window.ReactNativeWebView.postMessage(JSON.stringify(obj)); } catch(e) {}
    }

    /* #region agent log */
    postMsg({ type: 'map_dbg', step: 'inline_enter', amapType: typeof window.AMap, hypothesisId: 'H1' });
    window.onerror = function(msg, url, line, col, err) {
      postMsg({ type: 'map_dbg', step: 'window_onerror', msg: String(msg), line: line, hypothesisId: 'H1' });
      return false;
    };
    /* #endregion */

    function updateAddress(lng, lat) {
      if (!geocoder) return;
      geocoder.getAddress([lng, lat], function(status, result) {
        if (status === 'complete' && result.info === 'OK') {
          postMsg({ type: 'address_updated', address: result.regeocode.formattedAddress, lng: lng, lat: lat, _dbgRegeo: { ok: true, status: String(status), info: String(result.info || '') } });
        } else {
          postMsg({
            type: 'address_updated',
            address: '地图选点（' + Number(lng).toFixed(5) + '，' + Number(lat).toFixed(5) + '）',
            lng: lng,
            lat: lat,
            _dbgRegeo: { ok: false, status: String(status), info: (result && result.info) ? String(result.info) : 'no_result_info' }
          });
        }
      });
    }

    function startMap(center) {
      /* #region agent log */
      postMsg({ type: 'map_dbg', step: 'startMap', center0: center[0], center1: center[1], hypothesisId: 'H5' });
      /* #endregion */
      map = new AMap.Map('map', { zoom: 15, center: center, animateEnable: true });

      marker = new AMap.Marker({
        position: center,
        content: PIN_HTML,
        offset: new AMap.Pixel(-13, -36),
        draggable: true,
        cursor: 'move',
      });
      map.add(marker);

      marker.on('dragend', function() {
        var p = marker.getPosition();
        updateAddress(p.getLng(), p.getLat());
      });

      map.on('click', function(e) {
        var lnglat = e.lnglat;
        marker.setPosition(lnglat);
        updateAddress(lnglat.getLng(), lnglat.getLat());
      });

      updateAddress(center[0], center[1]);
      postMsg({ type: 'map_loaded' });
    }

    function relocateTo(lng, lat) {
      if (!map || !marker) return;
      marker.setPosition([lng, lat]);
      map.setZoomAndCenter(15, [lng, lat]);
      updateAddress(lng, lat);
    }

    /* RN 端 REST 地理编码后通过 injectJavaScript 调用（Android postMessage 常进不来） */
    window.rentSmartRelocate = function(lng, lat) {
      relocateTo(Number(lng), Number(lat));
    };

    /* ── 全部逻辑在 AMap.plugin 回调里，确保 Geocoder 已就绪 ── */
    try {
      /* #region agent log */
      postMsg({ type: 'map_dbg', step: 'before_plugin', amapType: typeof window.AMap, hypothesisId: 'H1' });
      /* #endregion */
      AMap.plugin('AMap.Geocoder', function() {
        /* #region agent log */
        postMsg({ type: 'map_dbg', step: 'plugin_cb_enter', hypothesisId: 'H1' });
        /* #endregion */
        geocoder = new AMap.Geocoder({ radius: 500, extensions: 'base' });

        var BOOT_CENTER = [${bootLng}, ${bootLat}];
        /* 首帧中心由 RN 侧 REST 地理编码写入，避免 WebView 内 getLocation 无回调 */
        startMap(BOOT_CENTER);
        /* #region agent log */
        postMsg({ type: 'map_dbg', step: 'after_startMap_boot', center0: BOOT_CENTER[0], center1: BOOT_CENTER[1], hypothesisId: 'H4' });
        /* #endregion */
      });
    } catch (e) {
      /* #region agent log */
      postMsg({ type: 'map_dbg', step: 'plugin_throw', err: String(e && e.message ? e.message : e), hypothesisId: 'H1' });
      /* #endregion */
    }

  <\/script>
</body>
</html>
    `;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAddressStr]);

  const [mapHTML, setMapHTML] = useState('');

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const html = await getMapHTML();
        // #region agent log
        agentLog('map-picker.tsx:useFocusEffect', 'setMapHTML', { htmlLen: html.length }, 'H3');
        // #endregion
        setMapHTML(html);
      })();
    }, [getMapHTML])
  );

  function handleWebViewMessage(event: any) {
    try {
      const raw = event.nativeEvent.data;
      const data = JSON.parse(raw);
      // #region agent log
      if (data.type === 'map_dbg') {
        // Metro 备用输出（真机 ingest 常连不到本机 127.0.0.1）
        console.log('[map_dbg]', data.step, data);
        agentLog('map-picker.tsx:handleWebViewMessage', 'webview_dbg', {
          step: data.step,
          amapType: data.amapType,
          status: data.status,
          err: data.err,
          msg: data.msg,
          line: data.line,
          hasGeocodes: data.hasGeocodes,
          center0: data.center0,
          hypothesisId: data.hypothesisId,
        }, String(data.hypothesisId || 'H?'));
      }
      // #endregion

      switch (data.type) {
        case 'map_loaded':
          // #region agent log
          agentLog('map-picker.tsx:handleWebViewMessage', 'map_loaded_received', {}, 'H5');
          // #endregion
          setMapLoading(false);
          break;
        case 'address_updated': {
          // #region agent log
          fetch('http://127.0.0.1:7750/ingest/c7852349-c1c4-418e-b862-f082a33bb43e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'cb84fa'},body:JSON.stringify({sessionId:'cb84fa',location:'map-picker.tsx:address_updated',message:'regeo_result',data:{addrLen:String(data.address||'').length,addrIsCoordFallback:/地图选点\s*[（(]/.test(String(data.address||'')),dbg:data._dbgRegeo,lng:data.lng,lat:data.lat},timestamp:Date.now(),hypothesisId:'H-A'})}).catch(()=>{});
          // #endregion
          const lng = Number(data.lng);
          const lat = Number(data.lat);
          if (!Number.isNaN(lng) && !Number.isNaN(lat)) {
            selectedCoordRef.current = { lng, lat };
          }
          const rawAddr = String(data.address || '').trim();
          const fallbackCoord = /地图选点\s*[（(]/.test(rawAddr);
          const needRestRegeo = !rawAddr || fallbackCoord;
          const mySeq = ++regeoSeqRef.current;
          if (needRestRegeo && !Number.isNaN(lng) && !Number.isNaN(lat)) {
            void (async () => {
              const formatted = await reverseGeocode(lng, lat);
              if (regeoSeqRef.current !== mySeq) return;
              setSelectedAddress(formatted || rawAddr || `地图选点（${lng}，${lat}）`);
            })();
          } else {
            setSelectedAddress(rawAddr || `地图选点（${lng}，${lat}）`);
          }
          break;
        }
        case 'search_success':
          setSearchLoading(false);
          break;
        case 'search_failed':
          setSearchLoading(false);
          Alert.alert('搜索失败', data.message || '未找到该地址');
          break;
      }
    } catch (error) {
      console.error('解析地图消息失败:', error);
    }
  }

  async function handleSearch() {
    const keyword = address.trim();
    if (!keyword) {
      Alert.alert('提示', '请输入地址关键词');
      return;
    }

    setSearchLoading(true);
    try {
      const prefs = await getPrefs();
      const coord = await geocodeAddress(keyword, prefs.city);
      if (!coord) {
        Alert.alert('搜索失败', '未找到该地点，请换更具体的关键词或检查偏好城市是否选对');
        return;
      }
      const js = `true;(function(){if(window.rentSmartRelocate){window.rentSmartRelocate(${coord.lng},${coord.lat});}})();`;
      webViewRef.current?.injectJavaScript(js);
      selectedCoordRef.current = { lng: coord.lng, lat: coord.lat };
      const formatted = await reverseGeocode(coord.lng, coord.lat);
      setSelectedAddress(formatted || keyword);
    } catch {
      Alert.alert('搜索失败', '网络或配置异常，请稍后重试');
    } finally {
      setSearchLoading(false);
    }
  }

  async function handleConfirm() {
    if (!selectedAddress) {
      Alert.alert('提示', '请先选择位置');
      return;
    }
    
    const c = selectedCoordRef.current;
    await savePrefs({
      workAddress: selectedAddress,
      ...(c && !Number.isNaN(c.lng) && !Number.isNaN(c.lat)
        ? { workLng: String(c.lng), workLat: String(c.lat) }
        : {}),
    });
    // #region agent log
    fetch('http://127.0.0.1:7750/ingest/c7852349-c1c4-418e-b862-f082a33bb43e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'cb84fa'},body:JSON.stringify({sessionId:'cb84fa',location:'map-picker.tsx:handleConfirm',message:'save_work_address',data:{len:selectedAddress.length,isCoordFallback:/地图选点\s*[（(]/.test(selectedAddress)},timestamp:Date.now(),hypothesisId:'H-C'})}).catch(()=>{});
    // #endregion
    Alert.alert('已保存', `常去地址已设置为：${selectedAddress}`, [
      {
        text: '确定',
        onPress: () => router.back(),
      },
    ]);
  }

  if (!mapHTML) {
    return (
      <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
        <View style={s.loading}>
          <ActivityIndicator size="large" color="#00ae66" />
          <Text style={s.loadingText}>加载地图中...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
      <View style={s.navbar}>
        <TouchableOpacity style={s.navBack} onPress={() => router.back()}>
          <Text style={s.navBackText}>←</Text>
        </TouchableOpacity>
        <Text style={s.navTitle}>选择位置</Text>
        <View style={{ width: 40 }} />
      </View>

      <KeyboardAvoidingView 
        style={s.container} 
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.searchBar}>
          <TextInput
            style={s.searchInput}
            placeholder="输入地址关键词，如：光谷广场"
            placeholderTextColor="#bbb"
            value={address}
            onChangeText={setAddress}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
          />
          <TouchableOpacity
            style={s.searchBtn}
            onPress={handleSearch}
            disabled={searchLoading}
          >
            {searchLoading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={s.searchBtnText}>搜索</Text>
            )}
          </TouchableOpacity>
        </View>

        <View style={s.mapContainer}>
          {mapLoading && (
            <View style={s.mapLoading}>
              <ActivityIndicator size="large" color="#00ae66" />
            </View>
          )}
          <WebView
            ref={webViewRef}
            source={{ html: mapHTML }}
            onMessage={handleWebViewMessage}
            onError={(e) => {
              // #region agent log
              agentLog('map-picker.tsx:WebView', 'onError', { desc: String(e.nativeEvent?.description || '') }, 'H2');
              // #endregion
            }}
            onHttpError={(e) => {
              // #region agent log
              agentLog('map-picker.tsx:WebView', 'onHttpError', { status: e.nativeEvent.statusCode }, 'H2');
              // #endregion
            }}
            javaScriptEnabled
            domStorageEnabled
            scrollEnabled={false}
            overScrollMode="never"
            mixedContentMode="always"
            allowsInlineMediaPlayback
            style={s.webview}
          />
        </View>

        <View style={s.footer}>
          {selectedAddress ? (
            <View style={s.addressInfo}>
              <Text style={s.addressLabel}>📍 已选位置：</Text>
              <Text style={s.addressText} numberOfLines={2}>{selectedAddress}</Text>
            </View>
          ) : (
            <View style={s.addressInfo}>
              <Text style={s.addressHint}>👆 点击地图或拖动标记选择位置</Text>
            </View>
          )}
          
          <TouchableOpacity
            style={[s.confirmBtn, !selectedAddress && s.confirmBtnDisabled]}
            onPress={handleConfirm}
            disabled={!selectedAddress}
          >
            <Text style={s.confirmBtnText}>确认选择</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f5f8' },
  navbar: {
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  navBack: { paddingHorizontal: 6 },
  navBackText: { fontSize: 22, color: '#00ae66', fontWeight: '600' },
  navTitle: { fontSize: 16, fontWeight: '700', color: '#222' },
  container: { flex: 1 },
  searchBar: {
    flexDirection: 'row',
    padding: 12,
    gap: 8,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  searchInput: {
    flex: 1,
    height: 40,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#333',
    backgroundColor: '#f9f9f9',
  },
  searchBtn: {
    backgroundColor: '#00ae66',
    borderRadius: 8,
    paddingHorizontal: 20,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 70,
  },
  searchBtnText: { fontSize: 14, color: '#fff', fontWeight: '600' },
  mapContainer: { flex: 1, position: 'relative' },
  webview: { flex: 1 },
  mapLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  footer: {
    backgroundColor: '#fff',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  addressInfo: {
    marginBottom: 12,
  },
  addressLabel: { fontSize: 12, color: '#666', marginBottom: 4 },
  addressText: { fontSize: 14, color: '#333', fontWeight: '600', lineHeight: 20 },
  addressHint: { fontSize: 13, color: '#999', textAlign: 'center' },
  confirmBtn: {
    backgroundColor: '#00ae66',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  confirmBtnDisabled: {
    backgroundColor: '#ccc',
  },
  confirmBtnText: { fontSize: 15, color: '#fff', fontWeight: '600' },
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: { marginTop: 12, fontSize: 13, color: '#999' },
});
