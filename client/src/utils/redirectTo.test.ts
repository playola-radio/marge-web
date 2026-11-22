import { safeRedirectTo } from './redirectTo';

test('keeps /factory', () => {
  expect(safeRedirectTo('/factory')).toBe('/factory');
});

test('keeps /factory?x=1', () => {
  expect(safeRedirectTo('/factory?x=1')).toBe('/factory?x=1');
});

test.each(['//evil.com', '/\\evil.com', 'https://evil.com', '/', '/?redirectTo=/home', null, ''])(
  '%s falls back to /home',
  (value) => {
    expect(safeRedirectTo(value)).toBe('/home');
  },
);
