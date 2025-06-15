import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  checkAndFixFavoriteConsistency,
  createFavoriteFolder,
  deleteFavoriteFolder,
  getFavoriteFolders,
  getFolderListings,
  migrateOldFavorites,
  renameFavoriteFolder,
  type FavoriteFolder
} from './lib/storage';

export default function FavoritesPage() {
  const router = useRouter();
  const [folders, setFolders] = useState<FavoriteFolder[]>([]);
  const [folderCounts, setFolderCounts] = useState<Record<string, number>>({});
  
  // 新建/重命名收藏夹 Modal 状态
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [folderToRename, setFolderToRename] = useState<FavoriteFolder | null>(null);

  const loadData = useCallback(async () => {
    // 先执行数据迁移
    await migrateOldFavorites();
    
    // 执行数据一致性检查和修复
    const consistencyResult = await checkAndFixFavoriteConsistency();
    if (consistencyResult.fixed) {
      console.log('[Favorites] Data consistency fixed:', consistencyResult.details);
    }
    
    // 加载收藏夹列表
    const folderList = await getFavoriteFolders();
    setFolders(folderList);
    
    // 计算每个收藏夹的房源数量
    const counts: Record<string, number> = {};
    for (const folder of folderList) {
      const listings = await getFolderListings(folder.id);
      counts[folder.id] = listings.length;
    }
    setFolderCounts(counts);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  function handleOpenFolder(folder: FavoriteFolder) {
    router.push({
      pathname: '/folder-detail',
      params: { folderId: folder.id, folderName: folder.name },
    });
  }

  async function handleCreateFolder() {
    setInputValue('');
    setShowCreateModal(true);
  }
  
  async function confirmCreateFolder() {
    if (!inputValue || !inputValue.trim()) {
      Alert.alert('提示', '收藏夹名称不能为空');
      return;
    }
    await createFavoriteFolder(inputValue.trim());
    setShowCreateModal(false);
    setInputValue('');
    await loadData();
  }

  async function handleFolderMenu(folder: FavoriteFolder) {
    Alert.alert(
      folder.name,
      '选择操作',
      [
        {
          text: '重命名',
          onPress: () => {
            setFolderToRename(folder);
            setInputValue(folder.name);
            setShowRenameModal(true);
          },
        },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              '确认删除',
              `删除「${folder.name}」收藏夹？其中的房源也会被移除。`,
              [
                { text: '取消', style: 'cancel' },
                {
                  text: '删除',
                  style: 'destructive',
                  onPress: async () => {
                    await deleteFavoriteFolder(folder.id);
                    await loadData();
                  },
                },
              ]
            );
          },
        },
        { text: '取消', style: 'cancel' },
      ]
    );
  }

  
  async function confirmRenameFolder() {
    if (!folderToRename) return;
    if (!inputValue || !inputValue.trim()) {
      Alert.alert('提示', '收藏夹名称不能为空');
      return;
    }
    await renameFavoriteFolder(folderToRename.id, inputValue.trim());
    setShowRenameModal(false);
    setInputValue('');
    setFolderToRename(null);
    await loadData();
  }

  const hasNoFolders = folders.length === 0;

  return (
    <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
      <View style={s.navbar}>
        <TouchableOpacity style={s.navBack} onPress={() => router.back()}>
          <Text style={s.navBackText}>←</Text>
        </TouchableOpacity>
        <Text style={s.navTitle}>收藏夹</Text>
        <View style={{ width: 28 }} />
      </View>

      {hasNoFolders ? (
        <View style={s.emptyWrap}>
          <Text style={s.emptyIcon}>📁</Text>
          <Text style={s.emptyTitle}>还没有收藏夹</Text>
          <Text style={s.emptyDesc}>创建收藏夹来整理你的房源</Text>
          <TouchableOpacity style={s.goBtn} onPress={handleCreateFolder}>
            <Text style={s.goBtnText}>创建收藏夹</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView style={s.body} showsVerticalScrollIndicator={false}>
          {folders.map((folder) => (
            <TouchableOpacity
              key={folder.id}
              style={s.folderRow}
              activeOpacity={0.7}
              onPress={() => handleOpenFolder(folder)}
              onLongPress={() => handleFolderMenu(folder)}
            >
              <View style={s.folderIcon}>
                <Text style={s.folderIconText}>📁</Text>
              </View>
              <View style={s.folderInfo}>
                <Text style={s.folderName}>{folder.name}</Text>
                <Text style={s.folderMeta}>
                  {folderCounts[folder.id] || 0} 个房源
                </Text>
              </View>
              <Text style={s.folderArrow}>›</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={s.addFolderRow} onPress={handleCreateFolder}>
            <View style={s.addFolderIcon}>
              <Text style={s.addFolderIconText}>+</Text>
            </View>
            <Text style={s.addFolderText}>新建收藏夹</Text>
          </TouchableOpacity>
          <View style={{ height: 20 }} />
        </ScrollView>
      )}
      
      {/* 新建收藏夹 Modal */}
      <Modal visible={showCreateModal} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalContainer}>
            <Text style={s.modalTitle}>新建收藏夹</Text>
            <TextInput
              style={s.modalInput}
              placeholder="请输入收藏夹名称"
              placeholderTextColor="#999"
              value={inputValue}
              onChangeText={setInputValue}
              autoFocus
              maxLength={20}
            />
            <View style={s.modalButtons}>
              <TouchableOpacity
                style={[s.modalBtn, s.modalBtnCancel]}
                onPress={() => {
                  setShowCreateModal(false);
                  setInputValue('');
                }}
              >
                <Text style={s.modalBtnTextCancel}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, s.modalBtnConfirm]}
                onPress={confirmCreateFolder}
              >
                <Text style={s.modalBtnTextConfirm}>创建</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      
      {/* 重命名收藏夹 Modal */}
      <Modal visible={showRenameModal} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalContainer}>
            <Text style={s.modalTitle}>重命名收藏夹</Text>
            <TextInput
              style={s.modalInput}
              placeholder="请输入新名称"
              placeholderTextColor="#999"
              value={inputValue}
              onChangeText={setInputValue}
              autoFocus
              maxLength={20}
            />
            <View style={s.modalButtons}>
              <TouchableOpacity
                style={[s.modalBtn, s.modalBtnCancel]}
                onPress={() => {
                  setShowRenameModal(false);
                  setInputValue('');
                  setFolderToRename(null);
                }}
              >
                <Text style={s.modalBtnTextCancel}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, s.modalBtnConfirm]}
                onPress={confirmRenameFolder}
              >
                <Text style={s.modalBtnTextConfirm}>确定</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  folderTabsContainer: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  folderTabsContent: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  folderTab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f5f5f8',
    gap: 4,
  },
  folderTabActive: {
    backgroundColor: '#e6f7f0',
  },
  folderTabText: {
    fontSize: 13,
    color: '#666',
    fontWeight: '500',
  },
  folderTabTextActive: {
    color: '#00ae66',
    fontWeight: '600',
  },
  folderCount: {
    fontSize: 12,
    color: '#999',
  },
  folderCountActive: {
    color: '#00ae66',
  },
  addFolderBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#00ae66',
    borderStyle: 'dashed',
  },
  addFolderBtnText: {
    fontSize: 13,
    color: '#00ae66',
    fontWeight: '500',
  },
  body: { flex: 1, paddingTop: 10 },
  folderRow: {
    backgroundColor: '#fff',
    marginHorizontal: 12,
    marginBottom: 10,
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  folderIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#f0faf5',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  folderIconText: {
    fontSize: 24,
  },
  folderInfo: {
    flex: 1,
  },
  folderName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#222',
    marginBottom: 4,
  },
  folderMeta: {
    fontSize: 13,
    color: '#999',
  },
  folderArrow: {
    fontSize: 28,
    color: '#ccc',
    fontWeight: '300',
  },
  addFolderRow: {
    backgroundColor: '#fff',
    marginHorizontal: 12,
    marginBottom: 10,
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#00ae66',
    borderStyle: 'dashed',
  },
  addFolderIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#e6f7f0',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  addFolderIconText: {
    fontSize: 24,
    color: '#00ae66',
    fontWeight: '300',
  },
  addFolderText: {
    fontSize: 15,
    color: '#00ae66',
    fontWeight: '600',
  },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  emptyIcon: { fontSize: 40, marginBottom: 8 },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: '#333' },
  emptyDesc: { fontSize: 13, color: '#999', marginTop: 6 },
  goBtn: {
    marginTop: 14,
    backgroundColor: '#00ae66',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  goBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  
  // Modal 样式
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContainer: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '100%',
    maxWidth: 320,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#222',
    marginBottom: 16,
    textAlign: 'center',
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#222',
    marginBottom: 16,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalBtnCancel: {
    backgroundColor: '#f5f5f8',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  modalBtnConfirm: {
    backgroundColor: '#00ae66',
  },
  modalBtnTextCancel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  modalBtnTextConfirm: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
});
