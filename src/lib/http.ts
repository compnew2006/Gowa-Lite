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

const COOKIE_CHECK_COOLDOWN_MS = 15_000;
const COOKIE_CHECK_STORAGE_KEY = 'gowa-lite:proxy-cookie-check-at';

function isProxyCookieCheckPayload(payload: unknown, responseUrl?: string): boolean {
  if (responseUrl && /\/__cookie_check\.html/i.test(responseUrl)) {
    return true;
  }
  return (
    typeof payload === 'string' &&
    (/<title>\s*Cookie check\s*<\/title>/i.test(payload) || /verifyCanSetCookies/i.test(payload))
  );
}

function tryRecoverProxyCookieCheck(): void {
  if (typeof window === 'undefined') return;
  try {
    const last = Number(window.sessionStorage.getItem(COOKIE_CHECK_STORAGE_KEY) || '0');
    const now = Date.now();
    if (!Number.isFinite(last) || now - last > COOKIE_CHECK_COOLDOWN_MS) {
      window.sessionStorage.setItem(COOKIE_CHECK_STORAGE_KEY, String(now));
      window.location.replace(
        `/__cookie_check.html?return_url=${encodeURIComponent(window.location.href)}`,
      );
    }
  } catch {
    // Ignore storage access errors in restricted iframes
  }
}

http.interceptors.response.use(
  (response: AxiosResponse) => {
    const reqUrl =
      typeof (response.request as {responseURL?: unknown} | undefined)?.responseURL === 'string'
        ? (response.request as {responseURL: string}).responseURL
        : undefined;
    if (isProxyCookieCheckPayload(response.data, reqUrl)) {
      tryRecoverProxyCookieCheck();
      const proxyErr: ApiError = {
        status: 401,
        code: 'PROXY_COOKIE_CHECK',
        message:
          'بوابة المعاينة تطلب تأكيد ملفات تعريف الارتباط (Cookies). يرجى فتح رابط المعاينة في تبويب مستقل أو السماح بالـ Cookies ثم إعادة المحاولة.',
      };
      return Promise.reject(proxyErr);
    }
    return response;
  },
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
  if (isProxyCookieCheckPayload(payload)) {
    const proxyErr: ApiError = {
      status: 401,
      code: 'PROXY_COOKIE_CHECK',
      message:
        'بوابة المعاينة تطلب تأكيد ملفات تعريف الارتباط (Cookies). يرجى فتح رابط المعاينة في تبويب مستقل أو السماح بالـ Cookies ثم إعادة المحاولة.',
    };
    throw proxyErr;
  }

  if (typeof payload === 'string' && /<(?:!doctype|html)\b/i.test(payload)) {
    const htmlErr: ApiError = {
      status,
      code: 'INVALID_RESPONSE',
      message:
        'استجابة HTML غير متوقعة بدل JSON (قد تكون المهلة أو جلسة بوابة المعاينة انتهت) — يرجى تحديث الصفحة',
    };
    throw htmlErr;
  }

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
