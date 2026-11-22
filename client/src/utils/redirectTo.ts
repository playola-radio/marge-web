const DEFAULT_REDIRECT = '/home';

export function safeRedirectTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return DEFAULT_REDIRECT;
  }
  const path = value.split(/[?#]/)[0];
  return path === '/' ? DEFAULT_REDIRECT : value;
}
