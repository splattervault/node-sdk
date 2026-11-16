/**
 * What a game server running ON SplatterVault learns from its environment.
 *
 * The SplatterVault wrapper starts your game process with an allowlisted environment (it never passes its own
 * credentials). These are the session variables in that list:
 *
 * | Variable        | Cold session (its own server)            | Pool server (claimed for a match)                     |
 * |-----------------|------------------------------------------|-------------------------------------------------------|
 * | `SESSION_ID`    | the session's id                         | empty: the claim does not set it                      |
 * | `CODE`          | the session's join code                  | the claiming session's fresh code                     |
 * | `MODE`          | the session's mode                       | set when the pool server booted, not by the claim     |
 * | `SERVER_NAME`   | the session's server name                | set when the pool server booted                       |
 * | `FRIENDLY_NAME` | the session's friendly name              | set when the pool server booted                       |
 * | `GAME_TYPE`     | the game type                            | the game type                                         |
 * | `BUILD_CHANNEL` | the build channel name, when there is one | the build channel name, when there is one            |
 * | `SLAVE_PORT`    | not set on SplatterVault servers today   | not set on SplatterVault servers today                |
 *
 * Your game's own variables (`GAME_TYPE_ENV_*` as configured in the console, and channel overrides) are passed
 * too, under the names you gave them.
 *
 * **Which port to listen on.** SplatterVault servers do not set `SLAVE_PORT` today, so `slavePort` is null there:
 * bind the port your launch arguments give the game. `{{slavePort}}` (or `{{port}}`) in a launch argument is the
 * room port the server leased for this session (8100 and up); `{{gamePort}}` is the game's configured "game" port.
 * Players are told that same port as the session's `connection.primaryPort`.
 */
export interface SessionEnvironment {
  /** True when the variables look like a SplatterVault game server's (`GAME_TYPE` and `CODE` are set). */
  onSplatterVault: boolean;
  /** The session's id on a cold session server; null on a pool server (use the id `serverPools.claim()` answered). */
  sessionId: number | null;
  /** The session's join code (on a pool server: the claiming session's). */
  code: string | null;
  /** The game type, e.g. `PPG`. */
  gameType: string | null;
  /** The session's mode (on a pool server: the pool's, from its boot). */
  mode: string | null;
  /** The server name (on a pool server: from its boot). */
  serverName: string | null;
  /** The friendly name (on a pool server: from its boot). */
  friendlyName: string | null;
  /** The build channel name, or null. */
  buildChannel: string | null;
  /**
   * `SLAVE_PORT`, or null when it is not set. SplatterVault servers do not set it today, so this is null there: bind
   * the port your launch arguments give the game (`{{slavePort}}` or `{{port}}` for the session's room port).
   */
  slavePort: number | null;
}

type Env = Record<string, string | undefined>;

const text = (env: Env, name: string): string | null => {
  const value = env[name];
  return value === undefined || value.trim() === "" ? null : value;
};

const positiveInt = (value: string | null): number | null => {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * Reads the session variables the SplatterVault wrapper gives a game process (see {@link SessionEnvironment}).
 * Pass another object than `process.env` to read a saved environment.
 */
export function readSessionEnvironment(env: Env = process.env): SessionEnvironment {
  const code = text(env, "CODE");
  const gameType = text(env, "GAME_TYPE");
  return {
    onSplatterVault: code !== null && gameType !== null,
    sessionId: positiveInt(text(env, "SESSION_ID")),
    code,
    gameType,
    mode: text(env, "MODE"),
    serverName: text(env, "SERVER_NAME"),
    friendlyName: text(env, "FRIENDLY_NAME"),
    buildChannel: text(env, "BUILD_CHANNEL"),
    slavePort: positiveInt(text(env, "SLAVE_PORT"))
  };
}
