import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('kaboom');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders children when they do not throw', () => {
    render(
      <ErrorBoundary>
        <p>ok content</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('ok content')).toBeInTheDocument();
  });

  it('renders a recoverable fallback with a reload action instead of crashing', () => {
    // React logs the caught error; silence it to keep test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      reload,
    } as Location);

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    const reloadButton = screen.getByRole('button', { name: /reload|刷新/i });
    fireEvent.click(reloadButton);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
