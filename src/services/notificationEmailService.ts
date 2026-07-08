import { sendEmail, escapeHtml } from './emailTransport.js';

const BRAND_COLOR = '#2563eb';
const ADMIN_INBOX = process.env.CONTACT_INBOX_EMAIL || 'linkchat.office@gmail.com';

interface EmailUser {
  email: string;
  name: string;
}

interface EmailPlan {
  name: string;
  tier: string;
  price: number;
  currency: string;
  billingPeriod: string;
}

const formatMoney = (amount: number, currency: string): string =>
  amount > 0 ? `${currency} ${(amount / 100).toFixed(2)}` : 'Free';

const formatBillingPeriod = (period: string): string => period.replace('_', ' ');

/** Shared branded shell every notification email renders inside. */
function layout(title: string, bodyHtml: string): string {
  return `
  <div style="font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background:#f8fafc; padding:32px 16px;">
    <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #e2e8f0;">
      <div style="background:${BRAND_COLOR}; padding:22px 32px;">
        <span style="color:#ffffff; font-size:20px; font-weight:700; letter-spacing:-0.02em;">LinkChat</span>
      </div>
      <div style="padding:32px;">
        <h1 style="margin:0 0 16px; font-size:19px; color:#0f172a;">${escapeHtml(title)}</h1>
        ${bodyHtml}
      </div>
      <div style="padding:18px 32px; background:#f8fafc; border-top:1px solid #e2e8f0;">
        <p style="margin:0; font-size:12px; color:#94a3b8;">This is an automated message from LinkChat. Please don't reply directly to this email.</p>
      </div>
    </div>
  </div>`;
}

function detailRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:6px 0; color:#64748b; font-size:14px;">${escapeHtml(label)}</td>
    <td style="padding:6px 0; text-align:right; font-weight:600; color:#0f172a; font-size:14px;">${value}</td>
  </tr>`;
}

function detailTable(rows: string): string {
  return `<table style="width:100%; border-collapse:collapse; margin:16px 0;">${rows}</table>`;
}

function greeting(name: string): string {
  return `<p style="color:#334155; line-height:1.6; margin:0 0 12px;">Hi ${escapeHtml(name)},</p>`;
}

function paragraph(text: string): string {
  return `<p style="color:#334155; line-height:1.6; margin:0 0 12px;">${text}</p>`;
}

/** Compact "for your records" style email sent to the admin inbox alongside every user email. */
async function notifyAdmin(subject: string, title: string, bodyHtml: string, text: string): Promise<void> {
  await sendEmail({
    to: ADMIN_INBOX,
    subject: `[Admin] ${subject}`,
    html: layout(title, bodyHtml),
    text,
  });
}

// ─── Successful purchase (also serves as the payment confirmation / receipt) ─────────────────

export async function sendPurchaseSuccessEmail(
  user: EmailUser,
  plan: EmailPlan,
  receiptNumber: string
): Promise<void> {
  const rows = detailTable([
    detailRow('Plan', escapeHtml(plan.name)),
    detailRow('Amount paid', formatMoney(plan.price, plan.currency)),
    detailRow('Billing', formatBillingPeriod(plan.billingPeriod)),
    detailRow('Receipt number', escapeHtml(receiptNumber)),
  ].join(''));

  const body = greeting(user.name) +
    paragraph(`Your subscription to <strong>${escapeHtml(plan.name)}</strong> is now active. Thanks for supporting LinkChat!`) +
    rows +
    paragraph('Keep this email as your receipt for this purchase.');

  await sendEmail({
    to: user.email,
    subject: `Your ${plan.name} subscription is active`,
    html: layout('Subscription activated', body),
    text: `Hi ${user.name}, your subscription to ${plan.name} is now active. Amount paid: ${formatMoney(plan.price, plan.currency)}. Receipt: ${receiptNumber}.`,
  });

  await notifyAdmin(
    `Payment confirmed — ${user.email} — ${plan.name}`,
    'Payment confirmed',
    greeting('Admin') + paragraph(`${escapeHtml(user.email)} completed payment for <strong>${escapeHtml(plan.name)}</strong>.`) + detailTable([
      detailRow('User', escapeHtml(user.email)),
      detailRow('Plan', escapeHtml(plan.name)),
      detailRow('Amount', formatMoney(plan.price, plan.currency)),
      detailRow('Receipt number', escapeHtml(receiptNumber)),
    ].join('')),
    `${user.email} completed payment for ${plan.name}. Amount: ${formatMoney(plan.price, plan.currency)}. Receipt: ${receiptNumber}.`
  );
}

// ─── Free subscription granted by an admin ────────────────────────────────────────────────────

export async function sendFreeGrantEmail(
  user: EmailUser,
  plan: EmailPlan,
  reason: string | undefined,
  grantedByEmail: string
): Promise<void> {
  const body = greeting(user.name) +
    paragraph(`<strong>Congratulations! Your subscription has been activated.</strong>`) +
    paragraph(`An admin has granted you the <strong>${escapeHtml(plan.name)}</strong> plan, free of charge.`) +
    detailTable([
      detailRow('Plan', escapeHtml(plan.name)),
      detailRow('Billing', 'Complimentary'),
      ...(reason ? [detailRow('Note from admin', escapeHtml(reason))] : []),
    ].join('')) +
    paragraph('Enjoy the upgraded features right away — no action needed on your part.');

  await sendEmail({
    to: user.email,
    subject: `Congratulations! Your ${plan.name} subscription has been activated`,
    html: layout('Subscription activated', body),
    text: `Hi ${user.name}, congratulations! Your ${plan.name} subscription has been activated free of charge by an admin.${reason ? ` Note: ${reason}` : ''}`,
  });

  await notifyAdmin(
    `Free grant confirmed — ${user.email} — ${plan.name}`,
    'Free subscription granted',
    greeting('Admin') + paragraph(`You granted <strong>${escapeHtml(plan.name)}</strong> free of charge to ${escapeHtml(user.email)}.`) + detailTable([
      detailRow('User', escapeHtml(user.email)),
      detailRow('Plan', escapeHtml(plan.name)),
      detailRow('Granted by', escapeHtml(grantedByEmail)),
      ...(reason ? [detailRow('Reason', escapeHtml(reason))] : []),
    ].join('')),
    `You granted ${plan.name} free of charge to ${user.email}.${reason ? ` Reason: ${reason}` : ''}`
  );
}

// ─── Credit allocation ─────────────────────────────────────────────────────────────────────────

export async function sendCreditAllocationEmail(
  user: EmailUser,
  amount: number,
  balanceAfter: number,
  reason: string | undefined,
  grantedByEmail: string
): Promise<void> {
  const body = greeting(user.name) +
    paragraph(`You've received <strong>${amount.toLocaleString()} credits</strong> on your LinkChat account.`) +
    detailTable([
      detailRow('Credits added', amount.toLocaleString()),
      detailRow('New balance', balanceAfter.toLocaleString()),
      ...(reason ? [detailRow('Reason', escapeHtml(reason))] : []),
    ].join(''));

  await sendEmail({
    to: user.email,
    subject: `${amount.toLocaleString()} credits added to your account`,
    html: layout('Credits added', body),
    text: `Hi ${user.name}, ${amount.toLocaleString()} credits were added to your account. New balance: ${balanceAfter.toLocaleString()}.${reason ? ` Reason: ${reason}` : ''}`,
  });

  await notifyAdmin(
    `Credits granted — ${user.email}`,
    'Credits granted',
    greeting('Admin') + paragraph(`You granted <strong>${amount.toLocaleString()} credits</strong> to ${escapeHtml(user.email)}.`) + detailTable([
      detailRow('User', escapeHtml(user.email)),
      detailRow('Credits added', amount.toLocaleString()),
      detailRow('New balance', balanceAfter.toLocaleString()),
      detailRow('Granted by', escapeHtml(grantedByEmail)),
    ].join('')),
    `You granted ${amount.toLocaleString()} credits to ${user.email}. New balance: ${balanceAfter.toLocaleString()}.`
  );
}

// ─── Subscription renewal / expiry ─────────────────────────────────────────────────────────────

