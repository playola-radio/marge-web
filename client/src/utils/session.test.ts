import { clearSession, readSession, saveSession } from './session';
import { expiredToken, makeToken } from '../test/tokens';

beforeEach(() => localStorage.clear());

test('saveSession then readSession returns the email, name and exp', () => {
  const token = makeToken({ exp: 4_000_000_000 });
  saveSession(token);
  expect(readSession()).toEqual({
    email: 'brian@playola.fm',
    name: 'Brian Keane',
    exp: 4_000_000_000,
  });
});

test('an expired token with an unexpired user value returns null and clears both keys', () => {
  localStorage.setItem('token', expiredToken());
  localStorage.setItem('user', JSON.stringify({ email: 'a@b.c', name: 'A', exp: 4_000_000_000 }));
  expect(readSession()).toBeNull();
  expect(localStorage.getItem('token')).toBeNull();
  expect(localStorage.getItem('user')).toBeNull();
});

test('a user value with a different email than the token returns the token email', () => {
  localStorage.setItem('token', makeToken({ email: 'token@playola.fm' }));
  localStorage.setItem('user', JSON.stringify({ email: 'other@playola.fm', name: 'Other' }));
  expect(readSession()?.email).toBe('token@playola.fm');
});

test('an expired token returns null and clears both keys', () => {
  saveSession(expiredToken());
  expect(readSession()).toBeNull();
  expect(localStorage.length).toBe(0);
});

test('a valid token with garbage under user still returns the token claims', () => {
  localStorage.setItem('token', makeToken({ exp: 4_000_000_000 }));
  localStorage.setItem('user', 'not json{');
  expect(readSession()).toEqual({
    email: 'brian@playola.fm',
    name: 'Brian Keane',
    exp: 4_000_000_000,
  });
});

test('an undecodable token returns null and clears both keys', () => {
  localStorage.setItem('token', 'garbage');
  localStorage.setItem('user', '{}');
  expect(readSession()).toBeNull();
  expect(localStorage.length).toBe(0);
});

test('clearSession removes both keys', () => {
  saveSession(makeToken());
  clearSession();
  expect(localStorage.getItem('token')).toBeNull();
  expect(localStorage.getItem('user')).toBeNull();
});
