/**
 * Appointment-reminder emails for bookings WITHOUT a lead-magnet gift code —
 * the code-centric variants (nurtureT3Email/nurtureT1Email/nurtureDayOfEmail
 * in email.mjs) assume an offer + redemption code exist. The cron in
 * lib/cron.mjs picks the variant per booking.
 */

import { formatLongDate, formatTime12h } from './email.mjs';

const WRAPPER_OPEN = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;font-family:Georgia,'Times New Roman',serif;background:#F3F2F2;color:#201F1D;line-height:1.6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F2F2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border:1px solid #D7D3D3;border-radius:4px;">
        <tr><td style="padding:32px 32px 16px 32px;border-bottom:1px solid #B68235;">
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:600;letter-spacing:0.01em;color:#201F1D;">
            Suit Station
          </div>
        </td></tr>
        <tr><td style="padding:32px;">`;

const WRAPPER_CLOSE = `        </td></tr>
        <tr><td style="padding:24px 32px;background:#F3F2F2;border-top:1px solid #D7D3D3;font-size:13px;color:#605D5D;text-align:center;">
          150 Pearl Nix Pkwy, Gainesville GA 30501 &middot; <a href="tel:+14705957775" style="color:#7D5411;text-decoration:none;">(470) 595-7775</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function reminderT3Email({ booking, businessName, businessAddress, businessPhone, confirmUrl }) {
  const dateLong = formatLongDate(booking.slot.date);
  const time = formatTime12h(booking.slot.time);
  const subject = `Your ${businessName} visit — ${dateLong} at ${time}`;
  const safeFirst = escapeHtml(booking.customer.firstName);
  const html =
    WRAPPER_OPEN +
    `
    <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#201F1D;margin:0 0 12px 0;">${dateLong} is coming up, ${safeFirst}.</h1>
    <p style="margin:0 0 16px 0;">Just a heads-up — your visit to <strong>${escapeHtml(businessName)}</strong> is set for <strong>${dateLong} at ${time}</strong>. We wanted to make sure you had it on your calendar.</p>
    <p style="margin:0 0 16px 0;">📍 ${escapeHtml(businessAddress)} — free parking lot in front.</p>
    <p style="margin:0 0 16px 0;font-size:14px;color:#605D5D;">Need to reschedule? Call <a href="tel:${businessPhone}" style="color:#7D5411;">${businessPhone}</a> or reply to this email.</p>
    <p style="text-align:center;margin:24px 0 0 0;">
      <a href="${confirmUrl}" style="display:inline-block;background:#201F1D;color:#B68235;padding:12px 24px;text-decoration:none;font-family:Georgia,serif;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;font-size:13px;border-radius:2px;">View visit details</a>
    </p>
    ` +
    WRAPPER_CLOSE;
  const text =
    `${dateLong} is coming up, ${booking.customer.firstName}.\n\n` +
    `Your visit to ${businessName} is set for ${dateLong} at ${time}.\n` +
    `Where: ${businessAddress}\n\n` +
    `Reschedule: ${businessPhone}\n${confirmUrl}\n`;
  return { subject, html, text };
}

export function reminderT1Email({ booking, businessName, businessAddress, businessPhone, confirmUrl }) {
  const dateLong = formatLongDate(booking.slot.date);
  const time = formatTime12h(booking.slot.time);
  const subject = `See you tomorrow at ${time} — ${businessName}`;
  const safeFirst = escapeHtml(booking.customer.firstName);
  const html =
    WRAPPER_OPEN +
    `
    <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#201F1D;margin:0 0 12px 0;">See you tomorrow, ${safeFirst}.</h1>
    <p style="margin:0 0 16px 0;">We're set up for <strong>${time}</strong> tomorrow (${dateLong}) at <strong>${escapeHtml(businessName)}</strong>.</p>
    <h2 style="font-family:Georgia,serif;font-size:16px;color:#201F1D;margin:16px 0 8px 0;">Quick logistics</h2>
    <ul style="margin:0 0 20px 0;padding-left:20px;">
      <li style="margin-bottom:6px;">${escapeHtml(businessAddress)} — free parking lot in front.</li>
      <li style="margin-bottom:6px;">Check in at the front desk when you arrive.</li>
      <li>Running late or need to switch days? Call <a href="tel:${businessPhone}" style="color:#7D5411;">${businessPhone}</a>.</li>
    </ul>
    <p style="text-align:center;margin:24px 0 0 0;">
      <a href="${confirmUrl}" style="display:inline-block;background:#201F1D;color:#B68235;padding:12px 24px;text-decoration:none;font-family:Georgia,serif;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;font-size:13px;border-radius:2px;">View visit details</a>
    </p>
    ` +
    WRAPPER_CLOSE;
  const text =
    `See you tomorrow, ${booking.customer.firstName}.\n\n` +
    `${dateLong} at ${time}\n${businessAddress}\n\n` +
    `Late or rescheduling? ${businessPhone}\n${confirmUrl}\n`;
  return { subject, html, text };
}

export function reminderDayOfEmail({ booking, businessName, businessAddress, businessPhone }) {
  const time = formatTime12h(booking.slot.time);
  const subject = `Today at ${time} — see you soon`;
  const safeFirst = escapeHtml(booking.customer.firstName);
  const html =
    WRAPPER_OPEN +
    `
    <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#201F1D;margin:0 0 12px 0;">Today's the day, ${safeFirst}.</h1>
    <p style="margin:0 0 16px 0;font-size:18px;">Your visit to <strong>${escapeHtml(businessName)}</strong> is at <strong>${time}</strong> today.</p>
    <p style="margin:0 0 12px 0;">📍 <a href="https://maps.google.com/?q=${encodeURIComponent(businessAddress)}" style="color:#7D5411;">${escapeHtml(businessAddress)}</a></p>
    <p style="margin:0 0 12px 0;">📞 <a href="tel:${businessPhone}" style="color:#7D5411;">${businessPhone}</a></p>
    <p style="margin:24px 0 0 0;font-size:14px;color:#605D5D;">Check in at the front desk — we'll take it from there.</p>
    ` +
    WRAPPER_CLOSE;
  const text =
    `Today at ${time}, ${booking.customer.firstName}.\n\n` +
    `${businessAddress}\n${businessPhone}\n`;
  return { subject, html, text };
}
