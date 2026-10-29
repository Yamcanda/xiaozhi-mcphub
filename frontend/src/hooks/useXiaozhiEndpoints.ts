import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiResponse } from '../types/index.js';
import { useToast } from '../contexts/ToastContext.js';
import { apiGet, apiPost, apiPut, apiDelete } from '../utils/fetchInterceptor.js';
import type { XiaozhiEndpoint, XiaozhiEndpointStatus } from '../../../src/types/xiaozhi.js';

export type { XiaozhiEndpoint, XiaozhiEndpointStatus } from '../../../src/types/xiaozhi.js';

export interface XiaozhiConfig {
  enabled: boolean;
  endpoints: XiaozhiEndpoint[];
  webSocketUrl?: string; // 向后兼容字段
  reconnect?: XiaozhiEndpoint['reconnect'];
}

export interface CreateEndpointData {
  name: string;
  webSocketUrl: string;
  description?: string;
  groupId?: string;
  useSmartRouting?: boolean;
}

export type UpdateEndpointData = Partial<Omit<XiaozhiEndpoint, 'id' | 'createdAt'>>;

export const useXiaozhiEndpoints = () => {
  const { t } = useTranslation();
  const { showToast } = useToast();

  // 状态管理
  const [config, setConfig] = useState<XiaozhiConfig>({
    enabled: false,
    endpoints: [],
  });
  const [endpoints, setEndpoints] = useState<XiaozhiEndpoint[]>([]);
  const [endpointStatuses, setEndpointStatuses] = useState<XiaozhiEndpointStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [reconnectingEndpoints, setReconnectingEndpoints] = useState<Set<string>>(new Set());
  const [statusError, setStatusError] = useState(false);
  const statusRequest = useRef(0);
  const appliedStatusRequest = useRef(0);
  const statusGeneration = useRef(0);
  const statusExpiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 触发刷新
  const triggerRefresh = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  // 获取小智配置（包含兼容数据）
  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response: ApiResponse<XiaozhiConfig> = await apiGet('/xiaozhi/config');

      if (response.success && response.data) {
        setConfig(response.data);
        // 更新端点列表
        if (response.data.endpoints) {
          setEndpoints(response.data.endpoints);
        }
      } else {
        throw new Error(response.message || 'Failed to fetch xiaozhi config');
      }
    } catch (error) {
      console.error('Failed to fetch xiaozhi config:', error);
      setError(error instanceof Error ? error.message : 'Failed to fetch xiaozhi config');
      showToast(t('errors.failedToFetchXiaozhiConfig', 'Failed to fetch Xiaozhi configuration'));
    } finally {
      setLoading(false);
    }
  }, [t, showToast]);

  // 获取所有端点
  const fetchEndpoints = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response: ApiResponse<XiaozhiEndpoint[]> = await apiGet('/xiaozhi/endpoints');

      if (response.success && response.data) {
        setEndpoints(response.data);
      } else {
        throw new Error(response.message || 'Failed to fetch endpoints');
      }
    } catch (error) {
      console.error('Failed to fetch endpoints:', error);
      setError(error instanceof Error ? error.message : 'Failed to fetch endpoints');
      showToast(t('errors.failedToFetchEndpoints', 'Failed to fetch endpoints'));
    } finally {
      setLoading(false);
    }
  }, [t, showToast]);

  // Never present a failed or stale status sample as a live connection.
  const fetchEndpointStatuses = useCallback(async () => {
    const request = ++statusRequest.current;
    const generation = statusGeneration.current;
    // A newer pending poll must not starve slower successful responses.
    const canApply = () =>
      generation === statusGeneration.current && request > appliedStatusRequest.current;
    try {
      const response = await apiGet<ApiResponse<XiaozhiEndpointStatus[]>>(
        '/xiaozhi/endpoints/status/all',
        { cache: 'no-store', signal: AbortSignal.timeout(10000) },
      );
      if (!canApply()) return;
      if (!response.success || !response.data) throw new Error('Status unavailable');
      appliedStatusRequest.current = request;
      setEndpointStatuses(response.data);
      setStatusError(false);
      clearTimeout(statusExpiry.current);
      statusExpiry.current = setTimeout(() => {
        setEndpointStatuses([]);
        setStatusError(true);
      }, 15000);
    } catch {
      if (!canApply()) return;
      appliedStatusRequest.current = request;
      clearTimeout(statusExpiry.current);
      setEndpointStatuses([]);
      setStatusError(true);
    }
  }, []);

  useEffect(
    () => () => {
      statusGeneration.current++;
      clearTimeout(statusExpiry.current);
    },
    [],
  );

  // 创建端点
  const createEndpoint = useCallback(
    async (endpointData: CreateEndpointData): Promise<boolean> => {
      setLoading(true);
      setError(null);

      try {
        const response: ApiResponse<XiaozhiEndpoint> = await apiPost(
          '/xiaozhi/endpoints',
          endpointData,
        );

        if (response.success && response.data) {
          setEndpoints((prev) => [...prev, response.data!]);
          showToast(t('settings.endpointCreated', 'Endpoint created successfully'));
          triggerRefresh();
          return true;
        } else {
          throw new Error(response.message || 'Failed to create endpoint');
        }
      } catch (error) {
        console.error('Failed to create endpoint:', error);
        const errorMessage = error instanceof Error ? error.message : 'Failed to create endpoint';
        setError(errorMessage);
        showToast(t('errors.failedToCreateEndpoint', 'Failed to create endpoint'));
        return false;
      } finally {
        setLoading(false);
      }
    },
    [t, showToast, triggerRefresh],
  );

  // 更新端点
  const updateEndpoint = useCallback(
    async (endpointId: string, updateData: UpdateEndpointData): Promise<boolean> => {
      setLoading(true);
      setError(null);

      try {
        const response: ApiResponse<XiaozhiEndpoint> = await apiPut(
          `/xiaozhi/endpoints/${endpointId}`,
          updateData,
        );

        if (response.success && response.data) {
          setEndpoints((prev) => prev.map((ep) => (ep.id === endpointId ? response.data! : ep)));
          showToast(t('api.success.endpointUpdated', 'Endpoint updated successfully'));
          triggerRefresh();
          return true;
        } else {
          throw new Error(response.message || 'Failed to update endpoint');
        }
      } catch (error) {
        console.error('Failed to update endpoint:', error);
        const errorMessage = error instanceof Error ? error.message : 'Failed to update endpoint';
        setError(errorMessage);
        showToast(t('errors.failedToUpdateEndpoint', 'Failed to update endpoint'));
        return false;
      } finally {
        setLoading(false);
      }
    },
    [t, showToast, triggerRefresh],
  );

  // 删除端点
  const deleteEndpoint = useCallback(
    async (endpointId: string): Promise<boolean> => {
      setLoading(true);
      setError(null);

      try {
        const response: ApiResponse<any> = await apiDelete(`/xiaozhi/endpoints/${endpointId}`);

        if (response.success) {
          setEndpoints((prev) => prev.filter((ep) => ep.id !== endpointId));
          showToast(t('settings.endpointDeleted', 'Endpoint deleted successfully'));
          triggerRefresh();
          return true;
        } else {
          throw new Error(response.message || 'Failed to delete endpoint');
        }
      } catch (error) {
        console.error('Failed to delete endpoint:', error);
        const errorMessage = error instanceof Error ? error.message : 'Failed to delete endpoint';
        setError(errorMessage);
        showToast(t('errors.failedToDeleteEndpoint', 'Failed to delete endpoint'));
        return false;
      } finally {
        setLoading(false);
      }
    },
    [t, showToast, triggerRefresh],
  );

  // 重连端点
  const reconnectEndpoint = useCallback(
    async (endpointId: string): Promise<boolean> => {
      // 检查是否已在重连中
      if (reconnectingEndpoints.has(endpointId)) {
        return false;
      }

      // 设置重连状态
      setReconnectingEndpoints((prev) => new Set(prev).add(endpointId));
      setError(null);

      try {
        const response: ApiResponse<any> = await apiPost(
          `/xiaozhi/endpoints/${endpointId}/reconnect`,
          {},
        );

        if (response.success) {
          showToast(t('settings.endpointReconnecting', 'Endpoint reconnection initiated'));

          // The shared status poll owns freshness and reconnect completion.
          await fetchEndpointStatuses();
          return true;
        } else {
          throw new Error(response.message || 'Failed to reconnect endpoint');
        }
      } catch (error) {
        console.error('Failed to reconnect endpoint:', error);
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to reconnect endpoint';
        setError(errorMessage);
        showToast(t('errors.failedToReconnectEndpoint', 'Failed to reconnect endpoint'));

        // 发生错误时立即解除重连状态
        setReconnectingEndpoints((prev) => {
          const newSet = new Set(prev);
          newSet.delete(endpointId);
          return newSet;
        });

        return false;
      }
    },
    [t, showToast, reconnectingEndpoints, fetchEndpointStatuses],
  );

  useEffect(() => {
    setReconnectingEndpoints((previous) => {
      const pending = new Set(
        [...previous].filter(
          (id) => !endpointStatuses.some((status) => status.endpoint.id === id && status.connected),
        ),
      );
      return pending.size === previous.size ? previous : pending;
    });
  }, [endpointStatuses]);

  useEffect(() => {
    if (reconnectingEndpoints.size === 0) return;
    const timeout = setTimeout(() => setReconnectingEndpoints(new Set()), 30000);
    return () => clearTimeout(timeout);
  }, [reconnectingEndpoints]);

  // 更新小智总配置（启用/禁用）
  const updateConfig = useCallback(
    async (configData: Partial<XiaozhiConfig>): Promise<boolean> => {
      setLoading(true);
      setError(null);

      try {
        const response: ApiResponse<any> = await apiPut('/xiaozhi/config', configData);

        if (response.success) {
          setConfig((prev) => ({ ...prev, ...configData }));
          showToast(t('api.success.xiaozhiConfigUpdated', 'Xiaozhi configuration updated'));
          triggerRefresh();
          return true;
        } else {
          throw new Error(response.message || 'Failed to update config');
        }
      } catch (error) {
        console.error('Failed to update xiaozhi config:', error);
        const errorMessage = error instanceof Error ? error.message : 'Failed to update config';
        setError(errorMessage);
        showToast(
          t('errors.failedToUpdateXiaozhiConfig', 'Failed to update Xiaozhi configuration'),
        );
        return false;
      } finally {
        setLoading(false);
      }
    },
    [t, showToast, triggerRefresh],
  );

  // 根据ID获取端点
  const getEndpointById = useCallback(
    (endpointId: string): XiaozhiEndpoint | undefined => {
      return endpoints.find((ep) => ep.id === endpointId);
    },
    [endpoints],
  );

  // 获取端点详情（完整URL用于编辑）
  const fetchEndpointDetails = useCallback(
    async (endpointId: string): Promise<XiaozhiEndpoint | null> => {
      try {
        const response: ApiResponse<XiaozhiEndpoint> = await apiGet(
          `/xiaozhi/endpoints/${endpointId}`,
        );

        if (response.success && response.data) {
          return response.data;
        } else {
          throw new Error(response.message || 'Failed to fetch endpoint details');
        }
      } catch (error) {
        console.error('Failed to fetch endpoint details:', error);
        showToast(t('errors.failedToFetchEndpoints', 'Failed to fetch endpoint details'));
        return null;
      }
    },
    [t, showToast],
  );

  // 根据ID获取端点状态
  const getEndpointStatusById = useCallback(
    (endpointId: string): XiaozhiEndpointStatus | undefined => {
      return endpointStatuses.find((status) => status.endpoint.id === endpointId);
    },
    [endpointStatuses],
  );

  // 获取连接的端点数量
  const getConnectedCount = useCallback((): number => {
    return endpoints.filter(
      (endpoint) =>
        endpoint.enabled &&
        endpointStatuses.some((status) => status.endpoint.id === endpoint.id && status.connected),
    ).length;
  }, [endpoints, endpointStatuses]);

  // 获取启用的端点数量
  const getEnabledCount = useCallback((): number => {
    return endpoints.filter((ep) => ep.enabled).length;
  }, [endpoints]);

  // 检查端点是否正在重连
  const isEndpointReconnecting = useCallback(
    (endpointId: string): boolean => {
      return reconnectingEndpoints.has(endpointId);
    },
    [reconnectingEndpoints],
  );

  // 初始化和定期刷新
  useEffect(() => {
    fetchConfig();
    fetchEndpoints();
    fetchEndpointStatuses();
  }, [fetchConfig, fetchEndpoints, fetchEndpointStatuses, refreshKey]);

  // 定期刷新端点状态
  useEffect(() => {
    const interval = setInterval(() => {
      fetchEndpointStatuses();
    }, 5000); // 每5秒刷新一次状态

    return () => clearInterval(interval);
  }, [fetchEndpointStatuses]);

  return {
    // 数据
    config,
    endpoints,
    endpointStatuses,
    statusError,
    loading,
    error,

    // 操作方法
    fetchConfig,
    fetchEndpoints,
    fetchEndpointStatuses,
    createEndpoint,
    updateEndpoint,
    deleteEndpoint,
    reconnectEndpoint,
    updateConfig,
    triggerRefresh,

    // 辅助方法
    getEndpointById,
    fetchEndpointDetails,
    getEndpointStatusById,
    getConnectedCount,
    getEnabledCount,
    isEndpointReconnecting,

    // 状态管理
    setError,
  };
};
