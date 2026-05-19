import * as cdk from "aws-cdk-lib";
import * as kinesis from "aws-cdk-lib/aws-kinesis";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import * as path from "path";

import * as dsql from "./dsql";

export class Dat401Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create DSQL cluster
    const cluster = new dsql.Cluster(this, "DsqlCluster", {
      name: "DAT401",
      deleteProtection: false,
    });

    const lambdaFunction = new nodejs.NodejsFunction(
      this,
      "SummitDat401Function",
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: path.join(__dirname, "../../lambda/src/index.ts"),
        handler: "handler",
        functionName: "summit-dat401",
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        environment: {
          CLUSTER_ENDPOINT: cluster.endpoint,
        },
      },
    );

    // Output the cluster endpoint for easy access
    new cdk.CfnOutput(this, "ClusterEndpoint", {
      value: cluster.endpoint,
      description: "DSQL Cluster Endpoint",
    });

    // Output the Lambda execution role ARN
    new cdk.CfnOutput(this, "LambdaRoleArn", {
      value: lambdaFunction.role!.roleArn,
      description: "Lambda Execution Role ARN",
    });
  }
}
