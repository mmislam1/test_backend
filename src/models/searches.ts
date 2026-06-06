import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ISearch extends Document {
  image: string; // URL to S3/Cloudinary or encoded string
  status: 'processing' | 'completed' | 'failed' | 'reviewPending';
  userId: Types.ObjectId;
  folderId?: Types.ObjectId;
  date: Date;
  nextRescanAt?: Date;
  lastRescanAt?: Date;
}

const SearchSchema = new Schema<ISearch>({
  image: { type: String, required: true },
  status: { type: String, default: 'reviewPending' },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  folderId: { type: Schema.Types.ObjectId, ref: 'Folder', required: false },
  date: { type: Date, default: Date.now },
  nextRescanAt: { type: Date, required: false },
  lastRescanAt: { type: Date, required: false },
});

export const Search = mongoose.model<ISearch>('Search', SearchSchema);