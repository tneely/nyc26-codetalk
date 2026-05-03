import { CustomResource, Stack } from "aws-cdk-lib";
import { CfnCluster } from "aws-cdk-lib/aws-dsql";
import { Grant, IGrantable, IRole, PolicyDocument } from "aws-cdk-lib/aws-iam";
import { IKey } from "aws-cdk-lib/aws-kms";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Provider } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export interface IDsqlCluster {
  readonly endpoint: string;
  readonly arn: string;
  readonly id: string;
  grantConnect(grantee: IGrantable): Grant;
  grantConnectAdmin(grantee: IGrantable): Grant;
}

export interface ClusterAttributes {
  readonly endpoint: string;
  readonly arn: string;
  readonly id: string;
}

export interface ClusterProps {
  /**
   * Name to tag the cluster.
   */
  name?: string;
  /**
   * Whether deletion protection is enabled on this cluster.
   * @default true
   */
  deleteProtection?: boolean;
  /**
   * The KMS key that encrypts data on the cluster.
   * @default ServiceKey
   */
  key?: IKey;
  /**
   * A resource-based policy document to apply to the cluster.
   */
  resourceBasedPolicy?: PolicyDocument;
}

export interface DsqlRoleProps {
  /** The Postgres role name to create. */
  roleName: string;
  /** The IAM role ARN to associate with the Postgres role. */
  iamRole: IRole;
}

export class Cluster extends Construct implements IDsqlCluster {
  private readonly cfnCluster: CfnCluster;

  /**
   * The ARN of the cluster.
   */
  public readonly arn: string;

  /**
   * The endpoint for the cluster.
   */
  public readonly endpoint: string;

  /**
   * The identifier of the cluster.
   */
  public readonly id: string;

  constructor(scope: Construct, id: string, props: ClusterProps) {
    super(scope, id);

    this.cfnCluster = new CfnCluster(this, "Resource", {
      deletionProtectionEnabled: props.deleteProtection ?? true,
      kmsEncryptionKey: props.key?.keyArn,
      policyDocument: props.resourceBasedPolicy?.toJSON(),
      tags: props.name ? [{ key: "Name", value: props.name }] : undefined,
    });

    this.arn = this.cfnCluster.attrResourceArn;
    this.endpoint = this.cfnCluster.attrEndpoint;
    this.id = this.cfnCluster.attrIdentifier;
  }

  /**
   * Create a Postgres role on this cluster, associate it with an IAM role.
   */
  public addRole(props: DsqlRoleProps): void {
    const provider = this.ensureRoleProvider();

    new CustomResource(this, `${props.roleName}-Role`, {
      serviceToken: provider.serviceToken,
      properties: {
        endpoint: this.endpoint,
        roleName: props.roleName,
        iamRoleArn: props.iamRole.roleArn,
      },
    });
  }

  /**
   * Grant the given identity DbConnect permissions to this cluster.
   * @param grantee The principal to grant access to
   */
  public grantConnect(grantee: IGrantable): Grant {
    return Grant.addToPrincipal({
      grantee,
      actions: ["dsql:DbConnect"],
      resourceArns: [this.arn],
    });
  }

  /**
   * Grant the given identity DbConnectAdmin permissions to this cluster.
   * @param grantee The principal to grant access to
   */
  public grantConnectAdmin(grantee: IGrantable): Grant {
    return Grant.addToPrincipal({
      grantee,
      actions: ["dsql:DbConnectAdmin"],
      resourceArns: [this.arn],
    });
  }

  private ensureRoleProvider(): Provider {
    const stack = Stack.of(this);
    const existingProvider = stack.node.tryFindChild("DsqlRoleProvider") as Provider | undefined;
    if (existingProvider) {
      return existingProvider;
    }

    const handler = new NodejsFunction(stack, "handler", {
      runtime: Runtime.NODEJS_LATEST,
      architecture: Architecture.ARM_64,
      bundling: {
        externalModules: ["@aws-sdk/client-*"],
      },
    });
    this.grantConnectAdmin(handler);

    return new Provider(stack, "DsqlRoleProvider", {
      onEventHandler: handler,
    });
  }
}
