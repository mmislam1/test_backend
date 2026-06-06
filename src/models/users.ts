import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUser extends Document {
  name: string;
  image?: string;
  affiliation?: string;
  jobTitle?: string;           // "specific role" from signup (e.g. Designer, CEO)
  country?: string;            // primary country/region
  email: string;
  phoneNumber?: string;
  joiningDate: Date;
  role: 'admin' | 'general';
  isApproved: boolean;
  subscriptionId?: Types.ObjectId;
  credits: number;             // monitoring (search) credits remaining
  alertsRemaining: number;     // notification alert quota remaining (-1 = unlimited, 0 = exhausted)
  monitors: number;
  isActive: boolean;
  testimonial?: string;
  rating?: number;
  referralCount: number;
  refferedBy?: Types.ObjectId;
  referralCode: string;
  /** Timestamp when the referral code was last shared/generated (24-h window anchor) */
  referralCodeGeneratedAt?: Date;
  /** True while the 24-h referral window is open */
  referralWindowActive: boolean;
  /** Permanently unlocked PDF/Reports access via referral milestone */
  permanentPdfAccess: boolean;
  passwordHash?: string;       // optional — absent for pure OAuth users
  googleId?: string;           // Google OAuth subject ID
  refreshTokenHash?: string;   // hashed refresh token for rotation
  emailVerified?: boolean;
  emailVerificationTokenHash?: string;
  emailVerificationExpiresAt?: Date;
  passwordResetTokenHash?: string;
  passwordResetExpiresAt?: Date;
  lastLoginAt?: Date;
  notificationSettings: {
    emailEnabled: boolean;
    inAppEnabled: boolean;
    weeklyRescanEnabled: boolean;
    notifyOnNewMatches: boolean;
    summaryFrequency: 'instant' | 'daily' | 'weekly';
  };
  createdAt: Date;
  updatedAt: Date;
  paddleCustomerId?: string;        
  paddleSubscriptionId?: string;    
  subscriptionStatus?: 'active' | 'trialing' | 'past_due' | 'canceled' | 'paused';
}

const UserSchema = new Schema<IUser>(
  {
    name:          { type: String, required: true, trim: true },
    image:         { type: String },
    affiliation:   { type: String, trim: true },
    jobTitle:      { type: String, trim: true },
    country:       { type: String, trim: true },
    email:         { type: String, required: true, unique: true, lowercase: true, trim: true },
    phoneNumber:   { type: String, trim: true },
    joiningDate:   { type: Date, default: Date.now },
    role:          { type: String, enum: ['admin', 'general'], default: 'general' },
    isApproved:    { type: Boolean, default: true },
    subscriptionId:{ type: Schema.Types.ObjectId, ref: 'Subscription' },
    credits:       { type: Number, default: 0 },
    alertsRemaining: { type: Number, default: 0 },
    monitors:      { type: Number, default: 0 },
    isActive:      { type: Boolean, default: true },
    testimonial:   { type: String },
    rating:        { type: Number, min: 0, max: 5 },
    referralCount: { type: Number, default: 0 },
    refferedBy:    { type: Schema.Types.ObjectId, ref: 'User' },
    referralCode: {
      type: String,
      unique: true,
      default: () =>
        new mongoose.Types.ObjectId().toHexString().slice(-6).toUpperCase(),
    },
    referralCodeGeneratedAt: { type: Date },
    referralWindowActive:    { type: Boolean, default: false },
    permanentPdfAccess:      { type: Boolean, default: false },
    passwordHash:     { type: String },
    googleId:         { type: String, unique: true, sparse: true },
    refreshTokenHash: { type: String },
    emailVerified: { type: Boolean, default: false },
    emailVerificationTokenHash: { type: String },
    emailVerificationExpiresAt: { type: Date },
    passwordResetTokenHash: { type: String },
    passwordResetExpiresAt: { type: Date },
    lastLoginAt:      { type: Date },
    
    paddleCustomerId: { type: String, sparse: true },
    paddleSubscriptionId: { type: String, sparse: true },
    subscriptionStatus: { type: String, enum: ['active', 'trialing', 'past_due', 'canceled', 'paused'] },
    notificationSettings: {
      emailEnabled: { type: Boolean, default: true },
      inAppEnabled: { type: Boolean, default: true },
      weeklyRescanEnabled: { type: Boolean, default: true },
      notifyOnNewMatches: { type: Boolean, default: true },
      summaryFrequency: {
        type: String,
        enum: ['instant', 'daily', 'weekly'],
        default: 'instant',
      },
    },
  },
  { timestamps: true }
);

// Indexes for frequent look-ups
//UserSchema.index({ referralCode: 1 });
//UserSchema.index({ googleId: 1 });

export const User =
  mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
