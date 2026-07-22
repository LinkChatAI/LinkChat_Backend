import mongoose, { Schema } from 'mongoose';

/**
 * Singleton document (`_id: 'global'`) holding the runtime-configurable
 * donation rules — the admin dashboard's kill switch and knobs, so enabling or
 * tuning donations never needs a redeploy. Same pattern as AdminSetting.
 *
 * Read through donationService.getDonationSettings() (in-process cache with a
 * short TTL), never queried directly from request handlers.
 */
export interface IDonationSettings {
  _id: string;

  /** Master kill switch — when false, config reports disabled and order creation is rejected. */
  enabled: boolean;

  // Amount rules (paise)
  minAmount: number;
  maxAmount: number;
  presetAmounts: number[];

  // Donation popup copy
  title: string;
  message: string;
  thankYouMessage: string;

  // Payment method toggles (mapped to Razorpay Checkout display blocks)
  upiEnabled: boolean;
  cardEnabled: boolean;
  netbankingEnabled: boolean;
  walletEnabled: boolean;

  /** Email a receipt to donors who provide an email address. */
  sendReceiptEmail: boolean;

  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const DONATION_SETTINGS_DEFAULTS: Omit<IDonationSettings, '_id' | 'createdAt' | 'updatedAt' | 'updatedBy'> = {
  enabled: true,
  minAmount: 1000, // ₹10
  maxAmount: 5000000, // ₹50,000
  presetAmounts: [4900, 9900, 19900, 49900], // ₹49 / ₹99 / ₹199 / ₹499
  title: 'Support LinkChat',
  message:
    'LinkChat is built and maintained by a small independent team. Your donation goes directly toward cloud hosting, bandwidth, and keeping rooms fast, private, and free for everyone. Every contribution, big or small, helps us keep the lights on.',
  thankYouMessage:
    'Thank you for supporting LinkChat. Your contribution helps us keep the service fast, private, and free for everyone.',
  upiEnabled: true,
  cardEnabled: true,
  netbankingEnabled: true,
  walletEnabled: true,
  sendReceiptEmail: true,
};

const DonationSettingsSchema = new Schema<IDonationSettings>(
  {
    _id: { type: String, default: 'global' },

    enabled: { type: Boolean, required: true, default: DONATION_SETTINGS_DEFAULTS.enabled },

    minAmount: { type: Number, required: true, min: 100, max: 10000000 },
    maxAmount: { type: Number, required: true, min: 100, max: 50000000 },
    presetAmounts: {
      type: [Number],
      default: DONATION_SETTINGS_DEFAULTS.presetAmounts,
      validate: {
        validator: (arr: number[]) =>
          arr.length >= 1 && arr.length <= 6 && arr.every((n) => Number.isInteger(n) && n >= 100),
        message: '1-6 preset amounts required, each an integer >= 100 paise',
      },
    },

    title: { type: String, required: true, maxlength: 80 },
    message: { type: String, required: true, maxlength: 1000 },
    thankYouMessage: { type: String, required: true, maxlength: 500 },

    upiEnabled: { type: Boolean, required: true, default: true },
    cardEnabled: { type: Boolean, required: true, default: true },
    netbankingEnabled: { type: Boolean, required: true, default: true },
    walletEnabled: { type: Boolean, required: true, default: true },

    sendReceiptEmail: { type: Boolean, required: true, default: true },

    updatedBy: { type: String },
  },
  {
    timestamps: true,
    collection: 'donationsettings',
  }
);

export const DonationSettingsModel = mongoose.model<IDonationSettings>(
  'DonationSetting',
  DonationSettingsSchema
);
