const nodemailer = require("nodemailer");

let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_PORT === "465",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

async function sendTrackingUpdate({ to, name, trackingNumber, statusLabel, location, note }) {
  if (!process.env.SMTP_USER) return; // skip if email not configured

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a1a;">Shipment Update</h2>
      <p>Hi ${name},</p>
      <p>Your shipment <strong>${trackingNumber}</strong> has been updated.</p>
      <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
        <tr>
          <td style="padding: 8px 12px; background: #f5f5f5; font-weight: bold; width: 40%;">Status</td>
          <td style="padding: 8px 12px; border: 1px solid #e0e0e0;">${statusLabel}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; background: #f5f5f5; font-weight: bold;">Location</td>
          <td style="padding: 8px 12px; border: 1px solid #e0e0e0;">${location.city}, ${location.country}</td>
        </tr>
        ${note ? `<tr>
          <td style="padding: 8px 12px; background: #f5f5f5; font-weight: bold;">Note</td>
          <td style="padding: 8px 12px; border: 1px solid #e0e0e0;">${note}</td>
        </tr>` : ""}
      </table>
      <p style="color: #666; font-size: 13px;">Track your shipment at any time using your tracking number.</p>
    </div>
  `;

  await getTransporter().sendMail({
    from:    process.env.EMAIL_FROM || "Ghana Logistics Co. <no-reply@ghanalogistics.com>",
    to,
    subject: `Shipment Update: ${trackingNumber} — ${statusLabel}`,
    html,
  });
}

module.exports = { sendTrackingUpdate };
