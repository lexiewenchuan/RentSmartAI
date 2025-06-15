import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { clearDeepAnalysisRecords, getDeepAnalysisRecords, type DeepAnalysisRecord } from './lib/storage';

export default function DeepAnalysesPage() {
  const router = useRouter();
  const [records, setRecords] = useState<DeepAnalysisRecord[]>([]);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const deepRecords = await getDeepAnalysisRecords();
        setRecords(deepRecords);
      })();
    }, [])
  );

  async function handleClear() {
    await clearDeepAnalysisRecords();
    setRecords([]);
    Alert.alert('完成', '已精筛记录缓存已清空');
  }

  return (
    <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
      <View style={s.navbar}>
        <TouchableOpacity style={s.navBack} onPress={() => router.back()}>
          <Text style={s.navBackText}>←</Text>
        </TouchableOpacity>
        <Text style={s.navTitle}>精筛记录</Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={s.toolbar}>
        <Text style={s.countText}>共 {records.length} 条</Text>
        <TouchableOpacity
          style={s.clearBtn}
          onPress={() =>
            Alert.alert('确认清空', '确认清空全部已精筛记录缓存吗？', [
              { text: '取消', style: 'cancel' },
              { text: '清空', style: 'destructive', onPress: handleClear },
            ])
          }
        >
          <Text style={s.clearBtnText}>🗑 清空已精筛记录</Text>
        </TouchableOpacity>
      </View>

      {records.length === 0 ? (
        <View style={s.emptyWrap}>
          <Text style={s.emptyIcon}>🔬</Text>
          <Text style={s.emptyTitle}>还没有精筛记录</Text>
          <Text style={s.emptyDesc}>去房源详情页执行精筛分析后，会出现在这里</Text>
        </View>
      ) : (
        <ScrollView style={s.body} showsVerticalScrollIndicator={false}>
          {records.map(item => (
            <View key={`${item.listingId}-${item.createdAt}`} style={s.row}>
              <Text style={s.title} numberOfLines={2}>{item.title || '未知标题'}</Text>
              <Text style={s.meta}>
                精筛评分 {item.score?.toFixed ? item.score.toFixed(1) : item.score} · {new Date(item.createdAt).toLocaleString()}
              </Text>
              <Text style={s.summary} numberOfLines={3}>{item.summary || '暂无摘要'}</Text>
              
              <View style={s.btnRow}>
                <TouchableOpacity 
                  style={s.detailBtn} 
                  onPress={() => router.push(`/listing/${item.listingId}`)}
                >
                  <Text style={s.detailBtnText}>查看房源详情</Text>
                </TouchableOpacity>
                
                <TouchableOpacity 
                  style={s.xhsBtn} 
                  onPress={() => router.push(`/listing/${item.listingId}?action=xhs`)}
                >
                  <Text style={s.xhsBtnText}>📖 小红书评价</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}
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
  toolbar: { padding: 12, gap: 8 },
  countText: { fontSize: 12, color: '#999' },
  clearBtn: {
    backgroundColor: '#fff5f5',
    borderWidth: 1,
    borderColor: '#ffd9d9',
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  clearBtnText: { fontSize: 13, color: '#e74c3c', fontWeight: '600' },
  body: { flex: 1 },
  row: {
    backgroundColor: '#fff',
    marginHorizontal: 12,
    marginBottom: 10,
    borderRadius: 12,
    padding: 12,
  },
  title: { fontSize: 14, fontWeight: '700', color: '#222', lineHeight: 20 },
  meta: { fontSize: 12, color: '#666', marginTop: 6 },
  summary: { fontSize: 12, color: '#999', marginTop: 6, lineHeight: 18 },
  btnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  detailBtn: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#00ae66',
    backgroundColor: '#f0faf5',
    paddingVertical: 9,
    alignItems: 'center',
  },
  detailBtnText: { fontSize: 13, color: '#00ae66', fontWeight: '600' },
  xhsBtn: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ff6b6b',
    backgroundColor: '#fff5f5',
    paddingVertical: 9,
    alignItems: 'center',
  },
  xhsBtnText: { fontSize: 13, color: '#ff6b6b', fontWeight: '600' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  emptyIcon: { fontSize: 40, marginBottom: 8 },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: '#333' },
  emptyDesc: { fontSize: 13, color: '#999', marginTop: 6 },
});
