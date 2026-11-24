import axios, {AxiosError, type AxiosResponse} from 'axios';
import type {ApiError, ResponseData} from '@/api/types';
import {useAuthStore} from '@/stores/auth';

export const http = axios.create({
  baseURL: '/api',
  timeout: 30_000,
  withCredentials: true,
  headers: {
    'X-Requested-With': 'XMLHttpRequest',
  },
});

http.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

http.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: unknown) => {
    if (error instanceof AxiosError) {
      const status = error.response?.status ?? 0;
      const data = error.response?.data as Partial<ResponseData<unknown>> | undefined;
      const code = typeof data?.code === 'string' ? data.code : status ? 'HTTP_ERROR' : 'NETWORK_ERROR';
      const message =
        typeof data?.message === 'string'
          ? data.message
          : status
            ? `خطأ في الخادم (${status})`
            : 'تعذر الاتصال بالخادم';

      if (status === 401 && useAuthStore.getState().status === 'authenticated') {
        useAuthStore.getState().clearSession(false);
      }

      const apiErr: ApiError = {status, code, message};
      return Promise.reject(apiErr);
    }

    const fallback: ApiError = {
      status: 0,
      code: 'UNKNOWN',
      message: error instanceof Error ? error.message : String(error),
    };
    return Promise.reject(fallback);
  },
);

export function toApiError(error: unknown): ApiError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    'code' in error &&
    'message' in error
  ) {
    return error as ApiError;
  }
  return {
    status: 0,
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function unwrapApiResults<T>(payload: unknown, status = 502): T {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    const invalidErr: ApiError = {
      status,
      code: 'INVALID_RESPONSE',
      message: 'استجابة غير صالحة من الخادم، يرجى تحديث الصفحة والمحاولة مجددًا',
    };
    throw invalidErr;
  }

  const envelope = payload as Partial<ResponseData<T>> & Record<string, unknown>;
  if (typeof envelope.code !== 'string' && !('results' in envelope)) {
    const invalidErr: ApiError = {
      status,
      code: 'INVALID_RESPONSE',
      message: 'استجابة غير صالحة من الخادم، يرجى تحديث الصفحة والمحاولة مجددًا',
    };
    throw invalidErr;
  }

  return (envelope.results ?? null) as T;
}

export async function results<T>(request: Promise<AxiosResponse<ResponseData<T>>>): Promise<T> {
  const response = await request;
  return unwrapApiResults<T>(response.data, response.status);
}
