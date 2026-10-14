// Registration: `sail <ticket>` and `sail resume` record their repository in the watcher registry. A stub until
// ADW-120's second task: it records nothing, and no command calls it yet.
import type { ProjectConfig } from '../engine/config';
import type { Io } from './index';

export async function registerRepository(
  _io: Io,
  _command: string,
  _project: { sailDir: string; config: ProjectConfig },
): Promise<void> {}
