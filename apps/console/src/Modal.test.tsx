import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}}>
        <p>hidden</p>
      </Modal>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('hidden')).toBeNull();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} labelledBy="t">
        <h2 id="t">Title</h2>
        <button type="button">inside</button>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click but not on a click inside the dialog', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} labelledBy="t">
        <h2 id="t">Title</h2>
        <button type="button">inside</button>
      </Modal>,
    );
    // Click inside the dialog body — must NOT close.
    fireEvent.click(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
    // Click the backdrop itself — closes.
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the dialog on open and restores it on close', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { rerender } = render(
      <Modal open onClose={() => {}} labelledBy="t">
        <h2 id="t">Title</h2>
        <button type="button">first</button>
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByText('first'));

    // Closing restores focus to the previously-focused element.
    rerender(
      <Modal open={false} onClose={() => {}} labelledBy="t">
        <h2 id="t">Title</h2>
        <button type="button">first</button>
      </Modal>,
    );
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('focuses the dialog container when no child control is focusable', () => {
    render(
      <Modal open onClose={() => {}} labelledBy="t">
        <h2 id="t">Title</h2>
        <p>Only text</p>
      </Modal>,
    );

    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });
});
