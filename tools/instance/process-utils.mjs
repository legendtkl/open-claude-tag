export function isMissingProcessError(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}
