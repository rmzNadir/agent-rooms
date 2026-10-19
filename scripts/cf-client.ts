import type { CfCall } from "./http-text.ts";
import {
  bucketReady,
  cfError,
  deploymentRows,
  expiredKeys,
  field,
  httpOk,
  liveVersionId,
  objectKeys,
  RETENTION_DAYS,
  readPayload,
  textField,
} from "./snapshot-diff.ts";

export const accountPath = (account: string, rest: string) =>
  `/accounts/${encodeURIComponent(account)}${rest}`;

export const objectKeyPath = (account: string, bucket: string, key: string) => {
  const encoded = key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return accountPath(
    account,
    `/r2/buckets/${encodeURIComponent(bucket)}/objects/${encoded}`
  );
};

export const scriptPath = (account: string, script: string, leaf: string) =>
  accountPath(account, `/workers/scripts/${encodeURIComponent(script)}${leaf}`);

export const listQuery = (prefix: string, cursor: string) => {
  const query = new URLSearchParams({ per_page: "1000", prefix });
  if (cursor.length > 0) {
    query.set("cursor", cursor);
  }
  return query.toString();
};

const failed = (label: string, status: number): never => {
  throw new Error(`${label} failed ${status}`);
};

export const ensureBucket = async (
  call: CfCall,
  account: string,
  bucket: string
) => {
  const reply = await call(
    "POST",
    accountPath(account, "/r2/buckets"),
    JSON.stringify({ name: bucket }),
    "application/json"
  );
  const payload = readPayload(reply.text);
  if (!bucketReady(reply.status, payload)) {
    throw new Error(cfError(payload));
  }
};

export const putObject = async (
  call: CfCall,
  account: string,
  bucket: string,
  key: string,
  body: string
) => {
  const reply = await call(
    "PUT",
    objectKeyPath(account, bucket, key),
    body,
    "application/json"
  );
  if (!httpOk(reply.status)) {
    failed("r2 put", reply.status);
  }
};

const nextCursor = (payload: ReturnType<typeof readPayload>) =>
  textField(field(payload, "result_info"), "cursor") ?? "";

const listPage = async (
  call: CfCall,
  path: string,
  prefix: string,
  cursor: string,
  page: number,
  keys: readonly string[]
): Promise<readonly string[]> => {
  if (page >= 50) {
    throw new Error("r2 list exceeded page cap");
  }
  const reply = await call("GET", `${path}?${listQuery(prefix, cursor)}`);
  const payload = readPayload(reply.text);
  if (!httpOk(reply.status) || field(payload, "success") === false) {
    failed("r2 list", reply.status);
  }
  const found = objectKeys(payload);
  const collected = [...keys, ...found];
  const next = nextCursor(payload);
  if (next.length === 0 || found.length === 0) {
    return collected;
  }
  return listPage(call, path, prefix, next, page + 1, collected);
};

export const listKeys = async (
  call: CfCall,
  account: string,
  bucket: string,
  prefix: string
) =>
  listPage(
    call,
    accountPath(account, `/r2/buckets/${encodeURIComponent(bucket)}/objects`),
    prefix,
    "",
    0,
    []
  );

export const deleteObject = async (
  call: CfCall,
  account: string,
  bucket: string,
  key: string
) => {
  const reply = await call("DELETE", objectKeyPath(account, bucket, key));
  if (!httpOk(reply.status)) {
    failed("r2 delete", reply.status);
  }
};

export const retainPrefix = async (
  call: CfCall,
  account: string,
  bucket: string,
  prefix: string,
  now: number
) => {
  const keys = await listKeys(call, account, bucket, prefix);
  const expired = expiredKeys(keys, now, RETENTION_DAYS);
  await Promise.all(
    expired.map((key) => deleteObject(call, account, bucket, key))
  );
  return expired.length;
};

export const deploymentList = async (
  call: CfCall,
  account: string,
  script: string
) => {
  const reply = await call("GET", scriptPath(account, script, "/deployments"));
  if (reply.status === 404) {
    return [];
  }
  const payload = readPayload(reply.text);
  if (!httpOk(reply.status) || field(payload, "success") === false) {
    failed("deployments", reply.status);
  }
  return deploymentRows(payload);
};

export const rollBack = async (
  call: CfCall,
  account: string,
  script: string,
  versionId: string
) => {
  const reply = await call(
    "POST",
    `${scriptPath(account, script, "/deployments")}?force=true`,
    JSON.stringify({
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: versionId }],
    }),
    "application/json"
  );
  if (!httpOk(reply.status)) {
    failed("rollback", reply.status);
  }
};

export const pinnedVersion = async (
  call: CfCall,
  account: string,
  script: string
) => {
  const rows = await deploymentList(call, account, script);
  if (rows.length === 0) {
    return;
  }
  const version = liveVersionId(rows);
  if (version === undefined) {
    throw new Error("live deployment has no 100 percent version");
  }
  return version;
};

export const subdomainOf = (payload: ReturnType<typeof readPayload>) =>
  textField(field(payload, "result"), "subdomain");

export const enableSubdomain = async (
  call: CfCall,
  account: string,
  script: string
) => {
  const reply = await call(
    "POST",
    scriptPath(account, script, "/subdomain"),
    JSON.stringify({ enabled: true }),
    "application/json"
  );
  if (!httpOk(reply.status)) {
    failed("receiver subdomain", reply.status);
  }
};

export const accountSubdomain = async (
  call: CfCall,
  account: string
): Promise<string> => {
  const reply = await call("GET", accountPath(account, "/workers/subdomain"));
  const name = subdomainOf(readPayload(reply.text));
  if (httpOk(reply.status) && name !== undefined && name.length > 0) {
    return name;
  }
  return failed("workers subdomain", reply.status);
};

export const deleteScript = async (
  call: CfCall,
  account: string,
  script: string
) => {
  const reply = await call(
    "DELETE",
    `${scriptPath(account, script, "")}?force=true`
  );
  if (reply.status === 404 || httpOk(reply.status)) {
    return;
  }
  failed("receiver delete", reply.status);
};
