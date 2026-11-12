import type { Request, Response } from 'express';
import type { XiaozhiEndpoint, XiaozhiEndpointStatus } from '../../src/types/xiaozhi.js';

const getEndpointById = jest.fn();
const getEndpointStatus = jest.fn();
const getEndpointsForUser = jest.fn();
const getAllEndpointsStatus = jest.fn();

jest.mock('../../src/services/xiaozhiEndpointService.js', () => ({
  xiaozhiEndpointService: {
    getEndpointById,
    getEndpointStatus,
    getEndpointsForUser,
    getAllEndpointsStatus,
  },
}));
jest.mock('../../src/db/repositories/index.js', () => ({}));
jest.mock('../../src/dao/index.js', () => ({}));

import {
  getXiaozhiEndpointStatus,
  getAllXiaozhiEndpointStatus,
} from '../../src/controllers/xiaozhiController.js';

const endpoint: XiaozhiEndpoint = {
  id: 'local-fixture',
  name: 'Local fixture',
  owner: 'fixture-user',
  enabled: true,
  webSocketUrl: 'ws://127.0.0.1:1/fixture?token=fixture-token',
  reconnect: { maxAttempts: 10, initialDelay: 2000, maxDelay: 60000, backoffMultiplier: 2 },
  createdAt: '2026-01-01T00:00:00Z',
};
const status: XiaozhiEndpointStatus = {
  endpoint: { ...endpoint, status: 'disconnected' },
  connected: false,
  connectionCount: 1,
  runtime: {
    reconnectAttempts: 1,
    infiniteRetryCount: 0,
    isInInfiniteReconnectMode: false,
    isInSleepMode: false,
    lastCloseCode: 1009,
    lastCloseReason: 'fixture message too big',
    lastCloseAt: '2026-01-01T00:01:00Z',
  },
};
const request = (username = endpoint.owner, isAdmin = false) =>
  ({ params: { id: endpoint.id }, user: { username, isAdmin } }) as unknown as Request;
const response = () => {
  const res: Partial<Response> = {};
  res.setHeader = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

beforeEach(() => {
  getEndpointById.mockReset().mockReturnValue(endpoint);
  getEndpointStatus.mockReset().mockReturnValue(status);
  getEndpointsForUser.mockReset().mockReturnValue([endpoint]);
  getAllEndpointsStatus.mockReset().mockReturnValue([status]);
});

it('returns uncached live status with close diagnostics and a masked endpoint URL', () => {
  const res = response();
  getXiaozhiEndpointStatus(request(), res);
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(res.json).toHaveBeenCalledWith({
    success: true,
    data: {
      ...status,
      endpoint: { ...status.endpoint, webSocketUrl: 'ws://127.0.0.1:1/fixture?token=***' },
    },
  });
});

it('filters uncached status lists to visible endpoints without dropping runtime diagnostics', () => {
  const other = { ...status, endpoint: { ...endpoint, id: 'other-fixture', owner: 'other-user' } };
  getAllEndpointsStatus.mockReturnValue([status, other]);
  const res = response();
  getAllXiaozhiEndpointStatus(request(), res);
  expect(getEndpointsForUser).toHaveBeenCalledWith('fixture-user', false);
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(res.json).toHaveBeenCalledWith({
    success: true,
    data: [
      {
        ...status,
        endpoint: { ...status.endpoint, webSocketUrl: 'ws://127.0.0.1:1/fixture?token=***' },
      },
    ],
  });
});

it('does not expose another owner’s endpoint through the single status route', () => {
  const res = response();
  getXiaozhiEndpointStatus(request('other-user'), res);
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(res.status).toHaveBeenCalledWith(404);
  expect(getEndpointStatus).not.toHaveBeenCalled();
});

it('allows an administrator to inspect an endpoint owned by another user', () => {
  const res = response();
  getXiaozhiEndpointStatus(request('fixture-admin', true), res);
  expect(getEndpointStatus).toHaveBeenCalledWith(endpoint.id);
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
});

it('also forbids caching failed status responses', () => {
  getAllEndpointsStatus.mockImplementation(() => {
    throw new Error('Fixture status unavailable');
  });
  const res = response();
  getAllXiaozhiEndpointStatus(request(), res);
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Server error' });
});
