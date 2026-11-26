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
 * Design (see docs/adr/0035-nat-gateway-for-eks-sessions.md, which
 * replaces ADR-0007's "no NAT" decision):
 * - 3 AZs, one public and one private subnet per AZ.
 * - ONE NAT Gateway, in one public subnet. Every private subnet routes
 *   internet-bound traffic through it. The platform needs the internet:
 *   ArgoCD pulls from GitHub, images come from ghcr.io and cgr.dev,
 *   cert-manager talks to Let's Encrypt. Endpoints cannot provide that.
 * - One, not one per AZ: an AZ outage would cut egress for all three
 *   AZs, which a three-hour session accepts and production would not.
 * - Gateway endpoints for S3 and DynamoDB stay. They are free, and image
 *   layers from ECR travel through S3, so that traffic skips the NAT's
 *   per-gigabyte charge.
 * - No Interface endpoints. With a NAT they would be a second, paid
 *   route to the same AWS services (~$0.30/h for the nine we had).
 * - VPC Flow Logs stream to a customer-owned CloudWatch log group with
 *   one-month retention.
 *
 * Downstream stacks (Cluster, DNS, IAM) import this VPC as a shared
 * dependency; use `vpcId` and `availabilityZones` from the stack output.
 */
export class VpcStack extends Stack {
  /** The VPC created by this stack. */
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: VpcStackProps = {}) {
    super(scope, id, props);

    const cidr = props.cidr ?? '10.0.0.0/16';
    const maxAzs = props.maxAzs ?? 3;
    const flowLogRetention = props.flowLogRetention ?? logs.RetentionDays.ONE_MONTH;

    // -----------------------------------------------------------------
    // VPC — public + private subnets in each AZ, one shared NAT Gateway.
    // -----------------------------------------------------------------
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(cidr),
      maxAzs,
      natGateways: 1,                              // ADR-0035: one, shared by all AZs
      restrictDefaultSecurityGroup: true,           // deny-by-default on the default SG
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,                             // /24 — 256 IPs: load balancers + the NAT
          mapPublicIpOnLaunch: false,               // no automatic public IPs; opt-in per resource
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, // default route → the NAT
          cidrMask: 20,                             // /20 — ~4k IPs, headroom for Pods
        },
      ],
    });

    // -----------------------------------------------------------------
    // Gateway endpoints — free. Route table entries; no ENIs, no cost.
    // Kept alongside the NAT on purpose: S3 traffic (which includes ECR
    // image layers) takes this route and is not billed per GB by the NAT.
    //
    // No Interface endpoints: see the class comment and ADR-0035. If the
    // platform ever runs always-on, add them back for the busiest AWS
    // services and keep the NAT for everything else.
    // -----------------------------------------------------------------
    this.vpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addGatewayEndpoint('DynamoDbGatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

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
