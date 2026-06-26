import { appendFile, mkdir, writeFile } from 'fs/promises';
import { extname, join } from 'path';
import type { TaskSpec } from '@open-tag/core-types';
import { errorMessage } from '@open-tag/core-types';

type FileResourceType = NonNullable<TaskSpec['context']['fileAttachment']>['resourceType'];
type ImageAttachment = NonNullable<TaskSpec['context']['imageAttachment']>;

/** Minimal interface for downloading images from a messaging platform. */
export interface ImageDownloader {
  downloadImage(messageId: string, imageKey: string): Promise<Buffer>;
  downloadFile?(messageId: string, fileKey: string, resourceType?: FileResourceType): Promise<Buffer>;
}

interface ImageAttachmentLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export async function downloadImageAttachmentToWorkspace(input: {
  spec: TaskSpec;
  workspacePath: string;
  taskMdPath: string;
  imageDownloader?: ImageDownloader;
  logger: ImageAttachmentLogger;
}): Promise<string | undefined> {
  const paths = await downloadImageAttachmentsToWorkspace(input);
  return paths[0];
}

export function collectTaskImageAttachments(spec: TaskSpec): ImageAttachment[] {
  const attachments: ImageAttachment[] = [];
  if (spec.context.imageAttachment) attachments.push(spec.context.imageAttachment);
  for (const attachment of spec.context.imageAttachments ?? []) {
    attachments.push(attachment);
  }

  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const key = `${attachment.messageId}:${attachment.imageKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function downloadImageAttachmentsToWorkspace(input: {
  spec: TaskSpec;
  workspacePath: string;
  taskMdPath: string;
  imageDownloader?: ImageDownloader;
  logger: ImageAttachmentLogger;
}): Promise<string[]> {
  const imageAttachments = collectTaskImageAttachments(input.spec);
  if (imageAttachments.length === 0 || !input.imageDownloader) return [];

  const paths: string[] = [];
  for (const [index, imageAttachment] of imageAttachments.entries()) {
    try {
      const imageBuffer = await input.imageDownloader.downloadImage(
        imageAttachment.messageId,
        imageAttachment.imageKey,
      );
      const extension = detectImageFormat(imageBuffer).extension;
      const imageFileName =
        imageAttachments.length === 1 ? `image.${extension}` : `image-${index + 1}.${extension}`;
      const imagePath = join(input.workspacePath, imageFileName);
      await writeFile(imagePath, imageBuffer);
      await appendFile(input.taskMdPath, `\nImage: ./${imageFileName} (${input.spec.goal})\n`);
      input.logger.info(
        { taskId: input.spec.taskId, imageKey: imageAttachment.imageKey },
        'Image downloaded and saved to workspace',
      );
      paths.push(imagePath);
    } catch (err) {
      input.logger.warn(
        { taskId: input.spec.taskId, imageKey: imageAttachment.imageKey, err },
        'Failed to download image, continuing without it',
      );
    }
  }
  return paths;
}

export async function downloadFileAttachmentToWorkspace(input: {
  spec: TaskSpec;
  workspacePath: string;
  taskMdPath: string;
  imageDownloader?: ImageDownloader;
  logger: ImageAttachmentLogger;
}): Promise<string | undefined> {
  const fileAttachment = input.spec.context.fileAttachment;
  if (!fileAttachment) return undefined;

  if (!input.imageDownloader?.downloadFile) {
    await appendAttachmentWarning(input.taskMdPath, fileAttachment, 'no file downloader configured');
    input.logger.warn(
      { taskId: input.spec.taskId, resourceKey: fileAttachment.resourceKey },
      'File attachment could not be downloaded because no downloader is configured',
    );
    return undefined;
  }

  try {
    const fileBuffer = await input.imageDownloader.downloadFile(
      fileAttachment.messageId,
      fileAttachment.resourceKey,
      fileAttachment.resourceType,
    );
    const fileName = workspaceAttachmentFileName(fileAttachment);
    const relativePath = `attachments/${fileName}`;
    const filePath = join(input.workspacePath, 'attachments', fileName);
    await mkdir(join(input.workspacePath, 'attachments'), { recursive: true });
    await writeFile(filePath, fileBuffer, { flag: 'wx' });
    await appendFile(
      input.taskMdPath,
      `\nAttachment: ./${relativePath} (${fileAttachment.fileName ?? fileAttachment.resourceKey})\n`,
    );
    input.logger.info(
      { taskId: input.spec.taskId, resourceKey: fileAttachment.resourceKey },
      'File attachment downloaded and saved to workspace',
    );
    return filePath;
  } catch (err) {
    await appendAttachmentWarning(input.taskMdPath, fileAttachment, errorMessage(err));
    input.logger.warn(
      { taskId: input.spec.taskId, resourceKey: fileAttachment.resourceKey, err },
      'Failed to download file attachment, continuing without it',
    );
    return undefined;
  }
}

function sanitizeFileName(fileName: string | undefined): string | undefined {
  const sanitized = fileName
    ?.replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') return undefined;
  return sanitized.slice(0, 180);
}

function workspaceAttachmentFileName(
  fileAttachment: NonNullable<TaskSpec['context']['fileAttachment']>,
): string {
  const keyPrefix = sanitizeFileName(fileAttachment.resourceKey)?.slice(0, 64) ?? 'attachment';
  const baseName = sanitizeFileName(fileAttachment.fileName) ?? fallbackFileName(fileAttachment);
  return truncateFileName(`${keyPrefix}-${baseName}`, 180);
}

function fallbackFileName(fileAttachment: NonNullable<TaskSpec['context']['fileAttachment']>): string {
  const extension =
    fileAttachment.resourceType === 'audio'
      ? 'audio'
      : fileAttachment.resourceType === 'media'
        ? 'media'
        : 'bin';
  return `attachment.${extension}`;
}

function truncateFileName(fileName: string, maxLength: number): string {
  if (fileName.length <= maxLength) return fileName;
  const extension = extname(fileName);
  const stemLength = Math.max(1, maxLength - extension.length);
  return `${fileName.slice(0, stemLength)}${extension}`;
}

async function appendAttachmentWarning(
  taskMdPath: string,
  fileAttachment: NonNullable<TaskSpec['context']['fileAttachment']>,
  reason: string,
): Promise<void> {
  await appendFile(
    taskMdPath,
    `\nAttachment download failed: ${fileAttachment.fileName ?? fileAttachment.resourceKey} (${reason})\n`,
  );
}

function detectImageFormat(buffer: Buffer): { extension: 'png' | 'jpg' | 'gif' | 'webp' } {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { extension: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg' };
  }
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return { extension: 'gif' };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { extension: 'webp' };
  }
  return { extension: 'png' };
}
