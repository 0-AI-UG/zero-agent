import { call, type CallOptions } from "./client.ts";
import {
  AppsCreateInput,
  AppsDeleteInput,
  AppsListInput,
  type AppsCreateInputT,
  type AppsDeleteInputT,
  type AppsListInputT,
} from "./schemas.ts";

export interface AppRecord {
  appId: string;
  slug: string;
  name: string;
  port: number;
  url: string;
  createdAt?: string;
}

export interface CreateAppResult extends AppRecord {
  message: string;
}

export interface DeleteAppResult {
  slug: string;
  message: string;
}

export interface ListAppsResult {
  apps: AppRecord[];
}

export const apps = {
  /**
   * Allocate a free host port and register a permanent slug for it. The
   * returned `port` is what the caller's process must bind to; thereafter
   * `/_apps/<slug>` proxies to `127.0.0.1:<port>`. With a `name`, calling
   * twice returns the existing record.
   */
  create(input: AppsCreateInputT = {}, options?: CallOptions): Promise<CreateAppResult> {
    return call<CreateAppResult>("/zero/apps/create", AppsCreateInput.parse(input), options);
  },

  /** Delete an app by slug. The port is freed back to the allocator pool. */
  delete(input: AppsDeleteInputT, options?: CallOptions): Promise<DeleteAppResult> {
    return call<DeleteAppResult>("/zero/apps/delete", AppsDeleteInput.parse(input), options);
  },

  /** List all apps in the current project. */
  list(input: AppsListInputT = {}, options?: CallOptions): Promise<ListAppsResult> {
    return call<ListAppsResult>("/zero/apps/list", AppsListInput.parse(input), options);
  },
};
