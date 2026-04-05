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

async function sendPasswordReset({ to, name, resetUrl }) {
  if (!process.env.SMTP_USER) return; // skip if email not configured

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a1a;">Password Reset Request</h2>
      <p>Hi ${name || "there"},</p>
      <p>We received a request to reset your password. Click the button below to choose a new password.</p>
      <p style="text-align: center; margin: 24px 0;"><a href="${resetUrl}" style="background: #1a73e8; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 4px;">Reset Password</a></p>
      <p>If the button does not work, paste this link into your browser:</p>
      <p style="word-break: break-all;"><a href="${resetUrl}">${resetUrl}</a></p>
      <p style="color: #666; font-size: 13px;">If you did not request a password reset, you can safely ignore this email.</p>
    </div>
  `;

  await getTransporter().sendMail({
    from:    process.env.EMAIL_FROM || "Ghana Logistics Co. <no-reply@ghanalogistics.com>",
    to,
    subject: "Password Reset Instructions",
    html,
  });
}

async function sendPasswordChanged({ to, name }) {
  if (!process.env.SMTP_USER) return;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a1a;">Password Changed</h2>
      <p>Hi ${name || "there"},</p>
      <p>Your account password has been changed successfully.</p>
      <p>If you did not make this change, please contact support immediately.</p>
    </div>
  `;

  await getTransporter().sendMail({
    from:    process.env.EMAIL_FROM || "Ghana Logistics Co. <no-reply@ghanalogistics.com>",
    to,
    subject: "Your password has been changed",
    html,
  });
}

module.exports = { sendTrackingUpdate, sendPasswordReset, sendPasswordChanged };
