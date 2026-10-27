import type { CfCall } from "./http-text.ts";
import type { Json } from "./snapshot-diff.ts";
import { field, httpOk, readPayload, textField } from "./snapshot-diff.ts";

export const zoneCandidates = (hostname: string) => {
  const parts = hostname.split(".");
  return parts.slice(0, -1).map((_, index) => parts.slice(index).join("."));
};

export const zoneFailure = (hostname: string) =>
  `Cloudflare zone not found for ${hostname}. The zone must already be on this account. The token needs Zone Read and DNS Write on that zone.`;

const zoneListed = (payload: Json, name: string, accountId: string) => {
  const result = field(payload, "result");
  if (!Array.isArray(result)) {
    return false;
  }
  return result.some((item) => {
    const account = field(item, "account");
    return (
      textField(item, "name") === name && textField(account, "id") === accountId
    );
  });
};

const probe = async (
  call: CfCall,
  accountId: string,
  hostname: string,
  name: string
) => {
  const query = new URLSearchParams({
    "account.id": accountId,
    name,
    per_page: "1",
  });
  const reply = await call("GET", `/zones?${query.toString()}`);
  if (reply.status === 401 || reply.status === 403) {
    throw new Error(`Zone Read is missing for ${hostname}`);
  }
  if (!httpOk(reply.status)) {
    throw new Error(`zone lookup failed ${reply.status}`);
  }
  return zoneListed(readPayload(reply.text), name, accountId);
};

export const findZoneName = async (
  call: CfCall,
  accountId: string,
  hostname: string
) => {
  const names = zoneCandidates(hostname);
  const hits = await Promise.all(
    names.map((name) => probe(call, accountId, hostname, name))
  );
  return names.find((_name, index) => hits[index] === true);
};
