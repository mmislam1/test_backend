import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IPendingRegistration extends Document {
  name: string;
  email: string;
  passwordHash: string;
  affiliation?: string;
  jobTitle?: string;
  country?: string;
  phoneNumber?: string;
  referredBy?: Types.ObjectId;
  emailVerificationTokenHash: string;
  emailVerificationExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PendingRegistrationSchema = new Schema<IPendingRegistration>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    affiliation: { type: String, trim: true },
    jobTitle: { type: String, trim: true },
    country: { type: String, trim: true },
    phoneNumber: { type: String, trim: true },
    referredBy: { type: Schema.Types.ObjectId, ref: 'User' },
    emailVerificationTokenHash: { type: String, required: true },
    emailVerificationExpiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Automatically remove expired pending registrations.
PendingRegistrationSchema.index({ emailVerificationExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const PendingRegistration =
  mongoose.models.PendingRegistration ||
  mongoose.model<IPendingRegistration>('PendingRegistration', PendingRegistrationSchema);
