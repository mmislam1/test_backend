import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IYandexMatch {
  url: string;
  title?: string;
  domain?: string;
}

export interface IYandexQuery extends Document {
  userId: Types.ObjectId;
  status: 'SUCCESS' | 'NO_RESULTS' | 'FAILED';
  reviewPending: boolean;
  results: IYandexMatch[];
  errorMessage?: string;
}

const YandexQuerySchema = new Schema<IYandexQuery>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['SUCCESS', 'NO_RESULTS', 'FAILED'], required: true },
    reviewPending: { type: Boolean, default: false },
    results: [
      {
        url: { type: String, required: true },
        title: { type: String },
        domain: { type: String },
      },
    ],
    errorMessage: { type: String },
  },
  { timestamps: true }
);

export const YandexQuery = mongoose.model<IYandexQuery>('YandexQuery', YandexQuerySchema);