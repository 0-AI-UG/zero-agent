import { call, type CallOptions } from "./client.ts";
import {
  CredsListInput,
  CredsGetInput,
  CredsSetInput,
  CredsRemoveInput,
  type CredsGetInputT,
  type CredsSetInputT,
  type CredsRemoveInputT,
} from "./schemas.ts";

export interface CredentialSummary {
  id: string;
  label: string;
  type: string;
  siteUrl: string;
  domain: string;
  username?: string;
  hasPassword: boolean;
  hasTotp: boolean;
  hasBackupCodes: boolean;
}

export interface CredGetResult {
  value: string;
  field: "password" | "totp" | "username";
}

export type SetCredentialInput = CredsSetInputT;

export const creds = {
  ls(options?: CallOptions): Promise<{ credentials: CredentialSummary[] }> {
    return call("/zero/creds/list", CredsListInput.parse({}), options);
  },
  /**
   * Returns the raw secret in `value`. The agent should NOT call this
   * directly from a script that prints the result - use the CLI form
   * inside shell substitution: `$(zero creds get foo)`.
   */
  get(opts: CredsGetInputT, options?: CallOptions): Promise<CredGetResult> {
    return call<CredGetResult>("/zero/creds/get", CredsGetInput.parse(opts), options);
  },
  set(input: SetCredentialInput, options?: CallOptions): Promise<{ saved: boolean; updated: boolean; id: string }> {
    return call("/zero/creds/set", CredsSetInput.parse(input), options);
  },
  rm(opts: CredsRemoveInputT, options?: CallOptions): Promise<{ removed: boolean; id: string }> {
    return call("/zero/creds/remove", CredsRemoveInput.parse(opts), options);
  },
};
