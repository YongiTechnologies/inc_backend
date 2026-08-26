"use strict";

/**
 * The staff idle window on POST /api/auth/refresh.
 *
 * The client stops refreshing once someone goes idle, so the refresh token's
 * lastUsedAt stops moving and lapses here. These tests pin that behaviour down
 * from the server's side, where it is actually enforced — the browser clock is
 * only the warning.
 */

const mockUserFindById   = jest.fn();
const mockTokenFindOne   = jest.fn();
const mockVerifyRefresh  = jest.fn();

jest.mock("../src/models/User", () => ({ findById: (...a) => mockUserFindById(...a) }));
jest.mock("../src/models/RefreshToken", () => ({ findOne: (...a) => mockTokenFindOne(...a) }));
jest.mock("../src/models/ShipmentItem", () => ({}));
jest.mock("../src/services/email.service", () => ({}));
jest.mock("../src/services/audit.service", () => ({ log: jest.fn() }));
jest.mock("../src/utils/jwt", () => ({
  signAccess:    () => "new.access.token",
  signRefresh:   () => "new.refresh.token",
  verifyRefresh: (...a) => mockVerifyRefresh(...a),
}));

const { refresh } = require("../src/controllers/auth.controller");

const MINUTE = 60 * 1000;

// Minimal express res double capturing what the controller sent.
function makeRes() {
  const res = {
    statusCode: null,
    body:       null,
    cleared:    null,
    status(code) { this.statusCode = code; return this; },
    json(body)   { this.body = body; return this; },
    clearCookie(name, opts) { this.cleared = { name, opts }; },
  };
  return res;
}

const makeReq = () => ({ cookies: { refreshToken: "stored.refresh.token" } });

function storedToken(lastUsedAgoMs) {
  return {
    lastUsedAt: new Date(Date.now() - lastUsedAgoMs),
    createdAt:  new Date(Date.now() - lastUsedAgoMs),
    isRevoked:  false,
    revokedAt:  null,
    save:       jest.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyRefresh.mockReturnValue({ id: "user1" });
});

describe("refresh — staff idle window", () => {
  test("an active staff session is renewed and its window slides forward", async () => {
    mockUserFindById.mockResolvedValue({ _id: "user1", isActive: true, role: "employee" });
    const token = storedToken(5 * MINUTE);
    const before = token.lastUsedAt.getTime();
    mockTokenFindOne.mockResolvedValue(token);

    const res = makeRes();
    await refresh(makeReq(), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.data.accessToken).toBe("new.access.token");
    expect(token.lastUsedAt.getTime()).toBeGreaterThan(before);
    expect(token.save).toHaveBeenCalled();
    expect(token.isRevoked).toBe(false);
  });

  test("a staff session idle past the window is refused, revoked, and says why", async () => {
    mockUserFindById.mockResolvedValue({ _id: "user1", isActive: true, role: "employee" });
    const token = storedToken(31 * MINUTE);
    mockTokenFindOne.mockResolvedValue(token);

    const res = makeRes();
    await refresh(makeReq(), res, jest.fn());

    expect(res.statusCode).toBe(401);
    expect(res.body.data.reason).toBe("idle_timeout");
    // Revoked, so reloading the page cannot revive it.
    expect(token.isRevoked).toBe(true);
    expect(token.save).toHaveBeenCalled();
    // Cleared without maxAge — passing it makes express renew the cookie.
    expect(res.cleared.name).toBe("refreshToken");
    expect(res.cleared.opts).not.toHaveProperty("maxAge");
  });

  test("admins are held to the same window", async () => {
    mockUserFindById.mockResolvedValue({ _id: "user1", isActive: true, role: "admin" });
    mockTokenFindOne.mockResolvedValue(storedToken(45 * MINUTE));

    const res = makeRes();
    await refresh(makeReq(), res, jest.fn());

    expect(res.statusCode).toBe(401);
    expect(res.body.data.reason).toBe("idle_timeout");
  });

  test("customers are not idled out — only staff dashboards are", async () => {
    mockUserFindById.mockResolvedValue({ _id: "user1", isActive: true, role: "customer" });
    mockTokenFindOne.mockResolvedValue(storedToken(3 * 24 * 60 * MINUTE));

    const res = makeRes();
    await refresh(makeReq(), res, jest.fn());

    expect(res.statusCode).toBe(200);
  });

  test("a legacy token with no lastUsedAt falls back to createdAt", async () => {
    mockUserFindById.mockResolvedValue({ _id: "user1", isActive: true, role: "employee" });
    const token = storedToken(90 * MINUTE);
    token.lastUsedAt = undefined; // predates the field
    mockTokenFindOne.mockResolvedValue(token);

    const res = makeRes();
    await refresh(makeReq(), res, jest.fn());

    expect(res.statusCode).toBe(401);
    expect(res.body.data.reason).toBe("idle_timeout");
  });

  test("a revoked or unknown token is refused without an idle reason", async () => {
    mockUserFindById.mockResolvedValue({ _id: "user1", isActive: true, role: "employee" });
    mockTokenFindOne.mockResolvedValue(null);

    const res = makeRes();
    await refresh(makeReq(), res, jest.fn());

    expect(res.statusCode).toBe(401);
    expect(res.body.data).toBeUndefined();
  });

  test("no cookie at all is refused before anything is looked up", async () => {
    const res = makeRes();
    await refresh({ cookies: {} }, res, jest.fn());

    expect(res.statusCode).toBe(401);
    expect(mockTokenFindOne).not.toHaveBeenCalled();
  });
});
