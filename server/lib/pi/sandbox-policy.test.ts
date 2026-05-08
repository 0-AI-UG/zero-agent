import { describe, expect, test } from "vitest";
import {
  buildPiSandboxPolicy,
  DEFAULT_ALLOWED_DOMAINS,
} from "./sandbox-policy.ts";

describe("buildPiSandboxPolicy", () => {
  test("project dir + socket dir are writable; secrets denied", () => {
    const p = buildPiSandboxPolicy({
      projectDir: "/var/zero/projects/p1",
      socketDir: "/tmp/zero-pi-sockets/run-1",
    });
    expect(p.filesystem.allowWrite).toContain("/var/zero/projects/p1");
    expect(p.filesystem.allowWrite).toContain("/tmp/zero-pi-sockets/run-1");
    expect(p.filesystem.denyRead).toEqual(
      expect.arrayContaining(["~/.ssh", "~/.aws", "~/.gnupg"]),
    );
    expect(p.filesystem.denyWrite).toEqual(
      expect.arrayContaining([".env", "*.pem", "*.key"]),
    );
  });

  test("network defaults to package-registry allowlist + socket dir", () => {
    const p = buildPiSandboxPolicy({
      projectDir: "/var/zero/projects/p1",
      socketDir: "/tmp/sock",
    });
    expect(p.network.allowedDomains).toEqual([...DEFAULT_ALLOWED_DOMAINS]);
    expect(p.network.allowUnixSockets).toEqual(["/tmp/sock"]);
  });

  test("explicit allowedDomains overrides default", () => {
    const p = buildPiSandboxPolicy({
      projectDir: "/p",
      socketDir: "/s",
      allowedDomains: ["example.com"],
    });
    expect(p.network.allowedDomains).toEqual(["example.com"]);
  });
});
