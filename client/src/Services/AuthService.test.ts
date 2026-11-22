import axios from 'axios';
import { devSignIn, signIn } from './AuthService';
import { readSession } from '../utils/session';
import { httpError, networkError } from '../test/axios';
import { makeToken } from '../test/tokens';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, post: vi.fn() } };
});

const post = vi.mocked(axios.post);

beforeEach(() => {
  localStorage.clear();
  post.mockReset();
});

test('200 saves the session and returns ok', async () => {
  post.mockResolvedValue({ data: { margeToken: makeToken() } });
  await expect(signIn('the-code')).resolves.toBe('ok');
  expect(post).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/auth\/google\/signin$/), {
    code: 'the-code',
  });
  expect(readSession()?.email).toBe('brian@playola.fm');
});

test('403 not_approved returns not_approved', async () => {
  post.mockRejectedValue(httpError(403, { error: 'not_approved' }));
  await expect(signIn('c')).resolves.toBe('not_approved');
  expect(readSession()).toBeNull();
});

test.each([
  ['401', httpError(401, { error: 'sign_in_failed' })],
  ['500', httpError(500, { error: 'internal_error' })],
  ['a network error', networkError()],
])('%s returns failed', async (_label, error) => {
  post.mockRejectedValue(error);
  await expect(signIn('c')).resolves.toBe('failed');
  expect(readSession()).toBeNull();
});

test('devSignIn posts to /v1/auth/dev-login and saves the returned session', async () => {
  post.mockResolvedValue({ data: { margeToken: makeToken({ email: 'dev@marge.local' }) } });
  await devSignIn();
  expect(post).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/auth\/dev-login$/));
  expect(readSession()?.email).toBe('dev@marge.local');
});
