import mongoose, { Schema, Document, Types } from 'mongoose';

export type ResultReviewStatus =
  | 'not_reviewed'
  | 'takedown_request'
  | 'report_infringement'
  | 'dispute'
  | 'legal_support_request';

export interface IResult extends Document {
  searchId: Types.ObjectId;
  image: string; // The found match image URL
  details: any;   // Flexible object for Vision/Yandex JSON data
  reviewStatus: ResultReviewStatus;
  reviewedAt?: Date | null;
}

const ResultSchema = new Schema<IResult>({
  searchId: { type: Schema.Types.ObjectId, ref: 'Search', required: true },
  image: { type: String, required: true },
  details: { type: Schema.Types.Mixed },
  reviewStatus: {
    type: String,
    enum: ['not_reviewed', 'takedown_request', 'report_infringement', 'dispute', 'legal_support_request'],
    default: 'not_reviewed',
  },
  reviewedAt: { type: Date, default: null },
});

export const Result = mongoose.model<IResult>('Result', ResultSchema);