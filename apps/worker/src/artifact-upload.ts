/**
 * Map collected task artifacts to the neutral {@link LocalFile} shape for outbound
 * upload, KEEPING ONLY the paths the worker can actually read.
 *
 * Artifacts come from one of two sources (apps/worker/src/main.ts): a LOCAL run's
 * `collectArtifactsFromDir(workspace.artifactsDir)` (paths on the worker's own
 * filesystem) or a REMOTE dispatch's `adapter.collectArtifacts(taskId)` (paths on
 * the DAEMON's filesystem). A remote path is not openable from the worker process,
 * so uploading it would throw. We probe each path with `fs.access(R_OK)` and skip +
 * log any unreadable one rather than letting the terminal feedback fail.
 */
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { ArtifactRef } from '@open-tag/core-types';
import type { Logger } from 'pino';
import type { LocalFile } from './channel-sender.js';

async function defaultCanRead(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the subset of `artifacts` that exist and are readable on the worker, as
 * {@link LocalFile}s ready for {@link NeutralChannelFeedback} to upload. The
 * readability probe is injectable so it can be unit-tested without touching disk.
 */
export async function selectUploadableArtifacts(
  artifacts: ArtifactRef[],
  options: { logger?: Logger; canRead?: (path: string) => Promise<boolean> } = {},
): Promise<LocalFile[]> {
  const canRead = options.canRead ?? defaultCanRead;
  const files: LocalFile[] = [];
  for (const artifact of artifacts) {
    if (!(await canRead(artifact.path))) {
      options.logger?.warn(
        { path: artifact.path, name: artifact.name },
        'Artifact path is not readable on the worker; skipping outbound upload',
      );
      continue;
    }
    files.push({
      path: artifact.path,
      name: artifact.name,
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
    });
  }
  return files;
}
