import {
  DSQLClient,
  CreateStreamCommand,
  DeleteStreamCommand,
} from "@aws-sdk/client-dsql";

interface ResourceProperties {
  clusterIdentifier: string;
  kinesisStreamArn: string;
  roleArn: string;
  ordering: "UNORDERED";
  format: "JSON";
}

interface Event {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  ResourceProperties: ResourceProperties;
}

const client = new DSQLClient({});

export async function handler(event: Event) {
  const props = event.ResourceProperties;

  if (event.RequestType === "Create") {
    const res = await client.send(
      new CreateStreamCommand({
        clusterIdentifier: props.clusterIdentifier,
        targetDefinition: {
          kinesis: { streamArn: props.kinesisStreamArn, roleArn: props.roleArn },
        },
        ordering: props.ordering,
        format: props.format,
      }),
    );
    return {
      PhysicalResourceId: res.streamIdentifier,
      Data: { StreamIdentifier: res.streamIdentifier, Arn: res.arn },
    };
  }

  if (event.RequestType === "Update") {
    // CDC streams aren't updatable in place; CFN will issue a Create for the
    // new physical ID followed by a Delete for the old one.
    throw new Error("DSQL change streams cannot be updated in place");
  }

  // Delete
  if (event.PhysicalResourceId && !event.PhysicalResourceId.startsWith("failed-")) {
    await client.send(
      new DeleteStreamCommand({
        clusterIdentifier: props.clusterIdentifier,
        streamIdentifier: event.PhysicalResourceId,
      }),
    );
  }
  return { PhysicalResourceId: event.PhysicalResourceId };
}
