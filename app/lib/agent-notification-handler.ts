/**
 * Agent notification handler
 * Manages notification display and background processing for Agent recommendations
 */

import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import type { AgentEvent } from './agent-events';
import { notificationState } from './notification-state';

/**
 * Hook to handle Agent events and show notifications when user is not on chat screen
 */
export function useAgentNotificationHandler(
  onEvent: (event: AgentEvent) => void,
  isProcessing: boolean
) {
  const pathname = usePathname();
  const isOnChatScreen = pathname === '/chat' || pathname.includes('/(tabs)/chat');
  const processingRef = useRef(false);

  useEffect(() => {
    processingRef.current = isProcessing;
  }, [isProcessing]);

  /**
   * Wrapped event handler that shows notifications for background events
   */
  const handleEventWithNotification = (event: AgentEvent) => {
    // Always call the original handler
    onEvent(event);

    // Show notification if user is not on chat screen and Agent is processing
    if (event.type === 'FOLDER_THRESHOLD_REACHED' && !isOnChatScreen) {
      const { folderName } = event.data as { folderId: string; folderName: string; count: number };
      
      notificationState.showNotification({
        id: `folder-${event.ts}`,
        message: `AI 正在为您分析「${folderName}」收藏夹的偏好并推荐房源`,
        timestamp: event.ts,
        folderName,
      });
    }
  };

  /**
   * Dismiss notification when user navigates to chat screen
   */
  useEffect(() => {
    if (isOnChatScreen) {
      notificationState.dismissNotification();
    }
  }, [isOnChatScreen]);

  return handleEventWithNotification;
}

/**
 * Dismiss notification when Agent completes processing
 */
export function dismissNotificationOnComplete(wasProcessing: boolean, isProcessing: boolean) {
  // If processing just finished, dismiss notification after a short delay
  if (wasProcessing && !isProcessing) {
    setTimeout(() => {
      notificationState.dismissNotification();
    }, 2000);
  }
}
