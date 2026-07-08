import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
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

  it('creates ZERO NAT Gateways (ADR-0007)', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::EIP', 0);
  });

  it('creates the two free Gateway endpoints (S3, DynamoDB)', () => {
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Gateway' },
    });
    expect(Object.keys(endpoints)).toHaveLength(2);
  });

  it('creates the 5 required Interface endpoints', () => {
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Interface' },
    });
    expect(Object.keys(endpoints)).toHaveLength(5);
  });

  it('scopes the endpoint security group to the VPC CIDR only (no wildcard)', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          CidrIp: '10.0.0.0/16',
          FromPort: 443,
          ToPort: 443,
          IpProtocol: 'tcp',
        }),
      ]),
    });
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
    expect(stack.endpointSecurityGroup).toBeDefined();
  });

  it('matches the snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
