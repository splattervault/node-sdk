import { type HttpClient, type RequestOptions } from "../core/http.js";
import type {
  CreditBalance,
  CreditStats,
  CreditStatsQuery,
  KeyOrgQuery,
  OrgCreditStats,
  PlanSubscription,
  SubscriptionOverview,
  SubscriptionsQuery,
  UsageStats
} from "../types.js";

/**
 * Credits and subscriptions. With an organization API key these are the key's organization's (the key needs a
 * permission to read them, e.g. org:view). Like the session routes, these never answer 429.
 */
export class Billing {
  /** @internal */
  constructor(private readonly http: HttpClient) {}

  /**
   * The credit balance: the organization's for an organization API key (split into subscription and purchased
   * credits). For an organization key `id` is 0 and `createdAt`, `updatedAt` and `user` are null.
   * @see GET /credits (`billing.getCredits`)
   */
  getCredits(options?: RequestOptions): Promise<CreditBalance> {
    return this.http.call("billing.getCredits", { options });
  }

  /**
   * Credit usage statistics; `organizationId` for an organization's.
   * @see GET /credits/stats (`billing.getCreditStats`)
   */
  getCreditStats(query?: CreditStatsQuery, options?: RequestOptions): Promise<CreditStats> {
    return this.http.call("billing.getCreditStats", { query, options });
  }

  /**
   * The credits of the organization the API key belongs to (balance, available balance, auto-buy settings).
   * @see GET /org/credits (`billing.getKeyOrgCredits`)
   */
  getOrgCredits(query?: KeyOrgQuery, options?: RequestOptions): Promise<OrgCreditStats> {
    return this.http.call("billing.getKeyOrgCredits", { query, options });
  }

  /**
   * Every subscription of the organization the API key belongs to.
   * @see GET /org/subscription (`billing.getKeyOrgSubscriptions`)
   */
  getOrgSubscriptions(query?: KeyOrgQuery, options?: RequestOptions): Promise<PlanSubscription[]> {
    return this.http.call("billing.getKeyOrgSubscriptions", { query, options });
  }

  /**
   * The credits of organization `orgId` (the key's own organization).
   * @see GET /organizations/{orgId}/credits (`billing.getOrgCredits`)
   */
  getOrgCreditsById(orgId: number | string, options?: RequestOptions): Promise<OrgCreditStats> {
    return this.http.call("billing.getOrgCredits", { path: { orgId }, options });
  }

  /**
   * The current and past subscriptions of organization `orgId` (the key's own organization).
   * @see GET /organizations/{orgId}/subscription (`billing.getOrgSubscription`)
   */
  getOrgSubscriptionById(orgId: number | string, options?: RequestOptions): Promise<SubscriptionOverview> {
    return this.http.call("billing.getOrgSubscription", { path: { orgId }, options });
  }

  /**
   * The current subscription and the others (`includeStripeHistory: true` adds invoices).
   * @see GET /subscriptions (`billing.getSubscriptions`)
   */
  getSubscriptions(query?: SubscriptionsQuery, options?: RequestOptions): Promise<SubscriptionOverview> {
    return this.http.call("billing.getSubscriptions", { query, options });
  }

  /**
   * Usage in the current billing period: instances, credit hours, sessions.
   * @see GET /subscriptions/usage (`billing.getUsage`)
   */
  getUsage(options?: RequestOptions): Promise<UsageStats> {
    return this.http.call("billing.getUsage", { options });
  }
}
