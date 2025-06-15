import { useState } from 'react';
import { Alert, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
  createFavoriteFolder,
  getFavoriteFolders,
  type FavoriteFolder,
} from '../lib/storage';

type FolderSelectorModalProps = {
  visible: boolean;
  onClose: () => void;
  onSelectFolder: (folderId: string) => void;
  currentFolderId?: string;
  title?: string;
  showCreateNew?: boolean;
};

export default function FolderSelectorModal({
  visible,
  onClose,
  onSelectFolder,
  currentFolderId,
  title = '选择收藏夹',
  showCreateNew = true,
}: FolderSelectorModalProps) {
  const [folders, setFolders] = useState<FavoriteFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  async function loadFolders() {
    const folderList = await getFavoriteFolders();
    setFolders(folderList);
  }

  function handleCreateFolder() {
    setNewFolderName('');
    setShowCreateModal(true);
  }
  
  async function confirmCreateFolder() {
    if (!newFolderName || !newFolderName.trim()) {
      Alert.alert('提示', '收藏夹名称不能为空');
      return;
    }
    setLoading(true);
    try {
      const newFolder = await createFavoriteFolder(newFolderName.trim());
      await loadFolders();
      setShowCreateModal(false);
      setNewFolderName('');
      onSelectFolder(newFolder.id);
      onClose();
    } catch (error) {
      Alert.alert('错误', '创建收藏夹失败');
    } finally {
      setLoading(false);
    }
  }

  function handleSelectFolder(folderId: string) {
    onSelectFolder(folderId);
    onClose();
  }

  // 当 Modal 打开时加载收藏夹列表
  React.useEffect(() => {
    if (visible) {
      loadFolders();
    }
  }, [visible]);

  return (
    <>
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={onClose}
      >
        <TouchableOpacity
          style={s.overlay}
          activeOpacity={1}
          onPress={onClose}
        >
          <TouchableOpacity
            style={s.container}
            activeOpacity={1}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={s.header}>
              <Text style={s.title}>{title}</Text>
              <TouchableOpacity onPress={onClose} style={s.closeBtn}>
                <Text style={s.closeBtnText}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={s.body} showsVerticalScrollIndicator={false}>
              {folders.map((folder) => (
                <TouchableOpacity
                  key={folder.id}
                  style={[
                    s.folderItem,
                    currentFolderId === folder.id && s.folderItemCurrent,
                  ]}
                  onPress={() => handleSelectFolder(folder.id)}
                  disabled={loading}
                >
                  <Text
                    style={[
                      s.folderName,
                      currentFolderId === folder.id && s.folderNameCurrent,
                    ]}
                  >
                    {folder.name}
                  </Text>
                  {currentFolderId === folder.id && (
                    <Text style={s.currentBadge}>当前</Text>
                  )}
                </TouchableOpacity>
              ))}

              {showCreateNew && (
                <TouchableOpacity
                  style={s.createBtn}
                  onPress={handleCreateFolder}
                  disabled={loading}
                >
                  <Text style={s.createBtnText}>+ 新建收藏夹</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
      
      {/* 新建收藏夹输入 Modal */}
      <Modal visible={showCreateModal} transparent animationType="fade">
        <View style={s.inputModalOverlay}>
          <View style={s.inputModalContainer}>
            <Text style={s.inputModalTitle}>新建收藏夹</Text>
            <TextInput
              style={s.inputModalInput}
              placeholder="请输入收藏夹名称"
              placeholderTextColor="#999"
              value={newFolderName}
              onChangeText={setNewFolderName}
              autoFocus
              maxLength={20}
            />
            <View style={s.inputModalButtons}>
              <TouchableOpacity
                style={[s.inputModalBtn, s.inputModalBtnCancel]}
                onPress={() => {
                  setShowCreateModal(false);
                  setNewFolderName('');
                }}
              >
                <Text style={s.inputModalBtnTextCancel}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.inputModalBtn, s.inputModalBtnConfirm]}
                onPress={confirmCreateFolder}
                disabled={loading}
              >
                <Text style={s.inputModalBtnTextConfirm}>
                  {loading ? '创建中...' : '创建'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

// 添加 React import
import * as React from 'react';

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  container: {
    backgroundColor: '#fff',
    borderRadius: 16,
    width: '100%',
    maxWidth: 400,
    maxHeight: '70%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: '#222',
  },
  closeBtn: {
    padding: 4,
  },
  closeBtnText: {
    fontSize: 20,
    color: '#999',
  },
  body: {
    padding: 16,
  },
  folderItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#f5f5f8',
    marginBottom: 10,
  },
  folderItemCurrent: {
    backgroundColor: '#e6f7f0',
    borderWidth: 1,
    borderColor: '#00ae66',
  },
  folderName: {
    fontSize: 15,
    color: '#333',
    fontWeight: '500',
  },
  folderNameCurrent: {
    color: '#00ae66',
    fontWeight: '600',
  },
  currentBadge: {
    fontSize: 12,
    color: '#00ae66',
    backgroundColor: '#fff',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  createBtn: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#00ae66',
    borderStyle: 'dashed',
    alignItems: 'center',
    marginTop: 6,
  },
  createBtnText: {
    fontSize: 15,
    color: '#00ae66',
    fontWeight: '600',
  },
  
  // 输入 Modal 样式
  inputModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  inputModalContainer: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '100%',
    maxWidth: 320,
  },
  inputModalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#222',
    marginBottom: 16,
    textAlign: 'center',
  },
  inputModalInput: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#222',
    marginBottom: 16,
  },
  inputModalButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  inputModalBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  inputModalBtnCancel: {
    backgroundColor: '#f5f5f8',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  inputModalBtnConfirm: {
    backgroundColor: '#00ae66',
  },
  inputModalBtnTextCancel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  inputModalBtnTextConfirm: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
});
