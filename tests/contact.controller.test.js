"use strict";

/**
 * The contact form's staff email: visitor text must arrive as text, not as
 * HTML a sender could use to plant links, and replies go to the visitor.
 */

const mockSendEmail = jest.fn();
jest.mock("../src/services/email.service", () => ({ sendEmail: (...a) => mockSendEmail(...a) }));

const { submitContact } = require("../src/controllers/contact.controller");

function makeRes() {
  return {
    statusCode: null,
    body:       null,
    status(code) { this.statusCode = code; return this; },
    json(body)   { this.body = body; return this; },
  };
}

beforeEach(() => {
  mockSendEmail.mockReset().mockResolvedValue();
  process.env.CONTACT_EMAIL = "office@example.com";
});

it("escapes the visitor's text and sets Reply-To to the visitor", async () => {
  const res = makeRes();
  await submitContact({ body: {
    name:    "Yaw <b>Mensah</b>",
    email:   "yaw@example.com",
    phone:   "0244000000",
    subject: "Where is my parcel?",
    message: 'Click <a href="https://evil.example">here</a> to\nverify',
  } }, res, jest.fn());

  expect(res.statusCode).toBe(200);
  const mail = mockSendEmail.mock.calls[0][0];
  expect(mail.to).toBe("office@example.com");
  expect(mail.replyTo).toBe("yaw@example.com");
  expect(mail.html).not.toContain('<a href="https://evil.example">');
  expect(mail.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
  expect(mail.html).toContain("Yaw &lt;b&gt;Mensah&lt;/b&gt;");
  expect(mail.html).toContain("to<br>verify"); // line breaks still kept
});

it("reports a failed send honestly, without exposing the mail server's reply", async () => {
  mockSendEmail.mockRejectedValue(new Error("550 You can only send testing emails to your own email address (owner@example.com)"));
  jest.spyOn(console, "error").mockImplementation(() => {});
  const res = makeRes();
  await submitContact({ body: { name: "Ama", email: "ama@example.com", subject: "Hi", message: "Hello there, testing." } }, res, jest.fn());

  expect(res.statusCode).toBe(503);
  expect(res.body.success).toBe(false);
  expect(res.body.message).toMatch(/couldn't send your message/);
  expect(JSON.stringify(res.body)).not.toMatch(/550|owner@example\.com/);
  console.error.mockRestore();
});
