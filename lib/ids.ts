import { randomBytes } from "node:crypto";

export function newId(prefix: "cap" | "run" | "cab"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
