const emailService = require("../services/email.service");
const { respond } = require("../utils/response");

// The visitor's text goes into an HTML email for staff. Escape it so a sender
// can't slip markup (a convincing fake link, hidden content) into that email.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Handle contact form submission
 */
async function submitContact(req, res, next) {
  try {
    const [name, email, phone, subject, message] =
      ["name", "email", "phone", "subject", "message"].map((k) => escapeHtml(req.body[k]));

    // Send email using existing email service
    const contactEmail = process.env.CONTACT_EMAIL || process.env.EMAIL_FROM;

    const html = `
        <h2>New Contact Form Submission</h2>
        <table style="border-collapse: collapse; width: 100%;">
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Name:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${name}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Email:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${email}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Phone:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${phone || 'Not provided'}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Subject:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${subject}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Message:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${message.replace(/\n/g, '<br>')}</td>
          </tr>
        </table>
      `;

    try {
      await emailService.sendEmail({
        to: contactEmail,
        replyTo: req.body.email, // staff reply straight to the visitor, not to no-reply
        subject: `New Contact Form Submission: ${req.body.subject}`,
        html,
      });
    } catch (err) {
      // Never show a visitor the mail server's reply: it can name the mail
      // account and other internals. The detail goes to the server log.
      console.error("[Contact] email send failed:", err.message);
      return respond(res, 503, false,
        "Sorry, we couldn't send your message right now. Please try again later or call us.");
    }

    return respond(res, 200, true, "Message sent. We will get back to you shortly.");
  } catch (err) { next(err); }
}

module.exports = { submitContact };
