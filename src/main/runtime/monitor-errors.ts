/**
 * A monitor throws this from `start()` when the surface's installation is
 * absent (no application bundle, no executable on PATH). The coordinator keeps
 * the surface quietly `unavailable` with a slow retry instead of reporting an
 * `error`, so a provider row stays clean when only one of its surfaces is
 * installed. Any other start failure remains an error. The message is a fixed
 * `<provider>-<surface>-<code>` label and never carries a path.
 */
export class MonitorPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MonitorPrerequisiteError';
  }
}
