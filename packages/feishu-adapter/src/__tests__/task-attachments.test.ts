import { describe, it, expect } from 'vitest';
import type { NormalizedEvent } from '@open-tag/core-types';
import { deriveFeishuTaskAttachments } from '../task-attachments.js';

function makeEvent(content: NormalizedEvent['content']): NormalizedEvent {
  return {
    eventId: 'evt_1',
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'group',
    senderOpenId: 'ou_1',
    tenantKey: 'tenant_1',
    content,
    timestamp: 1710000000000,
  };
}

describe('deriveFeishuTaskAttachments', () => {
  it('derives the current image attachment when type/imageKey/imageMessageId are all present', () => {
    const result = deriveFeishuTaskAttachments(
      makeEvent({ type: 'image', imageKey: 'img_k', imageMessageId: 'om_img', raw: {} }),
    );
    expect(result.imageAttachment).toEqual({ imageKey: 'img_k', messageId: 'om_img' });
    expect(result.fileAttachment).toBeUndefined();
  });

  it('returns no image attachment when imageMessageId is missing (strict guard, no fallback)', () => {
    const result = deriveFeishuTaskAttachments(
      makeEvent({ type: 'image', imageKey: 'img_k', raw: {} }),
    );
    expect(result.imageAttachment).toBeUndefined();
  });

  it('falls back to the first referenced image attachment when there is no current image', () => {
    const result = deriveFeishuTaskAttachments(
      makeEvent({
        type: 'text',
        text: 'analyze the quoted image',
        referencedMessages: [
          { messageId: 'om_ref', contentType: 'image', entries: [], imageAttachment: { imageKey: 'img_ref', messageId: 'om_ref' } },
        ],
        raw: {},
      }),
    );
    expect(result.imageAttachment).toEqual({ imageKey: 'img_ref', messageId: 'om_ref' });
  });

  it('prefers the current image over a referenced image', () => {
    const result = deriveFeishuTaskAttachments(
      makeEvent({
        type: 'image',
        imageKey: 'img_current',
        imageMessageId: 'om_current',
        referencedMessages: [
          { messageId: 'om_ref', contentType: 'image', entries: [], imageAttachment: { imageKey: 'img_ref', messageId: 'om_ref' } },
        ],
        raw: {},
      }),
    );
    expect(result.imageAttachment).toEqual({ imageKey: 'img_current', messageId: 'om_current' });
  });

  it('derives the file attachment verbatim, preserving resourceType "media"', () => {
    const fileAttachment = {
      resourceKey: 'file_k',
      messageId: 'om_file',
      resourceType: 'media' as const,
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
    };
    const result = deriveFeishuTaskAttachments(
      makeEvent({ type: 'file', fileAttachment, raw: {} }),
    );
    expect(result.fileAttachment).toEqual(fileAttachment);
  });

  it('does not carry a fileAttachment when the content type is not file', () => {
    const result = deriveFeishuTaskAttachments(
      makeEvent({
        type: 'text',
        text: 'has a file blob but is a text message',
        fileAttachment: { resourceKey: 'file_k', messageId: 'om_file', resourceType: 'file' },
        raw: {},
      }),
    );
    expect(result.fileAttachment).toBeUndefined();
  });
});
