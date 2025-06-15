export type AgentEventType = 'FAVORITES_THRESHOLD' | 'FOLDER_THRESHOLD_REACHED';

export type AgentEventPayloadMap = {
  FAVORITES_THRESHOLD: { count: number };
  FOLDER_THRESHOLD_REACHED: { folderId: string; folderName: string; count: number };
};

export type AgentEvent<T extends AgentEventType = AgentEventType> = {
  type: T;
  data: AgentEventPayloadMap[T];
  ts: number;
};

type AgentEventCallback = (event: AgentEvent) => void;

const subscribers = new Set<AgentEventCallback>();

export function onAgentEvent(callback: AgentEventCallback): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export function emitAgentEvent<T extends AgentEventType>(type: T, data: AgentEventPayloadMap[T]): void {
  const event: AgentEvent<T> = {
    type,
    data,
    ts: Date.now(),
  };
  subscribers.forEach((cb) => {
    try {
      cb(event);
    } catch (error) {
      console.warn('[AgentEvents] subscriber error:', error);
    }
  });
}

