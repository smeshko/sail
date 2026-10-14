// The dashboard's server. A stub: the signatures are final, and it answers `{}` to everything, on every address, until
// ADW-120's fourth task.

export interface DashboardOptions {
  registryDir: string;
  /** 0 picks a free port. */
  port: number;
  /** How often a run stream polls its events once caught up. 200 ms by default. */
  followPollMs?: number;
  /** How often the index stream rereads the registry. 1000 ms by default. */
  indexPollMs?: number;
}

export interface Dashboard {
  url: string;
  port: number;
  stop(): Promise<void>;
}

/** The header every client sends, and its one value. */
export const CLIENT_HEADER = 'X-Sail-Dashboard';

export function guard(_request: Request, _port: number): Response | undefined {
  return undefined;
}

export function startDashboard(options: DashboardOptions): Dashboard | { refused: string } {
  try {
    const server = Bun.serve({ port: options.port, fetch: () => Response.json({}) });
    const port = server.port ?? options.port;
    return { url: `http://localhost:${port}/`, port, stop: () => server.stop(true) };
  } catch {
    return { refused: '' };
  }
}
