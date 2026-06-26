export interface TruncateTextOptions {
  /** Appended after the kept prefix when truncation happens. Not counted against maxLength. */
  suffix?: string;
  /** Trim trailing whitespace from the kept prefix before appending the suffix. */
  trimEnd?: boolean;
}

/**
 * Keep at most `maxLength` characters of `value`. Values within the limit are
 * returned unchanged; longer values are cut, optionally right-trimmed, and the
 * suffix (if any) is appended after the kept prefix.
 */
export function truncateText(
  value: string,
  maxLength: number,
  options: TruncateTextOptions = {},
): string {
  if (value.length <= maxLength) {
    return value;
  }

  const kept = value.slice(0, Math.max(0, maxLength));
  const prefix = options.trimEnd ? kept.trimEnd() : kept;
  return options.suffix ? prefix + options.suffix : prefix;
}
