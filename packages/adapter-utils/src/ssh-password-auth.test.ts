import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildSshSpawnTarget, parseSshRemoteExecutionSpec } from "./ssh.js";

const execFileAsync = promisify(execFile);

const BASE_SPEC = {
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteCwd: "/srv/paperclip/workspace",
  remoteWorkspacePath: "/srv/paperclip/workspace",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
} as const;

function readAskpassPath(args: string[]): string {
  const entry = args.find((arg) => arg.startsWith("SSH_ASKPASS="));
  if (!entry) throw new Error("SSH_ASKPASS was not set");
  return entry.slice("SSH_ASKPASS=".length);
}

describe("ssh password authentication", () => {
  it("spawns ssh directly in batch mode for key login", async () => {
    const target = await buildSshSpawnTarget({
      spec: { ...BASE_SPEC, privateKey: "KEY MATERIAL" },
      command: "node",
      args: ["--version"],
      env: {},
    });
    try {
      expect(target.command).toBe("ssh");
      expect(target.args).toContain("BatchMode=yes");
      expect(target.args).toContain("-i");
      expect(target.args.some((arg) => arg.startsWith("SSH_ASKPASS="))).toBe(false);
    } finally {
      await target.cleanup();
    }
  });

  it("wraps ssh in env with a forced askpass helper for password login", async () => {
    const password = "p@ss 'word\" $HOME `x`";
    const target = await buildSshSpawnTarget({
      spec: { ...BASE_SPEC, privateKey: "IGNORED KEY", password },
      command: "node",
      args: ["--version"],
      env: {},
    });
    const askpassPath = readAskpassPath(target.args);
    try {
      expect(target.command).toBe("env");
      expect(target.args).toContain("SSH_ASKPASS_REQUIRE=force");
      const sshIndex = target.args.indexOf("ssh");
      expect(sshIndex).toBeGreaterThan(0);
      // Every entry before `ssh` is an env assignment, so env runs ssh itself.
      expect(target.args.slice(0, sshIndex).every((arg) => /^[A-Z_]+=/.test(arg))).toBe(true);
      expect(target.args).toContain("BatchMode=no");
      expect(target.args).toContain("PubkeyAuthentication=no");
      expect(target.args).toContain("NumberOfPasswordPrompts=1");
      expect(target.args).not.toContain("BatchMode=yes");
      // The password never appears on the command line, and the key is ignored.
      expect(target.args.some((arg) => arg.includes(password))).toBe(false);
      expect(target.args).not.toContain("-i");

      const { stdout } = await execFileAsync("sh", [askpassPath]);
      expect(stdout).toBe(`${password}\n`);
    } finally {
      await target.cleanup();
    }
    expect(existsSync(askpassPath)).toBe(false);
  });

  it("carries the password through the remote execution spec", () => {
    const spec = parseSshRemoteExecutionSpec({ ...BASE_SPEC, password: "secret" });
    expect(spec?.password).toBe("secret");
    expect(parseSshRemoteExecutionSpec({ ...BASE_SPEC, password: "" })?.password).toBeNull();
    expect(parseSshRemoteExecutionSpec(BASE_SPEC)?.password).toBeNull();
  });
});
