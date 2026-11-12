import type { Tool } from './tool.js';

/** Xiaozhi endpoint configuration shared by the backend and dashboard. */
export interface XiaozhiEndpoint {
  id: string;
  name: string;
  enabled: boolean;
  webSocketUrl: string;
  description?: string;
  groupId?: string;
  useSmartRouting?: boolean;
  owner?: string;
  reconnect: {
    maxAttempts: number;
    infiniteReconnect?: boolean;
    infiniteRetryDelay?: number;
    initialDelay: number;
    maxDelay: number;
    backoffMultiplier: number;
  };
  createdAt: string;
  lastConnected?: string;
  status?: 'connected' | 'disconnected' | 'connecting';
}

/** Live reconnect / connection diagnostics for one endpoint. */
export interface XiaozhiEndpointRuntime {
  reconnectAttempts: number;
  infiniteRetryCount: number;
  isInInfiniteReconnectMode: boolean;
  isInSleepMode: boolean;
  lastError?: string;
  lastCloseCode?: number;
  lastCloseReason?: string;
  /** ISO time of the last close event, retained across reconnects */
  lastCloseAt?: string;
  /** ISO time of the last WebSocket control-frame pong on the current socket */
  lastPongAt?: string;
  /** Successful tools/list response write, not an acknowledgement from the platform */
  toolsListSentAt?: string;
  /** ISO time when the next reconnect is scheduled, if any */
  nextReconnectAt?: string;
  /** ISO time when the current socket opened */
  connectedAt?: string;
  /** Seconds the current socket has been open */
  uptimeSeconds?: number;
}

export interface XiaozhiEndpointStatus {
  endpoint: XiaozhiEndpoint;
  connected: boolean;
  connectionCount: number;
  tools?: Tool[];
  lastConnected?: string;
  error?: string;
  runtime?: XiaozhiEndpointRuntime;
}

/** Compact Xiaozhi slice for GET /health */
export interface XiaozhiHealthSummary {
  /** False when DB is off / Xiaozhi subsystem unavailable */
  available: boolean;
  enabledTotal: number;
  connected: number;
  disconnected: number;
  pendingReconnects: number;
}

export interface XiaozhiConfig {
  /**
   * Legacy global flag kept for admin diagnostics only.
   * Connections are gated solely by each endpoint.enabled.
   */
  enabled: boolean;
  endpoints: XiaozhiEndpoint[];
  loadBalancing?: {
    enabled: boolean;
    strategy: 'round-robin' | 'random' | 'least-connections';
  };
}
