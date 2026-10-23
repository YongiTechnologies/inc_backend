"use strict";

/**
 * Password handling after the sign-in simplification:
 *  - an admin resets a forgotten password (POST /api/admin/users/:id/reset-password);
 *  - the phone "create a password" path is closed, because it let anyone who
 *    knew a customer's number set that account's password;
 *  - the public phone check no longer reveals the account holder's name.
 */

const mockFindById     = jest.fn();
const mockFindOne      = jest.fn();
const mockDeleteMany   = jest.fn();
const mockAuditLog     = jest.fn();

jest.mock("../src/models/User", () => ({
  findById: (...a) => mockFindById(...a),
  findOne:  (...a) => mockFindOne(...a),
}));
jest.mock("../src/models/RefreshToken", () => ({ deleteMany: (...a) => mockDeleteMany(...a) }));
jest.mock("../src/models/AuditLog", () => ({}));
jest.mock("../src/models/ShipmentItem", () => ({}));
jest.mock("../src/services/email.service", () => ({}));
jest.mock("../src/services/audit.service", () => ({ log: (...a) => mockAuditLog(...a) }));
jest.mock("../src/utils/jwt", () => ({ signAccess: jest.fn(), signRefresh: jest.fn(), verifyRefresh: jest.fn() }));

const { resetPassword, generateTempPassword } = require("../src/controllers/admin.controller");
const { phoneCheck, phoneSetPassword }        = require("../src/controllers/auth.controller");

// Minimal express res double capturing what the controller sent.
function makeRes() {
  return {
    statusCode: null,
    body:       null,
    status(code) { this.statusCode = code; return this; },
    json(body)   { this.body = body; return this; },
  };
}

function makeUser(overrides = {}) {
  return { _id: "u1", provider: "google", password: undefined, save: jest.fn().mockResolvedValue(), ...overrides };
}

const admin = { _id: "admin1" };

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteMany.mockResolvedValue({ deletedCount: 3 });
  mockAuditLog.mockResolvedValue();
});

describe("generateTempPassword", () => {
  it("is 10 characters with no look-alike characters", () => {
    for (let i = 0; i < 50; i++) {
      const p = generateTempPassword();
      expect(p).toHaveLength(10);
      expect(p).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]+$/);
    }
  });
});

describe("resetPassword (admin)", () => {
  it("generates a temporary password, returns it once, and ends every session", async () => {
    const user = makeUser();
    mockFindById.mockResolvedValue(user);
    const res = makeRes();

    await resetPassword({ params: { id: "u1" }, body: {}, user: admin, ip: "1.2.3.4" }, res, jest.fn());

    expect(res.statusCode).toBe(200);
    const temp = res.body.data.temporaryPassword;
    expect(temp).toHaveLength(10);
    expect(user.password).toBe(temp);
    expect(user.provider).toBe("local");
    expect(user.save).toHaveBeenCalled();
    expect(mockDeleteMany).toHaveBeenCalledWith({ userId: "u1" });
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      performedBy: "admin1", action: "RESET_PASSWORD", targetId: "u1", details: { generated: true },
    }));
  });

  it("uses a password the admin typed and never echoes it back", async () => {
    const user = makeUser({ provider: "local" });
    mockFindById.mockResolvedValue(user);
    const res = makeRes();

    await resetPassword({ params: { id: "u1" }, body: { password: "chosen-by-admin" }, user: admin }, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(user.password).toBe("chosen-by-admin");
    expect(res.body.data).toEqual({});
    expect(JSON.stringify(res.body)).not.toContain("chosen-by-admin");
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ details: { generated: false } }));
  });

  it("rejects a password shorter than 8 characters without touching the user", async () => {
    const res = makeRes();
    await resetPassword({ params: { id: "u1" }, body: { password: "short" }, user: admin }, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown user", async () => {
    mockFindById.mockResolvedValue(null);
    const res = makeRes();
    await resetPassword({ params: { id: "nope" }, body: {}, user: admin }, res, jest.fn());

    expect(res.statusCode).toBe(404);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});

describe("phone sign-in", () => {
  it("no longer lets a password-less account be claimed by phone number", async () => {
    const res = makeRes();
    await phoneSetPassword({ body: { phone: "0244000000", password: "attacker-pass" } }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/contact us/i);
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it("phone check does not reveal the account holder's name", async () => {
    mockFindOne.mockReturnValue({ select: () => Promise.resolve({ name: "Ama Owusu", password: "$2b$hash" }) });
    const res = makeRes();
    await phoneCheck({ body: { phone: "0244000000" } }, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ exists: true, hasPassword: true });
    expect(JSON.stringify(res.body)).not.toContain("Ama Owusu");
  });
});
