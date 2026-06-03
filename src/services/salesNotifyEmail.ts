import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from '../utils/logger.js';

export interface SalesInquiryPayload {
  name: string;
  phone: string;
  plan: string;
  email?: string;
  notes?: string;
}

const INBOX = process.env.CONTACT_INBOX_EMAIL || 'linkchat.office@gmail.com';

let gmailTransporter: Transporter | null = null;

function getGmailTransporter(): Transporter | null {
  const user = process.env.GMAIL_USER?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, '').trim();

  if (!user || !pass) {
    return null;
  }

  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  }

  return gmailTransporter;
}

async function sendViaGmail(
  payload: SalesInquiryPayload,
  subject: string,
  bodyText: string
): Promise<boolean> {
  const transporter = getGmailTransporter();
  if (!transporter) {
    return false;
  }

  const fromName = process.env.GMAIL_FROM_NAME || 'LinkChat Sales';
  const fromUser = process.env.GMAIL_USER?.trim() || INBOX;

  await transporter.sendMail({
    from: `"${fromName}" <${fromUser}>`,
    to: INBOX,
    replyTo: payload.email || undefined,
    subject,
    text: bodyText,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; color: #1e293b;">
        <h2 style="color: #2563eb; margin-bottom: 8px;">New plan subscription inquiry</h2>
        <p style="margin: 0 0 16px; color: #64748b;">A visitor submitted the pricing form on LinkChat.</p>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 8px 0; font-weight: bold;">Plan</td><td>${escapeHtml(payload.plan)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: bold;">Name</td><td>${escapeHtml(payload.name)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: bold;">Phone</td><td><a href="tel:${escapeHtml(payload.phone)}">${escapeHtml(payload.phone)}</a></td></tr>
          <tr><td style="padding: 8px 0; font-weight: bold;">Email</td><td>${payload.email ? escapeHtml(payload.email) : '(not provided)'}</td></tr>
          ${payload.notes ? `<tr><td style="padding: 8px 0; font-weight: bold; vertical-align: top;">Notes</td><td>${escapeHtml(payload.notes)}</td></tr>` : ''}
        </table>
        <p style="margin-top: 20px; font-size: 12px; color: #94a3b8;">Submitted at ${new Date().toISOString()}</p>
      </div>
    `,
  });

  logger.info('Sales inquiry email sent via Gmail', { to: INBOX, plan: payload.plan });
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendViaResend(subject: string, bodyText: string): Promise<boolean> {
  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (!resendKey || resendKey.startsWith('re_your')) {
    return false;
  }

  try {
    const from = process.env.RESEND_FROM_EMAIL || 'LinkChat <onboarding@resend.dev>';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [INBOX],
        subject,
        text: bodyText,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      logger.warn('Resend email failed for sales inquiry', { status: res.status, errText });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('Resend email error for sales inquiry', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function notifySalesTeam(payload: SalesInquiryPayload): Promise<void> {
  const subject = `[LinkChat Sales] ${payload.plan} plan inquiry — ${payload.name}`;
  const bodyText = [
    'New plan subscription inquiry',
    '',
    `Plan: ${payload.plan}`,
    `Name: ${payload.name}`,
    `Phone: ${payload.phone}`,
    payload.email ? `Email: ${payload.email}` : 'Email: (not provided)',
    payload.notes ? `Notes: ${payload.notes}` : '',
    '',
    `Submitted at: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    if (await sendViaGmail(payload, subject, bodyText)) {
      return;
    }
  } catch (err) {
    logger.error('Gmail send failed for sales inquiry', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (await sendViaResend(subject, bodyText)) {
    return;
  }

  logger.warn('Sales inquiry saved but email not sent — set GMAIL_USER and GMAIL_APP_PASSWORD in .env', {
    to: INBOX,
    subject,
    plan: payload.plan,
  });
}
