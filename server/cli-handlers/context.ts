/**
 * The principal for a request that came in via the runner proxy on
 * behalf of an in-container `zero` CLI/SDK invocation.
 *
 * Critically, this is NOT a UI session and NOT a user JWT. The principal
 * is established by:
 *   1. The trusted runner bearer (`Authorization: Bearer $RUNNER_API_KEY`)
 *      which proves the request was forwarded by our own runner.
 *   2. The `X-Runner-Container` header set by that runner, which names
 *      the session container the original CLI call came from.
 *
 * The server resolves container → (projectId, userId) using its own
 * project↔runner mapping. Containers never carry a user credential.
 */

export interface CliContext {
  projectId: string;
  userId: string;
  containerName: string;
}
