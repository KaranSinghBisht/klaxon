import { type OperatorKey, signOperatorRequest } from "@klaxon/core";
import { z } from "zod";
import { CliError } from "./errors.js";

/**
 * `GET /.well-known/klaxon.json` (PROTOCOL §4). Only the fields the operator's laptop actually
 * consumes are required — the manifest grows for `verify` and the runner, and a strict schema
 * here would make `init` fail on additions that do not concern it.
 */
export const ManifestSchema = z.object({
  klaxon: z.literal(1),
  submit_key: z.string().min(1),
  hedera_account: z.string().min(1),
  release_endpoint: z.string().min(1).optional(),
  facilitator: z.string().min(1).optional(),
  price: z.object({ amount: z.string(), asset: z.string(), network: z.string() }).optional(),
});
export type WitnessManifest = z.infer<typeof ManifestSchema>;

export const SharesResponseSchema = z.object({
  ok: z.literal(true),
  b: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  b_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SharesResponse = z.infer<typeof SharesResponseSchema>;

/** `epoch` arrives as a JSON number or a string depending on the witness's serializer. */
export const RevokeResponseSchema = z.object({
  ok: z.literal(true),
  epoch: z.union([z.number().int().nonnegative(), z.string().regex(/^[0-9]+$/)]),
});

export interface RegisterProjectBody {
  project_id: string;
  repository_id: string;
  repository: string;
  member_pubkey: string;
  operator_pubkey: string;
  pay_account?: string;
  topic_id: string;
  ntfy_topic: string;
}

export interface WitnessClientOptions {
  baseUrl: string;
  operator: OperatorKey;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * The operator half of the witness API. Every mutating route is signed with the operator key,
 * which `klaxon init` generates and which never leaves the laptop. It is NOT the LKRP member key:
 * that credential is a required input of `klaxon/get`, so signing this surface with it would put
 * the ability to ask for share B inside every protected job (PROTOCOL §2).
 */
export class WitnessClient {
  private readonly baseUrl: string;
  private readonly operator: OperatorKey;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(o: WitnessClientOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.operator = o.operator;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? (() => new Date());
  }

  async manifest(): Promise<WitnessManifest> {
    const url = `${this.baseUrl}/.well-known/klaxon.json`;
    const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new CliError("WITNESS_FAILED", `witness manifest returned ${res.status}`, {
        detail: url,
      });
    }
    const parsed = ManifestSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new CliError(
        "WITNESS_MALFORMED",
        `witness manifest failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      );
    }
    return parsed.data;
  }

  registerProject(body: RegisterProjectBody): Promise<unknown> {
    return this.postSigned("/projects", body, z.object({ ok: z.literal(true) }));
  }

  shares(project_id: string, secret: string, gen: string): Promise<SharesResponse> {
    return this.postSigned("/shares", { project_id, secret, gen }, SharesResponseSchema);
  }

  rotate(project_id: string, secret: string, gen: string): Promise<SharesResponse> {
    return this.postSigned("/rotate", { project_id, secret, gen }, SharesResponseSchema);
  }

  async revoke(project_id: string, reason: string): Promise<{ epoch: number }> {
    const res = await this.postSigned("/revoke", { project_id, reason }, RevokeResponseSchema);
    return { epoch: Number(res.epoch) };
  }

  /**
   * The signature covers the exact bytes on the wire, so the body is serialised once and that
   * same buffer is both hashed and sent. `path` is the URL pathname the witness will see.
   */
  private async postSigned<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    const bytes = Buffer.from(JSON.stringify(body), "utf8");
    const headers = signOperatorRequest(
      this.operator.privatekey,
      this.operator.pubkey,
      "POST",
      url.pathname,
      bytes,
      this.now(),
    );
    const res = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json" },
      body: bytes,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new CliError("WITNESS_MALFORMED", `POST ${path} returned non-JSON`, {
        cause,
        detail: `status ${res.status}`,
      });
    }
    if (!res.ok) {
      const reason =
        json &&
        typeof json === "object" &&
        typeof (json as { reason?: unknown }).reason === "string"
          ? (json as { reason: string }).reason
          : `status ${res.status}`;
      throw new CliError("WITNESS_FAILED", `POST ${path} refused: ${reason}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new CliError(
        "WITNESS_MALFORMED",
        `POST ${path} response failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      );
    }
    return parsed.data;
  }
}
