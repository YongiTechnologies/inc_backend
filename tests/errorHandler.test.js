"use strict";

/**
 * Upload mistakes are the client's, so they must not come back as 500s (which
 * read as "the server broke" in logs and monitoring).
 */

const multer = require("multer");
const { errorHandler } = require("../src/middleware/errorHandler");

function makeRes() {
  return {
    statusCode: null,
    body:       null,
    status(code) { this.statusCode = code; return this; },
    json(body)   { this.body = body; return this; },
  };
}

const req = { method: "POST", path: "/api/v2/uploads" };

beforeAll(() => jest.spyOn(console, "error").mockImplementation(() => {}));
afterAll(() => console.error.mockRestore());

it("a file over the size limit is a 413 that names the limit", () => {
  const res = makeRes();
  errorHandler(new multer.MulterError("LIMIT_FILE_SIZE"), req, res, jest.fn());
  expect(res.statusCode).toBe(413);
  expect(res.body.message).toMatch(/10 MB/);
});

it("other upload rejections are 400s", () => {
  const res = makeRes();
  errorHandler(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "file"), req, res, jest.fn());
  expect(res.statusCode).toBe(400);
});

it("an error carrying a statusCode keeps it (e.g. the wrong file type)", () => {
  const res = makeRes();
  errorHandler(Object.assign(new Error("Only .xlsx and .xls files are accepted"), { statusCode: 400 }), req, res, jest.fn());
  expect(res.statusCode).toBe(400);
  expect(res.body.message).toBe("Only .xlsx and .xls files are accepted");
});
