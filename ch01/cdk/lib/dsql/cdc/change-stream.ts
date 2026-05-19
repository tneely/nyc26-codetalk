import { CustomResource, Duration, Stack } from "aws-cdk-lib";
import {
  IRole,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { IStream } from "aws-cdk-lib/aws-kinesis";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Provider } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import * as path from "path";
import { IDsqlCluster } from "../cluster";

export type StreamOrdering = "UNORDERED";
export type StreamFormat = "JSON";

export interface ChangeStreamProps {
  /** The DSQL cluster to stream changes from. */
  readonly cluster: IDsqlCluster;
  /** The Kinesis stream that receives CDC events. */
  readonly targetStream: IStream;
  /**
   * IAM role assumed by DSQL to publish to Kinesis. If not provided, one is
   * created with a trust policy for the DSQL service principal and write
   * permissions on the target stream.
   */
  readonly role?: IRole;
  /** @default UNORDERED */
  readonly ordering?: StreamOrdering;
  /** @default JSON */
  readonly format?: StreamFormat;
}

export class ChangeStream extends Construct {
  /** The DSQL stream identifier. */
  public readonly streamIdentifier: string;

  /** The ARN of the DSQL change stream. */
  public readonly arn: string;

  /** The IAM role DSQL assumes to publish CDC events. */
  public readonly role: IRole;

  constructor(scope: Construct, id: string, props: ChangeStreamProps) {
    super(scope, id);

    const stack = Stack.of(this);
    this.role =
      props.role ?? this.createPublishRole(props.targetStream, stack.account);

    const provider = ChangeStream.ensureProvider(this);

    const resource = new CustomResource(this, "Resource", {
      serviceToken: provider.serviceToken,
      resourceType: "Custom::DsqlChangeStream",
      properties: {
        clusterIdentifier: props.cluster.id,
        kinesisStreamArn: props.targetStream.streamArn,
        roleArn: this.role.roleArn,
        ordering: props.ordering ?? "UNORDERED",
        format: props.format ?? "JSON",
      },
    });
    resource.node.addDependency(this.role);

    this.streamIdentifier = resource.getAttString("StreamIdentifier");
    this.arn = resource.getAttString("Arn");
  }

  private createPublishRole(stream: IStream, account: string): Role {
    const role = new Role(this, "PublishRole", {
      assumedBy: new ServicePrincipal("dsql.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": account },
          ArnEquals: { "aws:SourceArn": `arn:aws:dsql:*:${account}:cluster/*` },
        },
      }),
    });

    role.addToPolicy(
      new PolicyStatement({
        actions: [
          "kinesis:PutRecord",
          "kinesis:PutRecords",
          "kinesis:DescribeStreamSummary",
          "kinesis:ListShards",
        ],
        resources: [stream.streamArn],
      }),
    );

    if (stream.encryptionKey) {
      role.addToPolicy(
        new PolicyStatement({
          actions: ["kms:GenerateDataKey"],
          resources: [stream.encryptionKey.keyArn],
          conditions: {
            StringEquals: {
              "kms:ViaService": `kinesis.${Stack.of(this).region}.amazonaws.com`,
            },
          },
        }),
      );
    }

    return role;
  }

  private static ensureProvider(scope: Construct): Provider {
    const stack = Stack.of(scope);
    const existing = stack.node.tryFindChild(
      "DsqlChangeStreamProvider",
    ) as Provider | undefined;
    if (existing) return existing;

    // Bundle @aws-sdk/client-dsql (not yet shipped in the Lambda Node runtime)
    // by leaving externalModules unset so esbuild includes it in the artifact.
    const onEvent = new NodejsFunction(stack, "DsqlChangeStreamOnEvent", {
      entry: path.join(__dirname, "change-stream.on-event.ts"),
      runtime: Runtime.NODEJS_LATEST,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(2),
      bundling: { externalModules: [] },
    });
    const isComplete = new NodejsFunction(
      stack,
      "DsqlChangeStreamIsComplete",
      {
        entry: path.join(__dirname, "change-stream.is-complete.ts"),
        runtime: Runtime.NODEJS_LATEST,
        architecture: Architecture.ARM_64,
        timeout: Duration.minutes(2),
        bundling: { externalModules: [] },
      },
    );

    for (const fn of [onEvent, isComplete]) {
      fn.addToRolePolicy(
        new PolicyStatement({
          actions: [
            "dsql:CreateStream",
            "dsql:DeleteStream",
            "dsql:GetStream",
          ],
          resources: ["*"],
        }),
      );
      fn.addToRolePolicy(
        new PolicyStatement({
          actions: ["iam:PassRole"],
          resources: ["*"],
          conditions: {
            StringEquals: { "iam:PassedToService": "dsql.amazonaws.com" },
          },
        }),
      );
    }

    return new Provider(stack, "DsqlChangeStreamProvider", {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
      queryInterval: Duration.seconds(15),
      totalTimeout: Duration.minutes(15),
    });
  }
}
