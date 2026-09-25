/**
 * Stored profile pictures.
 *
 * The bytes live in the database rather than in object storage because a
 * self-hosted instance has a database and may have nothing else, and a
 * profile picture is small and bounded. `key` is 128 random bits, regenerated
 * on every upload — see `services/avatar/store.ts` for why that is what keeps
 * the public route private enough.
 */
import { Schema, model } from "mongoose";

export interface IAvatar {
  userId: string;
  key: string;
  contentType: string;
  size: number;
  bytes: Buffer;
}

const avatarSchema = new Schema<IAvatar>(
  {
    userId: { type: String, required: true, unique: true },
    key: { type: String, required: true, index: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    bytes: { type: Buffer, required: true },
  },
  { timestamps: true },
);

export const Avatar = model<IAvatar>("Avatar", avatarSchema);
