/**
 * 浮动搜索球状态管理
 * 
 * 三种状态：
 * - collapsed: 收起状态（只显示图标）
 * - expanded: 展开状态（显示完整内容）
 * - hidden: 隐藏状态（完全不显示）
 */

export type FloatingBallState = 'collapsed' | 'expanded' | 'hidden';

export type FloatingBallContent = {
  type: 'comparison' | 'verification' | 'info';
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

// 全局状态（简单实现，不依赖外部库）
class FloatingBallManager {
  private state: FloatingBallState = 'hidden';
  private content: FloatingBallContent | null = null;
  private autoCollapseTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<() => void> = new Set();

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    this.listeners.forEach(listener => listener());
  }

  getState(): FloatingBallState {
    return this.state;
  }

  getContent(): FloatingBallContent | null {
    return this.content;
  }

  show(content: FloatingBallContent) {
    // 清除之前的定时器
    if (this.autoCollapseTimer) {
      clearTimeout(this.autoCollapseTimer);
    }

    // 显示并展开
    this.state = 'expanded';
    this.content = content;
    this.notify();

    // 3秒后自动收起
    this.autoCollapseTimer = setTimeout(() => {
      this.state = 'collapsed';
      this.autoCollapseTimer = null;
      this.notify();
    }, 3000);
  }

  expand() {
    // 清除自动收起定时器
    if (this.autoCollapseTimer) {
      clearTimeout(this.autoCollapseTimer);
      this.autoCollapseTimer = null;
    }

    this.state = 'expanded';
    this.notify();

    // 重新设置3秒后自动收起
    this.autoCollapseTimer = setTimeout(() => {
      this.state = 'collapsed';
      this.autoCollapseTimer = null;
      this.notify();
    }, 3000);
  }

  collapse() {
    if (this.autoCollapseTimer) {
      clearTimeout(this.autoCollapseTimer);
      this.autoCollapseTimer = null;
    }

    this.state = 'collapsed';
    this.notify();
  }

  hide() {
    if (this.autoCollapseTimer) {
      clearTimeout(this.autoCollapseTimer);
      this.autoCollapseTimer = null;
    }

    this.state = 'hidden';
    this.notify();
  }

  clearContent() {
    if (this.autoCollapseTimer) {
      clearTimeout(this.autoCollapseTimer);
      this.autoCollapseTimer = null;
    }

    this.state = 'hidden';
    this.content = null;
    this.notify();
  }
}

export const floatingBallManager = new FloatingBallManager();

// 便捷方法：显示对比结果
export function showComparisonResult(count: number, platforms: string[]) {
  floatingBallManager.show({
    type: 'comparison',
    title: '跨平台对比',
    message: `在 ${platforms.join('、')} 找到 ${count} 个相似房源`,
    actionLabel: '查看详情',
  });
}

// 便捷方法：显示验证提示
export function showVerificationPrompt(platform: string) {
  floatingBallManager.show({
    type: 'verification',
    title: '需要验证',
    message: `${platform} 需要完成人机验证`,
    actionLabel: '去验证',
  });
}

// 便捷方法：显示信息提示
export function showInfoMessage(title: string, message: string) {
  floatingBallManager.show({
    type: 'info',
    title,
    message,
  });
}
