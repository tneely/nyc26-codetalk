import { DSQLClient, GetStreamCommand } from "@aws-sdk/client-dsql";

interface Event {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  ResourceProperties: { clusterIdentifier: string };
}

const client = new DSQLClient({});

export async function handler(event: Event) {
  const { clusterIdentifier } = event.ResourceProperties;
  const streamIdentifier = event.PhysicalResourceId!;

  if (event.RequestType === "Create") {
    const res = await client.send(
      new GetStreamCommand({ clusterIdentifier, streamIdentifier }),
    );
    if (res.status === "ACTIVE") {
      return { IsComplete: true, Data: { StreamIdentifier: streamIdentifier, Arn: res.arn } };
    }
    if (res.status === "FAILED" || res.status === "IMPAIRED") {
      throw new Error(`DSQL stream ${streamIdentifier} entered status ${res.status}`);
    }
    return { IsComplete: false };
  }

  if (event.RequestType === "Delete") {
    try {
      const res = await client.send(
        new GetStreamCommand({ clusterIdentifier, streamIdentifier }),
      );
      return { IsComplete: res.status === "DELETED" };
    } catch (e: unknown) {
      // ResourceNotFound means it's gone.
      if (e instanceof Error && e.name === "ResourceNotFoundException") {
        return { IsComplete: true };
      }
      throw e;
    }
  }

  return { IsComplete: true };
}
