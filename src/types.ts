/**
 * Request and answer types of the Studio API, generated from its OpenAPI description (`src/generated/studio-api.ts`)
 * and re-exported under the API reference's schema names.
 */
import type { components, operations } from "./generated/studio-api.js";

export type { components, operations, paths } from "./generated/studio-api.js";

/** Every schema of the Studio API description, by name. */
export type Schemas = components["schemas"];

type Query<Op extends keyof operations> = NonNullable<operations[Op]["parameters"]["query"]>;

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export type StudioError = Schemas["StudioError"];
export type PlatformError = Schemas["PlatformError"];
export type PlatformBanRefusal = Schemas["PlatformBanRefusal"];

// ── Game-server sessions ───────────────────────────────────────────────────────────────────────────────────────────
export type ServerSession = Schemas["ServerSession"];
export type SessionConnection = Schemas["SessionConnection"];
export type CreateCreditSessionRequest = Schemas["CreateCreditSessionRequest"];
export type StopCreditSessionAnswer = Schemas["StopCreditSessionAnswer"];
export type RenameSessionRequest = Schemas["RenameSessionRequest"];
export type RescheduleSessionRequest = Schemas["RescheduleSessionRequest"];
export type CancelScheduleAnswer = Schemas["CancelScheduleAnswer"];
export type LaunchArgument = Schemas["LaunchArgument"];
export type PoolClaimRequest = Schemas["PoolClaimRequest"];
export type PoolClaimAnswer = Schemas["PoolClaimAnswer"];
/** Filters of `sessions.list()` and `sessions.subscription.list()`. */
export type ListSessionsQuery = Query<"sessions.listCredit">;
/** Filters of `sessions.listMine()`. */
export type ListMySessionsQuery = Query<"sessions.listMine">;
/** Options of `sessions.get()`. */
export type GetSessionQuery = Query<"sessions.get">;

// ── Billing ────────────────────────────────────────────────────────────────────────────────────────────────────────
export type CreditBalance = Schemas["CreditBalance"];
export type CreditStats = Schemas["CreditStats"];
export type OrgCreditStats = Schemas["OrgCreditStats"];
export type PlanSubscription = Schemas["PlanSubscription"];
export type SubscriptionOverview = Schemas["SubscriptionOverview"];
export type UsageStats = Schemas["UsageStats"];
export type CreditStatsQuery = Query<"billing.getCreditStats">;
export type KeyOrgQuery = Query<"billing.getKeyOrgCredits">;
export type SubscriptionsQuery = Query<"billing.getSubscriptions">;

// ── Player sign-in (studio backend) ────────────────────────────────────────────────────────────────────────────────
export type StudioSignInRequest = Schemas["StudioSignInRequest"];
export type PlayerSignIn = Schemas["PlayerSignIn"];
export type SignedInPlayer = Schemas["SignedInPlayer"];
export type PlayerIdentity = Schemas["PlayerIdentity"];
export type IdentityProvider = Schemas["IdentityProvider"];
export type PlayerImportRequest = Schemas["PlayerImportRequest"];
export type PlayerImportReport = Schemas["PlayerImportReport"];
export type ImportCounts = Schemas["ImportCounts"];
export type ImportStatus = Schemas["ImportStatus"];
export type PlayerTokenKeys = Schemas["PlayerTokenKeys"];

// ── Player data (studio backend) ───────────────────────────────────────────────────────────────────────────────────
export type PlayerRef = Schemas["PlayerRef"];
export type ResolvePlayersRequest = Schemas["ResolvePlayersRequest"];
export type ResolvePlayersAnswer = Schemas["ResolvePlayersAnswer"];
export type StudioPlayerDataAnswer = Schemas["StudioPlayerDataAnswer"];
export type StudioDataEntry = Schemas["StudioDataEntry"];
export type DataKey = Schemas["DataKey"];
export type DataOp = Schemas["DataOp"];
export type SetDataOp = Schemas["SetDataOp"];
export type DeleteDataOp = Schemas["DeleteDataOp"];
export type IncDataOp = Schemas["IncDataOp"];
export type DataOpsRequest = Schemas["DataOpsRequest"];
export type DataOpResult = Schemas["DataOpResult"];
export type DataOpResults = Schemas["DataOpResults"];
export type PlayersDataRequest = Schemas["PlayersDataRequest"];
export type PlayersDataAnswer = Schemas["PlayersDataAnswer"];
export type PlayersWriteRequest = Schemas["PlayersWriteRequest"];
export type PlayersWriteAnswer = Schemas["PlayersWriteAnswer"];
export type StudioGameDataAnswer = Schemas["StudioGameDataAnswer"];
export type GameDataOp = Schemas["GameDataOp"];
export type GameSetDataOp = Schemas["GameSetDataOp"];
export type GameDeleteDataOp = Schemas["GameDeleteDataOp"];
export type GameDataOpsRequest = Schemas["GameDataOpsRequest"];
export type DataImportRequest = Schemas["DataImportRequest"];
export type PlayerDataImportRow = Schemas["PlayerDataImportRow"];
export type GameDataImportRow = Schemas["GameDataImportRow"];
export type DataImportReport = Schemas["DataImportReport"];
export type ErasedPlayersPage = Schemas["ErasedPlayersPage"];
/** A player's data stores. */
export type PlayerDataStore = SetDataOp["store"];
/** A game's data stores. */
export type GameDataStore = GameSetDataOp["store"];

// ── Store (studio backend) ─────────────────────────────────────────────────────────────────────────────────────────
export type CurrencyCode = Schemas["CurrencyCode"];
export type Sku = Schemas["Sku"];
export type StudioStoreCatalog = Schemas["StudioStoreCatalog"];
export type StudioStoreItem = Schemas["StudioStoreItem"];
export type StorePrice = Schemas["StorePrice"];
export type StoreBundleLine = Schemas["StoreBundleLine"];
export type StoreHoldings = Schemas["StoreHoldings"];
export type StoreBalance = Schemas["StoreBalance"];
export type StoreItemInstance = Schemas["StoreItemInstance"];
export type StoreHistoryPage = Schemas["StoreHistoryPage"];
export type StoreHistoryEntry = Schemas["StoreHistoryEntry"];
export type StoreLedgerChange = Schemas["StoreLedgerChange"];
export type StoreShortfall = Schemas["StoreShortfall"];
export type StoreTxn = Schemas["StoreTxn"];
export type StoreTxnResult = Schemas["StoreTxnResult"];
export type StoreGrantRequest = Schemas["StoreGrantRequest"];
export type StoreGrantLine = Schemas["StoreGrantLine"];
export type StoreItemGrantLine = Schemas["StoreItemGrantLine"];
export type StoreCurrencyLine = Schemas["StoreCurrencyLine"];
export type StoreStudioConsumeRequest = Schemas["StoreStudioConsumeRequest"];
export type StoreConsumeLine = Schemas["StoreConsumeLine"];
export type StoreStudioPurchaseRequest = Schemas["StoreStudioPurchaseRequest"];
export type StoreItemUpdateRequest = Schemas["StoreItemUpdateRequest"];
export type StoreReversalRequest = Schemas["StoreReversalRequest"];
export type StudioMetaPurchaseSyncRequest = Schemas["StudioMetaPurchaseSyncRequest"];
export type MetaPurchaseSyncAnswer = Schemas["MetaPurchaseSyncAnswer"];
export type StoreCatalogImportRequest = Schemas["StoreCatalogImportRequest"];
export type StoreHoldingsImportRequest = Schemas["StoreHoldingsImportRequest"];
export type StoreImportReport = Schemas["StoreImportReport"];
