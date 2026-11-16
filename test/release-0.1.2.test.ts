// 0.1.2: where players join a session (connection.primaryPort on session reads; slavePort is the room port).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readSessionEnvironment, SplatterVault, type ServerSession, type SessionConnection } from "../src/index.js";
import { BASE, KEY, mockFetch } from "./helpers/mockFetch.js";

const sv = (fetch: ReturnType<typeof mockFetch>["fetch"]) => new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch });

// A Minecraft Java session: the server leased room port 8100, but the game listens on its configured 25565.
const minecraft: ServerSession = {
  id: 501,
  status: "Active",
  code: "ABCD",
  slaveIp: "203.0.113.10",
  slavePort: 8100,
  ready: true,
  connection: {
    host: "203.0.113.10",
    primaryPort: 25565,
    ports: [
      { id: "game", label: "Game Port", port: 25565, protocol: "tcp" },
      { id: "rcon", label: "RCON", port: 25575 }
    ],
    password: "ABCD",
    code: "ABCD",
    serverName: "Friday build",
    connectionMode: "direct_ip",
    launchUrl: null,
    showHost: true,
    showPassword: false,
    version: "1.21.4",
    platform: "PC",
    instructions: { summary: "Join 203.0.113.10:25565", steps: ["Multiplayer > Add Server", "203.0.113.10:25565"] }
  }
};

describe("sessions.get: connection", () => {
  it("answers the session's connection as the API sent it, with slaveIp and slavePort unchanged", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: minecraft });
    const session = await sv(fetch).sessions.get(501, { slim: true });
    expect(calls[0]?.url).toBe(`${BASE}/game-sessions/501?slim=true`);
    expect(session).toEqual(minecraft);
    expect(session.connection?.primaryPort).toBe(25565);
    expect(session.slavePort).toBe(8100);
    // The typed fields the description now lists.
    const ports: { id: string; port: number }[] | undefined = session.connection?.ports;
    const steps: string[] | undefined = session.connection?.instructions?.steps;
    expect(ports?.map((p) => p.port)).toEqual([25565, 25575]);
    expect(steps).toHaveLength(2);
  });

  it("types a connection whose port is not known yet, and a session with no connection", () => {
    const claimedRoom: SessionConnection = { host: "203.0.113.11", primaryPort: null, ports: [], showHost: true, showPassword: true, instructions: null };
    const booting: ServerSession = { id: 502, status: "Pending", slaveIp: null, slavePort: null, connection: null };
    expect(claimedRoom.primaryPort).toBeNull();
    expect(booting.connection).toBeNull();
  });
});

describe("the API description", () => {
  const spec = JSON.parse(readFileSync(new URL("../openapi/studio-api.json", import.meta.url), "utf8")) as {
    components: { schemas: Record<string, { properties?: Record<string, { description?: string }> }> };
  };
  const schemas = spec.components.schemas;

  it("lists ports and instructions on SessionConnection and says what primaryPort and slavePort are", () => {
    const connection = schemas["SessionConnection"]?.properties ?? {};
    expect(Object.keys(connection)).toEqual(expect.arrayContaining(["host", "primaryPort", "ports", "instructions"]));
    expect(connection["primaryPort"]?.description).toMatch(/port players join on/i);
    expect(schemas["ServerSession"]?.properties?.["slavePort"]?.description).toMatch(/room port/i);
    expect(schemas["ServerSession"]?.properties?.["connection"]).toBeDefined();
  });
});

describe("readSessionEnvironment: slavePort", () => {
  it("is null when SLAVE_PORT is not set, as on SplatterVault servers today", () => {
    expect(readSessionEnvironment({ CODE: "ABCD", GAME_TYPE: "PPG" })).toMatchObject({ onSplatterVault: true, slavePort: null });
  });
});
