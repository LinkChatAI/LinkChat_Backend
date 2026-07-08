import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from '../utils/logger.js';

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

let gmailTransporter: Transporter | null = null;

function getGmailTransporter(): Transporter | null {
  const user = process.env.GMAIL_USER?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, '').trim();
  if (!user || !pass) return null;

  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  }
  return gmailTransporter;
}

async function sendViaGmail(params: SendEmailParams): Promise<boolean> {
  const transporter = getGmailTransporter();
  const fromUser = process.env.GMAIL_USER?.trim();
  if (!transporter || !fromUser) return false;

  const fromName = process.env.GMAIL_FROM_NAME || 'LinkChat';
  await transporter.sendMail({
    from: `"${fromName}" <${fromUser}>`,
    to: params.to,
    replyTo: params.replyTo,
    subject: params.subject,
    text: params.text,
    html: params.html,
  });
  return true;
}

async function sendViaResend(params: SendEmailParams): Promise<boolean> {
  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (!resendKey || resendKey.startsWith('re_your')) return false;

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
        to: [params.to],
        subject: params.subject,
        html: params.html,
        text: params.text,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      logger.warn('Resend email failed', { status: res.status, errText, subject: params.subject });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('Resend email error', {
      error: err instanceof Error ? err.message : String(err),
      subject: params.subject,
    });
    return false;
  }
}

/**
 * Best-effort transactional email send — tries Gmail, falls back to Resend. Never throws;
 * logs and returns false on failure so callers can fire-and-forget without letting an email
 * outage block the triggering action (a subscription grant, a ban, etc.).
 */
export async function sendEmail(params: SendEmailParams): Promise<boolean> {
  try {
    if (await sendViaGmail(params)) return true;
  } catch (err) {
    logger.error('Gmail send failed', {
      error: err instanceof Error ? err.message : String(err),
      subject: params.subject,
    });
  }

  if (await sendViaResend(params)) return true;

  logger.warn('Email not sent — set GMAIL_USER/GMAIL_APP_PASSWORD or RESEND_API_KEY', {
    to: params.to,
    subject: params.subject,
  });
  return false;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
