import { type OperationId } from "../src/index.js";

/** Every client method that calls one API operation: `namespace.method` → operationId. */
export const SURFACE: Record<string, OperationId> = {
  "sessions.create": "sessions.createCredit",
  "sessions.list": "sessions.listCredit",
  "sessions.get": "sessions.get",
  "sessions.listMine": "sessions.listMine",
  "sessions.stop": "sessions.stopCredit",
  "sessions.rename": "sessions.renameCredit",
  "sessions.reschedule": "sessions.rescheduleCredit",
  "sessions.cancelSchedule": "sessions.cancelScheduledCredit",
  "sessions.subscription.create": "sessions.createSubscription",
  "sessions.subscription.list": "sessions.listSubscription",
  "sessions.subscription.stop": "sessions.stopSubscription",
  "sessions.subscription.rename": "sessions.renameSubscription",
  "sessions.subscription.reschedule": "sessions.rescheduleSubscription",
  "sessions.subscription.cancelSchedule": "sessions.cancelScheduledSubscription",
  "serverPools.claim": "serverPools.claim",
  "games.getConfigurableArgs": "games.getConfigurableArgs",

  "billing.getCredits": "billing.getCredits",
  "billing.getCreditStats": "billing.getCreditStats",
  "billing.getOrgCredits": "billing.getKeyOrgCredits",
  "billing.getOrgSubscriptions": "billing.getKeyOrgSubscriptions",
  "billing.getOrgCreditsById": "billing.getOrgCredits",
  "billing.getOrgSubscriptionById": "billing.getOrgSubscription",
  "billing.getSubscriptions": "billing.getSubscriptions",
  "billing.getUsage": "billing.getUsage",

  "players.signIn": "playerAuth.studio.signIn",
  "players.import": "playerAuth.studio.importPlayers",
  "players.erase": "playerAuth.studio.erasePlayer",

  "playerData.resolve": "studioData.resolvePlayers",
  "playerData.get": "studioData.getPlayerData",
  "playerData.update": "studioData.updatePlayerData",
  "playerData.clear": "studioData.clearPlayerData",
  "playerData.getMany": "studioData.getPlayersData",
  "playerData.writeMany": "studioData.writePlayersData",
  "playerData.getGameData": "studioData.getGameData",
  "playerData.updateGameData": "studioData.updateGameData",
  "playerData.import": "studioData.importData",
  "playerData.listErasedPlayers": "studioData.listErasedPlayers",

  "store.getCatalog": "store.studio.getCatalog",
  "store.getPlayer": "store.studio.getPlayer",
  "store.getHistory": "store.studio.getPlayerHistory",
  "store.grant": "store.studio.grant",
  "store.consume": "store.studio.consume",
  "store.purchase": "store.studio.purchase",
  "store.updateItem": "store.studio.updateItem",
  "store.reverse": "store.studio.reverse",
  "store.syncMetaPurchases": "store.studio.syncMetaPurchases",
  "store.importCatalog": "store.studio.importCatalog",
  "store.importHoldings": "store.studio.importHoldings"
};

/** Client methods that are not one operation: pagination helpers (they call one of the methods above). */
export const HELPERS: Record<string, OperationId> = {
  "sessions.waitUntilReady": "sessions.get",
  "playerData.erasedPlayerPages": "studioData.listErasedPlayers",
  "store.historyPages": "store.studio.getPlayerHistory"
};

/** The client's resource namespaces (nested ones with a dot). */
export const NAMESPACES = ["sessions", "sessions.subscription", "serverPools", "games", "billing", "players", "playerData", "store"];
