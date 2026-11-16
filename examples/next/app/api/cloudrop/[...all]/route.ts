import { toNextHandler } from "cloudrop/next";
import { cloudrop } from "../../../../lib/cloudrop";

export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);
