import { fireEvent, screen } from '@testing-library/react';
import { saveSession } from '../../utils/session';
import { renderApp } from '../../test/renderApp';
import { makeToken } from '../../test/tokens';

vi.mock('@react-oauth/google', () => import('../../test/googleOAuthMock'));

beforeEach(() => {
  localStorage.clear();
  saveSession(makeToken({ email: 'brian@playola.fm' }));
  renderApp('/home');
});

test('shows the stored email and the Marge image', () => {
  expect(screen.getByText('brian@playola.fm')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Marge' })).toBeInTheDocument();
});

test('the Software Factory link goes to /factory', () => {
  expect(screen.getByRole('link', { name: /software factory/i })).toHaveAttribute(
    'href',
    '/factory',
  );
});

test('Sign out clears localStorage and shows the landing page', () => {
  fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
  expect(localStorage.length).toBe(0);
  expect(window.location.pathname).toBe('/');
  expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
});
