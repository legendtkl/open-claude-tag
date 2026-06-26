import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseNotesView, type ReleaseNotesViewLabels } from './ReleaseNotes';
import { releaseNotes, type ReleaseNote } from './release-notes';

const labels: ReleaseNotesViewLabels = {
  enhancements: 'Core enhancements',
  fixes: 'Bug fixes',
  empty: 'No release notes yet.',
};

const NOTES: ReleaseNote[] = [
  {
    version: '2.0.0',
    date: '2026-07-01',
    highlights: [{ zh: '增强甲', en: 'Enhance A' }],
    fixes: [{ zh: '修复乙', en: 'Fix B' }],
  },
  {
    version: '1.0.0',
    date: '2026-06-01',
    highlights: [],
    fixes: [{ zh: '仅修复', en: 'Fix only' }],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReleaseNotesView', () => {
  it('renders as a plain page, not a modal dialog', () => {
    render(<ReleaseNotesView locale="en" labels={labels} notes={NOTES} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('release-notes-backdrop')).toBeNull();
  });

  it('shows each release version and date in a toggle header', () => {
    render(<ReleaseNotesView locale="en" labels={labels} notes={NOTES} />);
    expect(screen.getByRole('button', { name: /2\.0\.0/ })).toBeInTheDocument();
    expect(screen.getByText('2026-07-01')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1\.0\.0/ })).toBeInTheDocument();
    expect(screen.getByText('2026-06-01')).toBeInTheDocument();
  });

  it('expands the latest version and collapses older ones by default', () => {
    render(<ReleaseNotesView locale="en" labels={labels} notes={NOTES} />);
    expect(screen.getByRole('button', { name: /2\.0\.0/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /1\.0\.0/ })).toHaveAttribute('aria-expanded', 'false');
    // Latest body visible, older body not rendered.
    expect(screen.getByText('Enhance A')).toBeInTheDocument();
    expect(screen.queryByText('Fix only')).toBeNull();
  });

  it('expands an older version when its header is activated, independently', () => {
    render(<ReleaseNotesView locale="en" labels={labels} notes={NOTES} />);
    const older = screen.getByRole('button', { name: /1\.0\.0/ });
    fireEvent.click(older);
    expect(older).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Fix only')).toBeInTheDocument();
    // The latest section stays expanded — toggling is independent.
    expect(screen.getByRole('button', { name: /2\.0\.0/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Enhance A')).toBeInTheDocument();
  });

  it('collapses the latest version when its header is activated', () => {
    render(<ReleaseNotesView locale="en" labels={labels} notes={NOTES} />);
    const latest = screen.getByRole('button', { name: /2\.0\.0/ });
    fireEvent.click(latest);
    expect(latest).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Enhance A')).toBeNull();
  });

  it('renders both grouped sections when an expanded release has enhancements and fixes', () => {
    render(<ReleaseNotesView locale="en" labels={labels} notes={[NOTES[0]]} />);
    expect(screen.getByText('Core enhancements')).toBeInTheDocument();
    expect(screen.getByText('Bug fixes')).toBeInTheDocument();
    expect(screen.getByText('Enhance A')).toBeInTheDocument();
    expect(screen.getByText('Fix B')).toBeInTheDocument();
  });

  it('omits the enhancements section for a release with no highlights', () => {
    render(<ReleaseNotesView locale="en" labels={labels} notes={NOTES} />);
    // Expand the older 1.0.0 entry, which has no highlights.
    fireEvent.click(screen.getByRole('button', { name: /1\.0\.0/ }));
    const region = screen.getByRole('region', { name: 'v1.0.0' });
    expect(within(region).queryByText('Core enhancements')).toBeNull();
    expect(within(region).getByText('Bug fixes')).toBeInTheDocument();
  });

  it('orders releases newest-first in the DOM', () => {
    const { container } = render(
      <ReleaseNotesView locale="en" labels={labels} notes={NOTES} />,
    );
    const html = container.innerHTML;
    expect(html.indexOf('2.0.0')).toBeLessThan(html.indexOf('1.0.0'));
  });

  it('renders bullet copy in the active language', () => {
    const { rerender } = render(
      <ReleaseNotesView locale="en" labels={labels} notes={[NOTES[0]]} />,
    );
    expect(screen.getByText('Enhance A')).toBeInTheDocument();
    expect(screen.queryByText('增强甲')).toBeNull();

    rerender(<ReleaseNotesView locale="zh" labels={labels} notes={[NOTES[0]]} />);
    expect(screen.getByText('增强甲')).toBeInTheDocument();
    expect(screen.queryByText('Enhance A')).toBeNull();
  });

  it('shows an empty state when there are no releases', () => {
    render(<ReleaseNotesView locale="en" labels={labels} notes={[]} />);
    expect(screen.getByText('No release notes yet.')).toBeInTheDocument();
  });

  it('shows the empty copy inside a version that has no enhancements and no fixes', () => {
    const blank: ReleaseNote = { version: '3.0.0', date: '2026-08-01', highlights: [], fixes: [] };
    render(<ReleaseNotesView locale="en" labels={labels} notes={[blank]} />);
    const region = screen.getByRole('region', { name: 'v3.0.0' });
    expect(within(region).getByText('No release notes yet.')).toBeInTheDocument();
    expect(within(region).queryByText('Core enhancements')).toBeNull();
    expect(within(region).queryByText('Bug fixes')).toBeNull();
  });

  it('ships real release-notes data with the latest version first', () => {
    expect(releaseNotes.length).toBeGreaterThan(0);
    expect(releaseNotes[0].version).toBe('1.0.5');
  });
});
