import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Properties for the {@link VpcStack}.
 */
export interface VpcStackProps extends StackProps {
  /**
   * IPv4 CIDR block for the VPC. Must be large enough to allocate one IP
   * per Pod under the AWS VPC CNI plugin used by EKS.
   *
   * @default '10.0.0.0/16'  (65,536 addresses)
   */
  readonly cidr?: string;

  /**
   * How many Availability Zones the VPC spans. EKS strongly recommends 3.
   *
   * @default 3
   */
  readonly maxAzs?: number;

  /**
   * Retention on the VPC Flow Log group.
   *
   * @default logs.RetentionDays.ONE_MONTH
   */
  readonly flowLogRetention?: logs.RetentionDays;
}

/**
 * The network foundation for the IDP platform.
 *
 * Design (see docs/adr/0007-vpc-endpoints-instead-of-nat-gateway.md):
 * - 3 AZs, one public and one private-isolated subnet per AZ.
 * - No NAT Gateway. All egress to AWS services goes through Gateway
 *   endpoints (S3, DynamoDB — free) or Interface endpoints (ECR api,
 *   ECR dkr, CloudWatch Logs, STS, KMS — priced per AZ-hour).
 * - Endpoint security group only accepts 443/tcp from the VPC CIDR —
 *   no wildcard sources.
 * - VPC Flow Logs stream to a customer-owned CloudWatch log group with
 *   one-month retention.
 *
 * Downstream stacks (Cluster, DNS, IAM) import this VPC as a shared
 * dependency; use `vpcId` and `availabilityZones` from the stack output.
 */
export class VpcStack extends Stack {
  /** The VPC created by this stack. */
  public readonly vpc: ec2.Vpc;

  /** The security group attached to every Interface endpoint. */
  public readonly endpointSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: VpcStackProps = {}) {
    super(scope, id, props);

    const cidr = props.cidr ?? '10.0.0.0/16';
    const maxAzs = props.maxAzs ?? 3;
    const flowLogRetention = props.flowLogRetention ?? logs.RetentionDays.ONE_MONTH;

    // -----------------------------------------------------------------
    // VPC — public + private-isolated subnets in each AZ, no NAT.
    // -----------------------------------------------------------------
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(cidr),
      maxAzs,
      natGateways: 0,                              // ADR-0007
      restrictDefaultSecurityGroup: true,           // deny-by-default on the default SG
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,                             // /24 — 256 IPs, plenty for ALBs
          mapPublicIpOnLaunch: false,               // no automatic public IPs; opt-in per resource
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 20,                             // /20 — ~4k IPs, headroom for Pods
        },
      ],
    });

    // -----------------------------------------------------------------
    // Security group for Interface endpoints.
    // Rule: 443/tcp from the VPC CIDR only. No wildcard.
    // -----------------------------------------------------------------
    this.endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'Ingress to VPC Interface endpoints from workloads in this VPC only',
      allowAllOutbound: false,
    });
    // Use the literal `cidr` string (not `this.vpc.vpcCidrBlock`, which
    // resolves to an Fn::GetAtt token). cdk-nag's AwsSolutions-EC23 rule
    // needs a literal at synth time to prove there is no wildcard.
    this.endpointSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(cidr),
      ec2.Port.tcp(443),
      'HTTPS from workloads in the VPC',
    );

    // -----------------------------------------------------------------
    // Gateway endpoints — free. Route table entries; no ENIs, no cost.
    // -----------------------------------------------------------------
    this.vpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addGatewayEndpoint('DynamoDbGatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // -----------------------------------------------------------------
    // Interface endpoints — one ENI per AZ per endpoint.
    // Minimum required for Fargate + EKS + IRSA + CloudWatch:
    //   - ecr.api  : image manifest / auth flow
    //   - ecr.dkr  : image layer downloads (rides on the S3 Gateway endpoint)
    //   - logs     : Fargate log shipping
    //   - sts      : IRSA token vending
    //   - kms      : EKS secrets envelope encryption, ECR image layer decryption
    // -----------------------------------------------------------------
    const interfaceServices: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      EcrApiEndpoint: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDkrEndpoint: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      LogsEndpoint: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      StsEndpoint: ec2.InterfaceVpcEndpointAwsService.STS,
      KmsEndpoint: ec2.InterfaceVpcEndpointAwsService.KMS,
    };

    for (const [id, service] of Object.entries(interfaceServices)) {
      this.vpc.addInterfaceEndpoint(id, {
        service,
        privateDnsEnabled: true,
        securityGroups: [this.endpointSecurityGroup],
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        // `open: false` prevents CDK from auto-adding a duplicate ingress
        // rule that references `vpc.vpcCidrBlock` as a CloudFormation token
        // (Fn::GetAtt). The single ingress rule we added on the SG above
        // uses a literal CIDR, which cdk-nag AwsSolutions-EC23 can inspect.
        open: false,
      });
    }

    // -----------------------------------------------------------------
    // VPC Flow Logs → customer-owned CloudWatch log group.
    // Required for cdk-nag AwsSolutions-VPC7 and generally good practice.
    // Retention short by default to keep costs down.
    // -----------------------------------------------------------------
    const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      logGroupName: `/aws/vpc/flow-logs/${this.stackName}`,
      retention: flowLogRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const flowLogRole = new iam.Role(this, 'FlowLogRole', {
      assumedBy: new iam.ServicePrincipal('vpc-flow-logs.amazonaws.com'),
      description: 'Delivers VPC Flow Logs to CloudWatch Logs',
    });
    flowLogGroup.grantWrite(flowLogRole);
    // The service also needs DescribeLogStreams on the group; grantWrite covers it.

    new ec2.FlowLog(this, 'FlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup, flowLogRole),
      trafficType: ec2.FlowLogTrafficType.ALL,
      maxAggregationInterval: ec2.FlowLogMaxAggregationInterval.ONE_MINUTE,
    });
  }
}