export async function sendSubscriptionRenewalEmail(user: EmailUser, plan: EmailPlan, expiresAt: Date): Promise<void> {
  const body = greeting(user.name) +
    paragraph(`Your <strong>${escapeHtml(plan.name)}</strong> subscription has been renewed.`) +
    detailTable([
      detailRow('Plan', escapeHtml(plan.name)),
      detailRow('Renewed until', expiresAt.toLocaleDateString()),
    ].join(''));

  await sendEmail({
    to: user.email,
    subject: `Your ${plan.name} subscription has been renewed`,
    html: layout('Subscription renewed', body),
    text: `Hi ${user.name}, your ${plan.name} subscription has been renewed until ${expiresAt.toLocaleDateString()}.`,
  });

  await notifyAdmin(
    `Subscription renewed — ${user.email}`,
    'Subscription renewed',
    greeting('Admin') + paragraph(`${escapeHtml(user.email)}'s <strong>${escapeHtml(plan.name)}</strong> subscription was renewed until ${expiresAt.toLocaleDateString()}.`),
    `${user.email}'s ${plan.name} subscription was renewed until ${expiresAt.toLocaleDateString()}.`
  );
}

export async function sendSubscriptionExpiryEmail(user: EmailUser, plan: EmailPlan): Promise<void> {
  const body = greeting(user.name) +
    paragraph(`Your <strong>${escapeHtml(plan.name)}</strong> subscription has expired. Your account has reverted to the Free plan.`) +
    paragraph('You can resubscribe anytime from the pricing page to restore premium features.');

  await sendEmail({
    to: user.email,
    subject: `Your ${plan.name} subscription has expired`,
    html: layout('Subscription expired', body),
    text: `Hi ${user.name}, your ${plan.name} subscription has expired and your account has reverted to the Free plan.`,
  });

  await notifyAdmin(
    `Subscription expired — ${user.email}`,
    'Subscription expired',
    greeting('Admin') + paragraph(`${escapeHtml(user.email)}'s <strong>${escapeHtml(plan.name)}</strong> subscription has expired and reverted to Free.`),
    `${user.email}'s ${plan.name} subscription has expired and reverted to Free.`
  );
}

// ─── Account status changes ─────────────────────────────────────────────────────────────────────

export type AccountStatusChange = 'suspended' | 'reactivated' | 'banned';

const STATUS_COPY: Record<AccountStatusChange, { subject: string; title: string; message: string }> = {
  suspended: {
    subject: 'Your LinkChat account has been suspended',
    title: 'Account suspended',
    message: 'Your account has been temporarily suspended. You will not be able to sign in until it is reactivated.',
  },
  reactivated: {
    subject: 'Your LinkChat account has been reactivated',
    title: 'Account reactivated',
    message: 'Good news — your account has been reactivated and you can sign in normally again.',
  },
  banned: {
    subject: 'Your LinkChat account has been banned',
    title: 'Account banned',
    message: 'Your account has been permanently banned for violating LinkChat policies.',
  },
};

export async function sendAccountStatusEmail(
  user: EmailUser,
  change: AccountStatusChange,
  reason: string | undefined,
  changedByEmail: string
): Promise<void> {
  const copy = STATUS_COPY[change];
  const body = greeting(user.name) +
    paragraph(copy.message) +
    (reason ? detailTable(detailRow('Reason', escapeHtml(reason))) : '');

  await sendEmail({
    to: user.email,
    subject: copy.subject,
    html: layout(copy.title, body),
    text: `Hi ${user.name}, ${copy.message}${reason ? ` Reason: ${reason}` : ''}`,
  });

  await notifyAdmin(
    `Account ${change} — ${user.email}`,
    `Account ${change}`,
    greeting('Admin') + paragraph(`${escapeHtml(user.email)}'s account was marked <strong>${change}</strong> by ${escapeHtml(changedByEmail)}.`) +
      (reason ? detailTable(detailRow('Reason', escapeHtml(reason))) : ''),
    `${user.email}'s account was marked ${change} by ${changedByEmail}.${reason ? ` Reason: ${reason}` : ''}`
  );
}
