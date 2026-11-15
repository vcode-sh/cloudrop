export { CloudropError, type CloudropErrorCode, type Result } from "./errors.ts";
export type {
  CompletedPart,
  FetchLike,
  ListedObject,
  ObjectInfo,
  ObjectOptions,
  PartInfo,
  PresignedRequest,
  StorageDriver,
  WriteOptions,
} from "./storage/driver.ts";
export { type R2Options, r2, type S3Options, s3 } from "./storage/presets.ts";
