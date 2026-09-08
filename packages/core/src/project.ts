import { sha256 } from "./canonical.js";
import { utf8 } from "./encoding.js";

/** sha256(utf8(repository_id) || 0x00 || utf8(trustchainRootId)) as hex. The 0x00 makes the concatenation unambiguous. */
export function deriveProjectId(repositoryId: string, trustchainRootId: string): string {
  return sha256(Buffer.concat([utf8.encode(repositoryId), Buffer.from([0]), utf8.encode(trustchainRootId)])).toString("hex");
}
