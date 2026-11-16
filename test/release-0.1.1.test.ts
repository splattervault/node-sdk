// 0.1.1: the corrected API description (claim 409s, CreditBalance nullability).
import { describe, expect, it } from "vitest";

import { poolClaimConflict, SplatterVault, SplatterVaultError, type CreditBalance } from "../src/index.js";
import { BASE, KEY, mockFetch } from "./helpers/mockFetch.js";

const conflict = (message: string) => ({ status: 409, body: { name: "CONFLICT", message, status: 409, errors: [] } });
const claimError = async (message: string) => {
  const { fetch, calls } = mockFetch(conflict(message));
  const err = await new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch }).serverPools.claim(12).catch((e: unknown) => e);
  return { err, calls };
};

describe("serverPools.claim 409s", () => {
  it("tells 'no warm server' from the '— retry' conflicts by the API's message, as documented", async () => {
    const cases: [string, string][] = [
      ["No warm server available in this pool", "no_warm_server"],
      ["No warm server available in this pool — retry", "busy"],
      ["No warm server connected in this pool — retry", "busy"],
      ["Pool claim is busy — retry", "busy"],
      ["Pool instance was drained during claim — retry", "busy"],
      ["Something new the API says one day", "no_warm_server"]
    ];
    for (const [message, kind] of cases) {
      const { err, calls } = await claimError(message);
      expect({ message, kind: poolClaimConflict(err) }).toEqual({ message, kind });
      // Never retried by the SDK (it starts servers), whatever the kind.
      expect(calls).toHaveLength(1);
      expect(err).toMatchObject({ status: 409, code: null, errorName: "CONFLICT", outcomeUnknown: false });
    }
  });

  it("answers null for anything but a claim's 409", async () => {
    expect(poolClaimConflict(new Error("x"))).toBeNull();
    expect(poolClaimConflict(undefined)).toBeNull();
    const notFound = await new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch: mockFetch({ status: 404, body: { name: "NOT_FOUND", message: "Server pool 12 not found" } }).fetch })
      .serverPools.claim(12)
      .catch((e: unknown) => e);
    expect(poolClaimConflict(notFound)).toBeNull();
    const other = new SplatterVaultError({ status: 409, code: null, message: "", operationId: "sessions.createCredit", method: "POST", path: "/", body: { message: "busy — retry" } });
    expect(poolClaimConflict(other)).toBeNull();
  });
});

describe("CreditBalance", () => {
  it("allows the null createdAt/updatedAt/user and the new fields an organization key's answer carries", async () => {
    // What GET /credits answers for an organization API key (CreditsController: id 0, null dates, user null).
    const orgAnswer: CreditBalance = {
      id: 0,
      balance: 120.5,
      availableBalance: 118,
      subscriptionBalance: 20,
      adHocBalance: 100.5,
      subscriptionCreditsFrozen: false,
      graceExpiresAt: null,
      isInGracePeriod: false,
      totalPurchased: 500,
      totalUsed: 379.5,
      alertsEnabled: false,
      alertThreshold: 0,
      lastAlertSent: null,
      createdAt: null,
      updatedAt: null,
      user: null
    };
    const { fetch } = mockFetch({ status: 200, body: orgAnswer });
    const credits = await new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch }).billing.getCredits();
    expect(credits).toEqual(orgAnswer);
    // Nothing in the SDK reads these dates: the answer is handed over as is.
    expect(credits.createdAt ?? "none").toBe("none");
  });
});
