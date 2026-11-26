import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';

describe('VpcStack', () => {
  let template: Template;
  let stack: VpcStack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new VpcStack(app, 'TestVpcStack', {
      env: { account: '123456789012', region: 'eu-west-1' },
    });
    template = Template.fromStack(stack);
  });

  it('creates a single VPC with the default /16 CIDR', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });
  });

  it('provisions 3 AZs by default — 3 public + 3 private subnets', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 6);
  });

  it('creates exactly ONE NAT Gateway with one Elastic IP (ADR-0035)', () => {
    // One per AZ would triple the hourly cost for redundancy a
    // three-hour session does not need.
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::EIP', 1);
  });

  it('puts the NAT Gateway in a public subnet', () => {
    const publicSubnets = Object.entries(template.findResources('AWS::EC2::Subnet'))
      .filter(([, r]) => r.Properties.Tags.some(
        (t: { Key: string; Value: string }) => t.Key === 'aws-cdk:subnet-type' && t.Value === 'Public'))
      .map(([id]) => id);
    expect(publicSubnets).toHaveLength(3);
    const [nat] = Object.values(template.findResources('AWS::EC2::NatGateway'));
    expect(publicSubnets).toContain(nat.Properties.SubnetId.Ref);
  });

  it('gives every private subnet a default route to that one NAT Gateway', () => {
    const [natId] = Object.keys(template.findResources('AWS::EC2::NatGateway'));
    const routes = Object.values(template.findResources('AWS::EC2::Route'));
    const viaNat = routes.filter((r) => r.Properties.NatGatewayId !== undefined);
    expect(viaNat).toHaveLength(3);
    for (const r of viaNat) {
      expect(r.Properties.DestinationCidrBlock).toBe('0.0.0.0/0');
      expect(r.Properties.NatGatewayId.Ref).toBe(natId);
    }
  });

  it('never gives a private subnet a direct route to the internet gateway', () => {
    const tables = template.findResources('AWS::EC2::RouteTable');
    const isPrivate = (tableId: string) => tables[tableId].Properties.Tags.some(
      (t: { Key: string; Value: string }) => t.Key === 'aws-cdk:subnet-type' && t.Value === 'Private');
    const viaIgw = Object.values(template.findResources('AWS::EC2::Route'))
      .filter((r) => r.Properties.GatewayId !== undefined);
    expect(viaIgw).toHaveLength(3);
    for (const r of viaIgw) {
      expect(isPrivate(r.Properties.RouteTableId.Ref)).toBe(false);
    }
  });

  it('does not hand out public IPs to anything launched in a public subnet', () => {
    const subnets = Object.values(template.findResources('AWS::EC2::Subnet'));
    for (const s of subnets) {
      expect(s.Properties.MapPublicIpOnLaunch).toBe(false);
    }
  });

  it('keeps the two free Gateway endpoints (S3, DynamoDB) on the private route tables', () => {
    const endpoints = Object.values(template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Gateway' },
    }));
    expect(endpoints).toHaveLength(2);
    for (const e of endpoints) {
      expect(e.Properties.RouteTableIds.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('creates NO Interface endpoints: with a NAT they are a second, paid route (ADR-0035)', () => {
    const all = template.findResources('AWS::EC2::VPCEndpoint');
    const notGateway = Object.values(all).filter((e) => e.Properties.VpcEndpointType !== 'Gateway');
    expect(notGateway).toHaveLength(0);
    expect(Object.keys(all)).toHaveLength(2);
  });

  it('creates no security group of its own (the endpoint group went with the endpoints)', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
  });

  it('enables VPC Flow Logs to a customer-owned CloudWatch log group', () => {
    template.resourceCountIs('AWS::EC2::FlowLog', 1);
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      TrafficType: 'ALL',
      MaxAggregationInterval: 60,
    });
    template.resourceCountIs('AWS::Logs::LogGroup', 1);
  });

  it('exposes the VPC as a stack member for downstream stacks', () => {
    expect(stack.vpc).toBeDefined();
  });

  it('matches the snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
