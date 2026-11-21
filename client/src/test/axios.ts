import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';

export function httpError(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  const response: AxiosResponse = { status, statusText: '', data, headers: {}, config };
  return new AxiosError(
    `Request failed with status ${status}`,
    'ERR_BAD_RESPONSE',
    config,
    null,
    response,
  );
}

export function networkError(): AxiosError {
  return new AxiosError('Network Error', 'ERR_NETWORK');
}
