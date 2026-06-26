/**
 * Daemon build version, surfaced in capabilities and the `hello` frame.
 *
 * Kept as a source constant (rather than read from package.json) so it resolves
 * identically under both the `tsc` build and the bundled `tsup` build, where the
 * package.json is not adjacent to the emitted entry. Keep in lockstep with
 * `package.json` "version".
 */
export const DAEMON_VERSION = '0.1.5';
