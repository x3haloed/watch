export const INSTANCE_VERSION = 2;

export function assertInstanceVersion(version: unknown): asserts version is typeof INSTANCE_VERSION {
  if (version !== INSTANCE_VERSION) {
    throw new Error(
      'Watch v2 requires instanceVersion: 2 in config.json. Create a separate v2 instance and copy only the configuration and scratchpads you want to carry forward; do not reuse v1 runtime state.',
    );
  }
}
