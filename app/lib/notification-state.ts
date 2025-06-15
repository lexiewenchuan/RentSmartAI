/**
 * Global notification state management for Agent recommendations
 * Manages notification visibility and navigation across the app
 */

type NotificationCallback = (notification: AgentNotification | null) => void;

export interface AgentNotification {
  id: string;
  message: string;
  timestamp: number;
  folderId?: string;
  folderName?: string;
}

class NotificationStateManager {
  private currentNotification: AgentNotification | null = null;
  private subscribers = new Set<NotificationCallback>();

  /**
   * Subscribe to notification state changes
   */
  subscribe(callback: NotificationCallback): () => void {
    this.subscribers.add(callback);
    // Immediately call with current state
    callback(this.currentNotification);
    
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Show a new notification
   */
  showNotification(notification: AgentNotification): void {
    this.currentNotification = notification;
    this.notifySubscribers();
  }

  /**
   * Dismiss the current notification
   */
  dismissNotification(): void {
    this.currentNotification = null;
    this.notifySubscribers();
  }

  /**
   * Get the current notification
   */
  getCurrentNotification(): AgentNotification | null {
    return this.currentNotification;
  }

  private notifySubscribers(): void {
    this.subscribers.forEach((callback) => {
      try {
        callback(this.currentNotification);
      } catch (error) {
        console.warn('[NotificationState] subscriber error:', error);
      }
    });
  }
}

export const notificationState = new NotificationStateManager();
