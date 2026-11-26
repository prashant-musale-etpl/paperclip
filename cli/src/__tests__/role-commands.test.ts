import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUGGESTED_COMPANY_ROLES } from "@paperclipai/shared";
import { registerRoleCommands } from "../commands/client/role.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ROLE_ID = "44444444-4444-4444-8444-444444444444";
const API = ["--api-base", "http://localhost:3100", "--api-key", "board-token", "--company-id", COMPANY_ID];

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerRoleCommands(program);
  return program;
}

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function role(overrides: Record<string, unknown> = {}) {
  return {
    id: ROLE_ID, companyId: COMPANY_ID, key: "qa", name: "QA", description: null, archivedAt: null,
    createdAt: "2026-11-26T00:00:00.000Z", updatedAt: "2026-11-26T00:00:00.000Z", holders: [], ...overrides,
  };
}

describe("role commands", () => {
  let tempDir: string;
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-roles-"));
    process.env.PAPERCLIP_CONTEXT = path.join(tempDir, "context.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_CONTEXT;
  });

  it("creates only the suggested roles that do not exist yet", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respond([role()]))
      .mockImplementation(async (_url: string, init: RequestInit) => respond(role({ ...JSON.parse(String(init.body)) }), 201));
    vi.stubGlobal("fetch", fetchMock);
    await createProgram().parseAsync(["role", "create", ...API, "--suggested", "--json"], { from: "user" });
    const posted = fetchMock.mock.calls.slice(1).map((call) => JSON.parse(String(call[1]?.body)).key);
    expect(posted).toEqual(SUGGESTED_COMPANY_ROLES.map((entry) => entry.key).filter((key) => key !== "qa"));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/roles`);
  });

  it("assigns a role by key to a member found by email", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respond([role()]))
      .mockResolvedValueOnce(respond({ users: [{ principalId: "user-7", user: { email: "QA.Lead@example.com" } }] }))
      .mockResolvedValueOnce(respond(role({ holders: [{ userId: "user-7" }] })));
    vi.stubGlobal("fetch", fetchMock);
    await createProgram().parseAsync(["role", "assign", "qa", ...API, "--user", "qa.lead@example.com", "--json"], { from: "user" });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/roles/${ROLE_ID}/holders`);
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ userId: "user-7" });
  });

  it("unassigns by role id and user id without lookups", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(role()));
    vi.stubGlobal("fetch", fetchMock);
    await createProgram().parseAsync(["role", "unassign", ROLE_ID, ...API, "--user", "user-7", "--json"], { from: "user" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/roles/${ROLE_ID}/holders/user-7`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });
});
