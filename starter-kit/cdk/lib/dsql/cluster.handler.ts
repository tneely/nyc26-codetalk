import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { Client } from "pg";

interface ResourceProperties {
  endpoint: string;
  roleName: string;
  iamRoleArn: string;
}

interface Event {
  RequestType: "Create" | "Update" | "Delete";
  ResourceProperties: ResourceProperties;
  OldResourceProperties?: ResourceProperties;
}

async function connect(endpoint: string): Promise<Client> {
  const signer = new DsqlSigner({ hostname: endpoint });
  const token = await signer.getDbConnectAdminAuthToken();
  const client = new Client({
    host: endpoint,
    port: 5432,
    user: "admin",
    password: token,
    database: "postgres",
    ssl: true,
  });
  await client.connect();
  return client;
}

export async function handler(event: Event) {
  const { endpoint, roleName, iamRoleArn } = event.ResourceProperties;
  const resourceResponse = { PhysicalResourceId: `dsql-role-${roleName}` };

  if (event.RequestType === "Delete") {
    const client = await connect(endpoint);
    try {
      await client.query(`AWS IAM REVOKE ${roleName} FROM '${iamRoleArn}'`);
      await client.query(`DROP ROLE IF EXISTS ${roleName}`);
    } finally {
      await client.end();
    }
    return resourceResponse;
  }

  const client = await connect(endpoint);
  try {
    try {
      await client.query(`CREATE ROLE ${roleName} WITH LOGIN`);
    } catch (e: unknown) {
      if (e instanceof Error && !e.message.includes("already exists")) {
        throw e;
      }
    }

    // Associate IAM role
    await client.query(`AWS IAM GRANT ${roleName} TO '${iamRoleArn}'`);
  } finally {
    await client.end();
  }

  return resourceResponse;
}
