import { describe, expect, it } from "vitest";

import { readSessionEnvironment } from "../src/index.js";

describe("readSessionEnvironment", () => {
  it("reads a cold session server's variables", () => {
    expect(
      readSessionEnvironment({
        CODE: "ABCD",
        SESSION_ID: "4211",
        MODE: "Ranked",
        SERVER_NAME: "sv-ABCD",
        FRIENDLY_NAME: "Finals",
        GAME_TYPE: "PPG",
        BUILD_CHANNEL: "beta",
        SLAVE_PORT: "8100",
        PATH: "/usr/bin"
      })
    ).toEqual({
      onSplatterVault: true,
      sessionId: 4211,
      code: "ABCD",
      gameType: "PPG",
      mode: "Ranked",
      serverName: "sv-ABCD",
      friendlyName: "Finals",
      buildChannel: "beta",
      slavePort: 8100
    });
  });

  it("a pool server has an empty SESSION_ID: sessionId is null", () => {
    const env = readSessionEnvironment({ CODE: "QWER", SESSION_ID: "", GAME_TYPE: "PPG", BUILD_CHANNEL: "" });
    expect(env).toMatchObject({ onSplatterVault: true, sessionId: null, code: "QWER", buildChannel: null, slavePort: null });
  });

  it("outside SplatterVault everything is null", () => {
    expect(readSessionEnvironment({ PATH: "/usr/bin" })).toEqual({
      onSplatterVault: false,
      sessionId: null,
      code: null,
      gameType: null,
      mode: null,
      serverName: null,
      friendlyName: null,
      buildChannel: null,
      slavePort: null
    });
  });

  it("ignores ids that are not positive integers", () => {
    expect(readSessionEnvironment({ SESSION_ID: "12abc", SLAVE_PORT: "-1" })).toMatchObject({ sessionId: null, slavePort: null });
  });

  it("reads process.env by default", () => {
    expect(readSessionEnvironment()).toHaveProperty("onSplatterVault");
  });
});
